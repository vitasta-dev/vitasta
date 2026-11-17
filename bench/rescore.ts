/**
 * Re-score a labelled sample after scanner changes (same places, same labels). This is tuned-on data, so it is an
 * upper bound; confirm with a fresh sample.
 *   npx tsx bench/rescore.ts <recall-sample.jsonl> <real numbers, comma-separated> --feed ../feed/data
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeModel } from "../src/providers.js";
import { scanRepo } from "../src/scan/index.js";

const [file, realList] = process.argv.slice(2);
const real = new Set(realList.split(",").map(Number));
const rows = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { n: number; repo: string; file: string; line: number; model: string });
const maps = new Map<string, Awaited<ReturnType<typeof scanRepo>>>();
let tp = 0, fn = 0, fp = 0, tn = 0;
for (const r of rows) {
  if (!maps.has(r.repo)) maps.set(r.repo, await scanRepo(join(homedir(), ".cache/vitasta/repos", r.repo.replace("/", "__"))));
  const map = maps.get(r.repo)!;
  const text = await readFile(join(homedir(), ".cache/vitasta/repos", r.repo.replace("/", "__"), r.file), "utf8");
  const hit = map.usages.some((u) => {
    if (u.file !== r.file || !u.model || normalizeModel(u.model) !== r.model) return false;
    if (r.file.endsWith(".ipynb")) return true;
    const spanLine = u.modelSpan ? text.slice(0, u.modelSpan.start).split("\n").length : -1;
    return u.line === r.line || spanLine === r.line;
  });
  if (real.has(r.n)) hit ? tp++ : fn++;
  else hit ? fp++ : tn++;
  if (real.has(r.n) !== hit) console.log(`${real.has(r.n) ? "MISS" : "FALSE"} #${r.n} ${r.repo} ${r.file}:${r.line} ${r.model}`);
}
console.log(`recall ${tp}/${tp + fn}; flagged non-usages ${fp}/${fp + tn}`);
