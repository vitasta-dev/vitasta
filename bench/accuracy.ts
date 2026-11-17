/**
 * Accuracy benchmark on real public repos. Read-only: repos are shallow-cloned and scanned, never built or run.
 *
 *   npx tsx bench/accuracy.ts <repos.txt> --feed ../feed/data --out <dir> [--today YYYY-MM-DD] [--sample 60]
 *
 * Recall (model IDs): an independent baseline searches every code/config/notebook file for the exact text of each
 * retired or retiring model ID in the feed. A baseline hit counts as found if the scanner reported that model at
 * that file and line.
 * Precision: writes a random sample of findings with code context to sample.jsonl for a reviewer to judge.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findImpacts, loadFeed } from "../src/feed/match.js";
import { normalizeModel } from "../src/providers.js";
import { scanConfigAndNotebooks } from "../src/scan/config.js";
import { listSourceFiles } from "../src/scan/files.js";
import { scanRepo } from "../src/scan/index.js";
import type { Finding } from "../src/types.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const reposFile = process.argv[2];
const feedDir = arg("--feed")!;
const outDir = arg("--out")!;
const today = arg("--today") ?? new Date().toLocaleDateString("en-CA");
const sampleSize = Number(arg("--sample") ?? 60);
const CACHE = join(homedir(), ".cache", "vitasta", "repos");

// Deterministic shuffle so the sample is reproducible
function seeded(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await mkdir(CACHE, { recursive: true });
  const repos = (await readFile(reposFile, "utf8")).split("\n").map((s) => s.trim()).filter(Boolean);
  const feed = await loadFeed(feedDir);
  // Exact model IDs the feed says are retired or retiring (wildcards left out of the baseline)
  const retiredIds = new Set(feed.flatMap((c) => (c.type === "model_retirement" ? c.selector.models ?? [] : [])).filter((m) => !m.endsWith("*")));

  const all: { repo: string; f: Finding }[] = [];
  const truth: { repo: string; file: string; line: number; model: string; found: boolean }[] = [];
  const perRepo: Record<string, unknown>[] = [];

  for (const repo of repos) {
    const dir = join(CACHE, repo.replace("/", "__"));
    try {
      if (!existsSync(dir)) execFileSync("git", ["clone", "--depth", "1", "--quiet", "--no-recurse-submodules", `https://github.com/${repo}`, dir], { stdio: "pipe", timeout: 180_000 });
    } catch (e) {
      perRepo.push({ repo, error: `clone failed: ${(e as Error).message.slice(0, 120)}` });
      continue;
    }
    const t0 = Date.now();
    const map = await scanRepo(dir);
    const ms = Date.now() - t0;
    const findings = findImpacts(map, feed, today);
    for (const f of findings) all.push({ repo, f });

    // Independent baseline: exact retired model IDs anywhere in the files the scanner is meant to cover
    const files = [...(await listSourceFiles(dir)).map((f) => f.rel), ...new Set((await scanConfigAndNotebooks(dir)).map((u) => u.file))];
    // A usage counts on its own line and on the line where its model string is written (multi-line calls)
    const reported = new Set<string>();
    for (const u of map.usages.filter((x) => x.model)) {
      const m = normalizeModel(u.model!);
      reported.add(`${u.file}:${u.line}:${m}`);
      if (u.modelSpan) {
        const text = await readFile(join(dir, u.file), "utf8").catch(() => "");
        reported.add(`${u.file}:${text.slice(0, u.modelSpan.start).split("\n").length}:${m}`);
      }
    }
    const reportedLoose = new Set(map.usages.filter((u) => u.model).map((u) => `${u.file}:${normalizeModel(u.model!)}`));
    for (const rel of new Set(files)) {
      const text = await readFile(join(dir, rel), "utf8").catch(() => "");
      if (!text) continue;
      const lines = text.split("\n");
      const isConfig = !/\.(m|c)?[jt]sx?$|\.py$|\.java$|\.ipynb$/.test(rel);
      lines.forEach((line, i) => {
        // Baseline = model IDs written as a value: the whole content of a quoted string in code,
        // or a key's value in config files. Mentions inside sentences or comments aren't API usage.
        const values = isConfig
          ? [...line.matchAll(/(?:[:=]\s*)["']?([A-Za-z0-9][\w.:@\/-]*[\w])["']?\s*,?\s*$/g)].map((m) => m[1])
          : [...line.matchAll(/(["'`])([A-Za-z0-9][\w.:@\/-]*[\w])\1/g)].map((m) => m[2]);
        for (const v of values) {
          const tok = normalizeModel(v);
          if (!retiredIds.has(tok)) continue;
          // Bare words like "ada" or "davinci" are too ambiguous to count without context
          if (!/[\d-]/.test(tok)) continue;
          // notebooks report the line inside the JSON file, so match notebooks by file + model
          const found = rel.endsWith(".ipynb") ? reportedLoose.has(`${rel}:${tok}`) : reported.has(`${rel}:${i + 1}:${tok}`);
          truth.push({ repo, file: rel, line: i + 1, model: tok, found });
        }
      });
    }
    const providers = [...new Set(map.usages.map((u) => u.provider))].sort();
    perRepo.push({ repo, files: map.filesScanned, usages: map.usages.length, findings: findings.length, providers, ms });
    console.log(`${repo}: ${map.filesScanned} files, ${map.usages.length} usages, ${findings.length} findings, ${ms} ms [${providers.join(",")}]`);
  }

  // Precision sample, with code context for the reviewer
  const rand = seeded(Number(arg("--seed") ?? 20261113));
  const shuffled = [...all].sort(() => rand() - 0.5).slice(0, sampleSize);
  const sample: string[] = [];
  for (const { repo, f } of shuffled) {
    const dir = join(CACHE, repo.replace("/", "__"));
    const lines = (await readFile(join(dir, f.usage.file), "utf8").catch(() => "")).split("\n");
    const from = Math.max(0, f.usage.line - 9);
    const context = lines.slice(from, f.usage.line + 8).map((l, i) => `${from + i + 1}${from + i + 1 === f.usage.line ? ">" : " "} ${l}`).join("\n");
    sample.push(JSON.stringify({
      repo, file: f.usage.file, line: f.usage.line, kind: f.usage.kind, provider: f.usage.provider, confidence: f.usage.confidence,
      model: f.usage.model, op: f.usage.op, apiVersion: f.usage.apiVersion, host: f.usage.host, inTest: !!f.usage.inTest,
      claim: f.change.title, status: f.status, context,
    }));
  }
  await writeFile(join(outDir, "sample.jsonl"), sample.join("\n") + "\n");

  // Recall sample: random baseline hits for a reviewer to label real/not. The reviewer's file doesn't say whether
  // the scanner found them; that's kept separately so the labels stay independent.
  const rand2 = seeded(Number(arg("--seed") ?? 42) + 1);
  const recallPick = [...truth].sort(() => rand2() - 0.5).slice(0, sampleSize);
  const forReviewer: string[] = [];
  for (const [i, t] of recallPick.entries()) {
    const dir = join(CACHE, t.repo.replace("/", "__"));
    const lines = (await readFile(join(dir, t.file), "utf8").catch(() => "")).split("\n");
    const from = Math.max(0, t.line - 9);
    const context = lines.slice(from, t.line + 8).map((l, j) => `${from + j + 1}${from + j + 1 === t.line ? ">" : " "} ${l}`).join("\n");
    forReviewer.push(JSON.stringify({ n: i + 1, repo: t.repo, file: t.file, line: t.line, model: t.model, context }));
  }
  await writeFile(join(outDir, "recall-sample.jsonl"), forReviewer.join("\n") + "\n");
  await writeFile(join(outDir, "recall-sample-answers.json"), JSON.stringify(recallPick.map((t, i) => ({ n: i + 1, found: t.found }))));

  const found = truth.filter((t) => t.found).length;
  const summary = {
    today,
    repos: repos.length,
    scanned: perRepo.filter((r) => !("error" in r)).length,
    findings: all.length,
    byStatus: Object.fromEntries(["broken", "urgent", "upcoming", "on-upgrade"].map((s) => [s, all.filter((x) => x.f.status === s).length])),
    byProvider: Object.fromEntries([...new Set(all.map((x) => x.f.usage.provider))].map((p) => [p, all.filter((x) => x.f.usage.provider === p).length])),
    recall: { baseline: truth.length, found, rate: truth.length ? +(found / truth.length).toFixed(3) : null },
    misses: truth.filter((t) => !t.found).slice(0, 80),
    perRepo,
  };
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nfindings ${all.length}; model-ID recall ${found}/${truth.length} = ${summary.recall.rate}; sample of ${sample.length} written`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
