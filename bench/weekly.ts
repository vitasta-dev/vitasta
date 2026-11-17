/**
 * Weekly real-world check: scan fresh public repos the scanner was never tuned on, and queue a sample of what it
 * reports for a person to label. Shows how accurate it is on code nobody picked for the corpus.
 *
 *   npx tsx bench/weekly.ts [--repos 150] [--sample 50] [--feed bench/feed-snapshot] [--cleanup]
 *
 * Writes bench/queue/weekly-<date>.jsonl (code context included, so labelling needs no clones) and
 * bench/weekly/<date>.md (repos scanned, findings per rule, crashes). Repos used once are never used again
 * (bench/weekly/seen.txt), and corpus repos are skipped.
 */
import { rmSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadFeed } from "../src/feed/match.js";
import { arg, CORPUS } from "./corpus.js";
import { discover, eligible, QUERIES } from "./discover.js";
import { BENCH, contextFor, QUEUE, readList, repoDir, scanForBench, seeded, writeJsonl, type RepoScan } from "./lib.js";
import type { QueueItem } from "./sample.js";

const date = new Date().toLocaleDateString("en-CA");
const nRepos = Number(arg("--repos", "150"));
const nSample = Number(arg("--sample", "50"));
const cleanup = process.argv.includes("--cleanup");
const rand = seeded(Date.parse(date) / 86_400_000);
const WEEKLY = join(BENCH, "weekly");
await mkdir(WEEKLY, { recursive: true });

const skip = new Set([...(await readList(CORPUS)), ...(await readList(join(WEEKLY, "seen.txt")).catch(() => []))]);
// A different results page each week keeps the repos fresh
const page = 1 + (Math.floor(Date.parse(date) / (7 * 86_400_000)) % 5);
const found = await discover({ perQuery: Math.ceil(nRepos / QUERIES.length), page, log: (s) => console.log(s) });
const pools = new Map<string, string[]>();
for (const f of found) if (!skip.has(f.repo)) pools.set(f.query, [...new Set([...(pools.get(f.query) ?? []), f.repo])]);
const picked: string[] = [];
const lists = [...pools.values()].map((l) => l.sort(() => rand() - 0.5));
while (picked.length < nRepos && lists.some((l) => l.length)) {
  for (const l of lists) {
    let r: string | undefined;
    while ((r = l.shift())) if (!picked.includes(r) && eligible(r)) break;
    if (r && picked.length < nRepos) picked.push(r);
  }
}

const feed = await loadFeed(arg("--feed", join(BENCH, "feed-snapshot"))!);
const scans: RepoScan[] = [];
const failures: string[] = [];
for (const [i, repo] of picked.entries()) {
  const t0 = Date.now();
  try {
    const s = await scanForBench(repo, feed, date);
    scans.push(s);
    console.log(`${i + 1}/${picked.length} ${repo}: ${s.usages.length} usages, ${s.flagged.length} flagged, ${Date.now() - t0} ms`);
    if (Date.now() - t0 > 60_000) failures.push(`${repo}: slow scan (${Math.round((Date.now() - t0) / 1000)} s)`);
  } catch (e) {
    failures.push(`${repo}: ${(e as Error).message.split("\n")[0].slice(0, 140)}`);
  }
}

// Sample what users would see, spread over rules
const byRule = new Map<string, QueueItem[]>();
for (const s of scans) {
  for (const { row, claim } of s.flagged) {
    const it: QueueItem = { key: row.key, set: `weekly-${date}`, kind: "precision", repo: s.repo, sha: s.sha, file: row.file, line: row.line, thing: row.thing, rule: row.rule, claim, inTest: row.inTest, context: "" };
    byRule.set(row.rule, [...(byRule.get(row.rule) ?? []), it]);
  }
}
const sample: QueueItem[] = [];
const rules = [...byRule.values()].map((l) => [...new Map(l.map((x) => [x.key, x])).values()].sort(() => rand() - 0.5));
while (sample.length < nSample && rules.some((l) => l.length)) for (const l of rules) if (sample.length < nSample && l.length) sample.push(l.shift()!);
for (const it of sample) it.context = await contextFor(it.repo, it.file, it.line);
await writeJsonl(join(QUEUE, `weekly-${date}.jsonl`), sample);

const flagged = scans.reduce((a, s) => a + s.flagged.length, 0);
const ruleCounts = new Map<string, number>();
for (const s of scans) for (const f of s.flagged) ruleCounts.set(f.row.rule, (ruleCounts.get(f.row.rule) ?? 0) + 1);
await writeFile(
  join(WEEKLY, `${date}.md`),
  [
    `# Weekly real-world check, ${date}`,
    "",
    `- Repos scanned: ${scans.length} of ${picked.length} picked (fresh: not in the corpus or earlier weeks)`,
    `- Findings users would see: ${flagged} in ${scans.filter((s) => s.flagged.length).length} repos`,
    `- Queued for labelling: ${sample.length} (bench/queue/weekly-${date}.jsonl)`,
    "",
    "| Rule | Findings |",
    "|---|---|",
    ...[...ruleCounts].sort((a, b) => b[1] - a[1]).map(([r, n]) => `| ${r} | ${n} |`),
    "",
    failures.length ? `## Problems\n\n${failures.map((f) => `- ${f}`).join("\n")}\n` : "No crashes or slow scans.\n",
  ].join("\n"),
);
await appendFile(join(WEEKLY, "seen.txt"), picked.map((r) => `${r}\n`).join(""));
if (cleanup) for (const r of picked) rmSync(repoDir(r), { recursive: true, force: true });
console.log(`\n${scans.length} repos, ${flagged} findings, ${sample.length} queued, ${failures.length} problems`);
