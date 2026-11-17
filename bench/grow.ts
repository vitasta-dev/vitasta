/**
 * Grow the labelled corpus to about --target repos, spread evenly over the provider/language queries.
 *
 *   npx tsx bench/grow.ts --target 300 [--seed 7]
 *
 * Appends to bench/corpus.txt. Existing repos (and their labels) are kept.
 */
import { appendFile } from "node:fs/promises";
import { arg, CORPUS } from "./corpus.js";
import { discover, eligible, QUERIES } from "./discover.js";
import { readList, seeded } from "./lib.js";

const target = Number(arg("--target", "300"));
const rand = seeded(Number(arg("--seed", "7")));
const have = new Set(await readList(CORPUS));
const need = target - have.size;
if (need <= 0) {
  console.log(`corpus already has ${have.size} repos`);
  process.exit(0);
}
const perQuery = Math.ceil(need / QUERIES.length);
const found = await discover({ perQuery, log: console.log });
const byQuery = new Map<string, string[]>();
for (const f of found) if (!have.has(f.repo)) byQuery.set(f.query, [...(byQuery.get(f.query) ?? []), f.repo]);

const added: string[] = [];
// Round-robin over queries so no single provider dominates
const pools = [...byQuery.values()].map((l) => [...new Set(l)].sort(() => rand() - 0.5));
while (added.length < need && pools.some((p) => p.length)) {
  for (const pool of pools) {
    if (added.length >= need) break;
    let repo: string | undefined;
    while ((repo = pool.shift())) {
      if (have.has(repo) || added.includes(repo)) continue;
      if (eligible(repo)) break;
    }
    if (repo) {
      added.push(repo);
      console.log(`+ ${repo}`);
    }
  }
}
await appendFile(CORPUS, `\n# added ${new Date().toLocaleDateString("en-CA")} by bench/grow.ts (seed ${arg("--seed", "7")})\n${added.join("\n")}\n`);
console.log(`\nadded ${added.length}; corpus now ${have.size + added.length} repos`);
