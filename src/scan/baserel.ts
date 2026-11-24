/**
 * A path joined to a base URL held in a name, in the same file:
 *   private $base = 'https://graph.microsoft.com/v1.0/me/';   …   $this->base . 'drive/sharedWithMe'
 *   BASE = "https://graph.microsoft.com/v1.0"; … BASE + "/users/me/drive/recent"
 * The joined URL is a request to that provider's path, reported at the join line (method unknown: "*"). The base has
 * to be one of a provider's hosts with a path of its own (a version, a resource root); a bare host is the business of
 * the path rules (src/scan/wrapperpaths.ts), which know the operations, and a line they already report is left alone. Text-based, any language; comments don't count.
 */
import { matchUrl } from "../providers.js";
import type { Usage } from "../types.js";

type Files = { rel: string; lang: Usage["lang"]; source: string }[];
const BASE = /(?<![\w$])\$?([A-Za-z_]\w*)\s*(?::\s*[\w<>\[\]|?\\]+\s*)?(?:=>|=|:)\s*["'`](https:\/\/[A-Za-z0-9.-]+\/[^"'`\s?#]+)["'`]/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function baseRelUsages(files: Files, found: Usage[], isTest: (rel: string) => boolean): Usage[] {
  const out: Usage[] = [];
  const have = new Set(found.filter((u) => u.op).map((u) => `${u.file}|${u.line}`));
  for (const f of files) {
    if (f.source.length > 1_000_000 || !/https:\/\//.test(f.source)) continue;
    const lines = f.source.split("\n");
    for (const b of f.source.matchAll(BASE)) {
      const name = b[1];
      const base = b[2].replace(/\/+$/, "");
      const hit = matchUrl(`${base}/`);
      if (!hit || !hit.path || hit.path === "/") continue;
      const join = new RegExp(`(?<![\\w$])(?:\\$this->|this\\.|self::|static::|@|[A-Za-z_]\\w*\\.)?\\$?${esc(name)}\\s*(?:\\.|\\+)\\s*["'\`]([^"'\`\\s{}$%]+)["'\`]`);
      lines.forEach((l, i) => {
        if (l.length > 1000 || /^\s*(?:\/\/|#|\*)/.test(l) || have.has(`${f.rel}|${i + 1}`)) return;
        const m = join.exec(l);
        if (!m || /^https?:/.test(m[1]) || !/^[A-Za-z/][\w/().:@-]*$/.test(m[1])) return;
        const rel = m[1].replace(/^\/+/, "").split(/[?#]/)[0];
        if (!rel) return;
        const full = matchUrl(`${base}/${rel}`);
        if (!full?.path || full.provider.id !== hit.provider.id) return;
        have.add(`${f.rel}|${i + 1}`);
        out.push({
          provider: full.provider.id, kind: "http", lang: f.lang, file: f.rel, line: i + 1, op: `* ${full.path.replace(/\/+$/, "")}`, confidence: "possible",
          snippet: l.trim().slice(0, 200), reason: `${name} (${base}) joined to "${rel}"`,
          ...(isTest(f.rel) ? { inTest: true } : {}),
        });
      });
    }
  }
  return out;
}
