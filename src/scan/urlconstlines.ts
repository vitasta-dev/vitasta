/**
 * A request whose URL is a constant of the same file:
 *   private static final String THREADS_URL = "https://api.openai.com/v1/threads";
 *   HttpRequest.newBuilder().uri(URI.create(THREADS_URL)).POST(…)
 * The request is found at its use; the constant's line is where the URL is written, and where a fix changes it, so
 * it's an alsoLine of the finding. Any language: a NAME = "https://…provider…" (const / static / final / let / var /
 * define / plain) in the file, named on the request's line or the lines it spans.
 */
import { matchUrl } from "../providers.js";
import type { Usage } from "../types.js";

type Files = { rel: string; source: string }[];

export function addUrlConstantLines(usages: Usage[], files: Files): void {
  const byRel = new Map(files.map((f) => [f.rel, f.source]));
  const consts = new Map<string, Map<string, number>>();
  const constsOf = (rel: string): Map<string, number> => {
    let m = consts.get(rel);
    if (m) return m;
    m = new Map();
    const src = byRel.get(rel);
    if (src && src.length <= 2_000_000) {
      src.split("\n").forEach((l, i) => {
        if (l.length > 2000) return;
        const d = /(?:^|[\s(,;])\$?([A-Za-z_]\w*)\s*(?::\s*[\w<>?]+\s*)?(?::=|=|,)\s*["'`](https?:\/\/[^"'`\s]+)["'`]/.exec(l);
        if (d && matchUrl(d[2]) && !m!.has(d[1])) m!.set(d[1], i + 1);
      });
    }
    consts.set(rel, m);
    return m;
  };
  for (const u of usages) {
    if (u.kind !== "http" || !u.op || !byRel.has(u.file)) continue;
    const cs = constsOf(u.file);
    if (!cs.size) continue;
    const lines = byRel.get(u.file)!.split("\n");
    const rows = [u.line, ...(u.alsoLines ?? [])];
    const add = new Set<number>();
    for (const r of rows) {
      const l = lines[r - 1] ?? "";
      for (const [name, at] of cs) if (at !== u.line && new RegExp(String.raw`(?<![\w$])\$?(?:self::|static::|this\.|self\.)?${name}(?![\w])`).test(l) && !/^\s*(?:\/\/|#|\*)/.test(l)) add.add(at);
    }
    if (add.size) u.alsoLines = [...new Set([...(u.alsoLines ?? []), ...add])].sort((a, b) => a - b);
  }
}
