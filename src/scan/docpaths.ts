/**
 * Documentation and agent files (Markdown, TOML) that tell a reader or an agent to call a provider endpoint:
 *   Call `POST /v1/audio/translations` with the file.        curl https://api.openai.com/v1/audio/translations -F …
 * Reported as documentation (doc: true: the "also" tier, never failing), at the line that names the endpoint. A full
 * provider URL always counts; a bare `METHOD /v1/path` counts when only one provider has that endpoint, or the file
 * names which of several does (its host, or its name). The endpoint has to be one of the provider's known operations (src/data/sdk-vocab).
 */
import { readFile } from "node:fs/promises";
import { matchUrl, PROVIDERS } from "../providers.js";
import type { Usage } from "../types.js";
import { listDocFiles } from "./files.js";
import { textFiles } from "./envdefaults.js";
import { known, norm } from "./wrapperpaths.js";

const MAX_LINE = 1000;

export async function docPathUsages(root: string, skip: (rel: string) => boolean, found: Usage[]): Promise<Usage[]> {
  const files = [...(await listDocFiles(root)), ...(await textFiles(root)).filter((f) => /\.toml$/i.test(f.rel))].filter((f) => !skip(f.rel));
  const out: Usage[] = [];
  const have = new Set(found.map((u) => `${u.file}|${u.line}|${u.op ?? ""}`));
  const ops = known();
  const providerWords = PROVIDERS.filter((p) => ops.has(p.id)).map((p) => ({ p, re: new RegExp(`\\b${p.id}\\b|${p.hosts.map((h) => h.replace(/\./g, "\\.")).join("|")}`, "i") }));
  for (const f of files) {
    const text = await readFile(f.path, "utf8").catch(() => "");
    if (!text || text.length > 1_000_000 || !/\/v\d+\//.test(text)) continue;
    const here = providerWords.filter((x) => x.re.test(text));
    text.split("\n").forEach((l, i) => {
      if (l.length > MAX_LINE) return;
      const add = (pid: string, method: string, path: string) => {
        const methods = ops.get(pid)?.get(norm(path));
        if (!methods || (method !== "*" && !methods.has(method) && !methods.has("*"))) return;
        const key = `${f.rel}|${i + 1}|${method} ${path}`;
        if (have.has(key)) return;
        have.add(key);
        out.push({ provider: pid, kind: "http", lang: "config", file: f.rel, line: i + 1, op: `${method} ${path}`, confidence: "possible", doc: true, role: "users-copy", snippet: l.trim().slice(0, 200), reason: "documentation: names this endpoint" });
      };
      // a full provider URL, with a method when the line says one (curl -X POST, a leading verb)
      for (const m of l.matchAll(/https:\/\/[^\s"'`)\]>]+/g)) {
        const hit = matchUrl(m[0]);
        if (!hit?.path || !/^\/v\d+\//.test(hit.path)) continue;
        const verb = /\b(GET|POST|PUT|PATCH|DELETE)\b/.exec(l)?.[1] ?? "*";
        add(hit.provider.id, verb, hit.path.replace(/\/$/, ""));
      }
      // METHOD /v1/path, in a file that names the provider
      for (const m of l.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+`?(\/v\d+\/[a-z][\w{}.:\/-]*)/g)) {
        // the endpoint belongs to one provider (/v1/audio/translations), or the file names which of several (/v1/models)
        const all = [...ops].filter(([, paths]) => paths.has(norm(m[2]))).map(([pid]) => pid);
        const owners = all.length === 1 ? all : here.map((x) => x.p.id).filter((pid) => all.includes(pid));
        if (owners.length === 1) add(owners[0], m[1], m[2].replace(/\/$/, ""));
      }
    });
  }
  return out;
}
