/**
 * Accuracy gate: re-scan the corpus with the current scanner and check it against every human label.
 *
 *   npx tsx bench/gate.ts            fail (exit 1) if any rule got less accurate than the saved baseline
 *   npx tsx bench/gate.ts --update   save the current state as the new baseline (after a reviewed improvement)
 *   npx tsx bench/gate.ts --strict   also fail when a rule's number of reported places shifts with no labels
 *
 * A rule is provider/kind/language (e.g. openai/model-ref/ts). It fails when:
 *  - a place labelled "not a real use" is now reported (new false positive), or
 *  - a place labelled "real" that was reported before no longer is (lost a true find).
 * The feed is frozen in bench/feed-snapshot so feed updates never move these numbers.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arg, scanCorpus } from "./corpus.js";
import { BENCH, loadLabels, QUEUE, readJsonl } from "./lib.js";
import type { QueueItem } from "./sample.js";

const BASELINE = join(BENCH, "accuracy-baseline.json");
const FEED = join(BENCH, "feed-snapshot");

interface Baseline {
  updated: string;
  /** For each labelled place: was it reported? */
  reported: Record<string, boolean>;
  usagesByRule: Record<string, number>;
}

const update = process.argv.includes("--update");
const strict = process.argv.includes("--strict");

const labels = await loadLabels();
const items = new Map<string, QueueItem>();
for (const f of (await readdir(QUEUE).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl"))) for (const it of await readJsonl<QueueItem>(join(QUEUE, f))) items.set(it.key, it);
const base: Baseline | undefined = JSON.parse(await readFile(BASELINE, "utf8").catch(() => "null")) ?? undefined;

const scans = await scanCorpus({ feedDir: arg("--feed", FEED)!, quiet: true });
const ruleOfKey = new Map<string, string>();
const usagesByRule: Record<string, number> = {};
// What fails a check, and what
// failed under the rule before roles (outside tests and lists), so one run shows both
const failsNow = new Set<string>();
const failedBefore = new Set<string>();
for (const s of scans) {
  for (const u of s.usages) {
    usagesByRule[u.rule] = (usagesByRule[u.rule] ?? 0) + 1;
    ruleOfKey.set(u.key, u.rule);
    if (u.altKey && !ruleOfKey.has(u.altKey)) ruleOfKey.set(u.altKey, u.rule);
    const keys = [u.key, ...(u.altKey ? [u.altKey] : [])];
    if ((u.role ?? (!u.inTest && !u.listed ? "breaks" : "")) === "breaks") for (const k of keys) failsNow.add(k);
    if (!u.inTest && !u.listed) for (const k of keys) failedBefore.add(k);
  }
}
const fail = { now: { tp: 0, fp: 0 }, before: { tp: 0, fp: 0 } };

type Row = { tp: number; fp: number; fn: number; recallReal: number; recallFound: number };
const per = new Map<string, Row>();
const row = (r: string) => per.get(r) ?? (per.set(r, { tp: 0, fp: 0, fn: 0, recallReal: 0, recallFound: 0 }), per.get(r)!);
const regressions: string[] = [];
const reportedNow: Record<string, boolean> = {};

// A repo that couldn't be cloned or scanned this time says nothing about the scanner: leave its labels out
const scanned = new Set(scans.map((s) => s.repo));
const skippedRepos = new Set<string>();
for (const [key, l] of labels) {
  if (l.label === "unsure") continue;
  const repo = key.split("|")[0];
  if (!scanned.has(repo)) {
    skippedRepos.add(repo);
    continue;
  }
  const reported = ruleOfKey.has(key);
  reportedNow[key] = reported;
  const item = items.get(key);
  const rule = ruleOfKey.get(key) ?? item?.rule ?? "unattributed";
  const r = row(rule);
  if (l.label === "real") {
    if (reported) r.tp++;
    else r.fn++;
    if (item?.kind === "recall") (r.recallReal++, reported && r.recallFound++);
  } else if (reported) r.fp++;
  for (const [set, t] of [[failsNow, fail.now], [failedBefore, fail.before]] as const) if (set.has(key)) l.label === "real" ? t.tp++ : t.fp++;
  const was = base?.reported[key];
  // Only a change counts: a known false positive the baseline already reported (or never saw) isn't new. With roles,
  // a "not a real use" that's reported but doesn't fail a check (a catalog, recorded or test entry) isn't one either
  if (l.label === "not" && failsNow.has(key) && was === false) regressions.push(`NEW FALSE POSITIVE [${rule}] ${key}`);
  if (l.label === "real" && !reported && was === true) regressions.push(`LOST [${rule}] ${key}`);
}

const shifts: string[] = [];
for (const rule of new Set([...Object.keys(usagesByRule), ...Object.keys(base?.usagesByRule ?? {})])) {
  const [a, b] = [base?.usagesByRule[rule] ?? 0, usagesByRule[rule] ?? 0];
  if (base && Math.abs(b - a) > Math.max(3, a * 0.1)) shifts.push(`${rule}: ${a} → ${b} places`);
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : "—");
const tot = [...per.values()].reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn, recallReal: a.recallReal + r.recallReal, recallFound: a.recallFound + r.recallFound }), { tp: 0, fp: 0, fn: 0, recallReal: 0, recallFound: 0 });
const lines = [
  `# Accuracy gate (${new Date().toLocaleDateString("en-CA")})`,
  "",
  `${labels.size} human labels; ${scans.length} repos scanned; feed frozen at bench/feed-snapshot.${skippedRepos.size ? ` Labels in ${skippedRepos.size} repos that couldn't be scanned this time were left out: ${[...skippedRepos].join(", ")}.` : ""}`,
  "",
  `**Overall:** precision ${pct(tot.tp, tot.tp + tot.fp)}, recall ${pct(tot.recallFound, tot.recallReal)} (recall sample only).`,
  "",
  `**Fails a check:** precision ${pct(fail.now.tp, fail.now.tp + fail.now.fp)} with roles (only live code), ${pct(fail.before.tp, fail.before.tp + fail.before.fp)} under the rule before roles (outside tests and lists). Real uses are counted as found in any role.`,
  "",
  "| Rule | Places | Labelled | Precision | Recall |",
  "|---|---|---|---|---|",
  ...[...new Set([...Object.keys(usagesByRule), ...per.keys()])]
    .sort((a, b) => (usagesByRule[b] ?? 0) - (usagesByRule[a] ?? 0))
    .map((rule) => {
      const r = per.get(rule);
      return `| ${rule} | ${usagesByRule[rule] ?? 0} | ${r ? r.tp + r.fp + r.fn : 0} | ${r ? pct(r.tp, r.tp + r.fp) : "—"} | ${r ? pct(r.recallFound, r.recallReal) : "—"} |`;
    }),
  "",
  regressions.length ? `## Regressions\n\n${regressions.map((x) => `- ${x}`).join("\n")}\n` : "No regressions against the baseline.\n",
  shifts.length ? `## Rules whose number of places moved (no labels say whether for better)\n\n${shifts.map((x) => `- ${x}`).join("\n")}\n` : "",
  labels.size < 100 ? "\n_Fewer than 100 labels: label more with `npx tsx bench/sample.ts` then `npx tsx bench/label.ts --by <name>`._\n" : "",
];
await writeFile(join(BENCH, "out", "gate.md"), lines.join("\n"));
console.log(lines.join("\n"));

if (update) {
  const next: Baseline = { updated: new Date().toISOString(), reported: Object.fromEntries(Object.entries(reportedNow).sort()), usagesByRule: Object.fromEntries(Object.entries(usagesByRule).sort()) };
  await writeFile(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log(`baseline saved (${Object.keys(next.reported).length} labelled places, ${Object.keys(usagesByRule).length} rules)`);
} else if (regressions.length || (strict && shifts.length)) {
  console.error(`\nAccuracy gate FAILED: ${regressions.length} regression(s)${strict && shifts.length ? `, ${shifts.length} unlabelled shift(s)` : ""}.`);
  process.exit(1);
}
