/**
 * Build a labelling queue from the corpus.
 *
 *   npx tsx bench/sample.ts [--per-rule 12] [--recall 60] [--feed ../feed/data] [--seed 1]
 *
 * Precision items: findings users would see, up to --per-rule from each rule (provider/kind/language), so small
 * rules get measured too. Recall items: places where a retired model ID is written as a value, picked without
 * looking at whether the scanner found them (the page doesn't show that either).
 * Places that already have a label are skipped.
 */
import { join } from "node:path";
import { arg, scanCorpus } from "./corpus.js";
import { contextFor, loadLabels, QUEUE, seeded, writeJsonl } from "./lib.js";

export interface QueueItem {
  key: string;
  set: string;
  kind: "precision" | "recall";
  repo: string;
  sha: string;
  file: string;
  line: number;
  thing: string;
  rule?: string;
  claim?: string;
  inTest?: boolean;
  context: string;
}

const perRule = Number(arg("--per-rule", "12"));
const recallN = Number(arg("--recall", "60"));
const rand = seeded(Number(arg("--seed", "1")));
const labels = await loadLabels();
const scans = await scanCorpus({ feedDir: arg("--feed", "../feed/data")! });
const date = new Date().toLocaleDateString("en-CA");

const byRule = new Map<string, QueueItem[]>();
const seen = new Set<string>();
for (const s of scans) {
  for (const { row, claim } of s.flagged) {
    if (labels.has(row.key) || seen.has(row.key)) continue;
    seen.add(row.key);
    const item: QueueItem = { key: row.key, set: `corpus-${date}`, kind: "precision", repo: s.repo, sha: s.sha, file: row.file, line: row.line, thing: row.thing, rule: row.rule, claim, inTest: row.inTest, context: "" };
    byRule.set(row.rule, [...(byRule.get(row.rule) ?? []), item]);
  }
}
const precision = [...byRule.values()].flatMap((list) => list.sort(() => rand() - 0.5).slice(0, perRule));
const recallPool = scans.flatMap((s) => s.candidates.filter((c) => !labels.has(c.key) && !seen.has(c.key)).map((c) => ({ ...c, sha: s.sha })));
const recall: QueueItem[] = [...new Map(recallPool.map((c) => [c.key, c])).values()]
  .sort(() => rand() - 0.5)
  .slice(0, recallN)
  .map((c) => ({ key: c.key, set: `corpus-${date}`, kind: "recall", repo: c.repo, sha: c.sha, file: c.file, line: c.line, thing: c.thing, context: "" }));

const items = [...precision, ...recall].sort(() => rand() - 0.5);
for (const it of items) it.context = await contextFor(it.repo, it.file, it.line);
const file = join(QUEUE, `corpus-${date}.jsonl`);
await writeJsonl(file, items);
console.log(`\n${precision.length} precision items from ${byRule.size} rules, ${recall.length} recall items → ${file}`);
console.log("Label them: npx tsx bench/label.ts --by <your name>");
