/**
 * Scan every repo in the corpus with the current scanner, caching the result in bench/out/ for the sampler and gate.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadFeed } from "../src/feed/match.js";
import { BENCH, readList, scanForBench, type RepoScan } from "./lib.js";

export const CORPUS = join(BENCH, "corpus.txt");
export const LOCK = join(BENCH, "corpus.lock.json");
/** Fixed date so "retired" vs "retiring" doesn't drift between runs */
export const BENCH_TODAY = "2026-11-13";

export async function scanCorpus(opts: { repos?: string; feedDir: string; today?: string; quiet?: boolean }): Promise<RepoScan[]> {
  const repos = await readList(opts.repos ?? CORPUS);
  const feed = await loadFeed(opts.feedDir);
  const lock: Record<string, string> = JSON.parse(await readFile(LOCK, "utf8").catch(() => "{}"));
  const out: RepoScan[] = [];
  for (const [i, repo] of repos.entries()) {
    try {
      const s = await scanForBench(repo, feed, opts.today ?? BENCH_TODAY, lock[repo]);
      if (lock[repo] && lock[repo] !== s.sha) console.warn(`! ${repo} is at ${s.sha.slice(0, 7)}, lock says ${lock[repo].slice(0, 7)}: labels may not line up`);
      lock[repo] ??= s.sha;
      out.push(s);
      if (!opts.quiet) console.log(`${String(i + 1).padStart(3)}/${repos.length} ${repo}: ${s.usages.length} usages, ${s.flagged.length} flagged`);
    } catch (e) {
      console.warn(`! ${repo}: ${(e as Error).message.split("\n")[0].slice(0, 120)}`);
    }
  }
  await writeFile(LOCK, JSON.stringify(Object.fromEntries(Object.entries(lock).sort()), null, 2) + "\n");
  await mkdir(join(BENCH, "out"), { recursive: true });
  return out;
}

export const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
