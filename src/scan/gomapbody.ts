/**
 * Go: a map literal marshalled as the body of a request to a provider URL:
 *   payload := map[string]any{"model": m, "temperature": c.Temperature}   (or map[string]interface{})
 *   payload["top_p"] = c.TopP
 *   body, _ := json.Marshal(payload)       (or json.NewEncoder(w).Encode(payload), or a helper that returns the map)
 *   http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(body))
 * In a function that names a provider's request URL (a literal, or a package constant), the marshalled map's own
 * top-level keys are the request's settings, reported at their lines (a nested map's keys are not: an Ollama request's
 * "options": {"temperature": …} goes to a server this scanner doesn't know, and sits one level down). The same
 * "possible" rule as src/scan/gostruct.ts applies when the function also sends elsewhere. Text-based and bounded.
 */
import { matchUrl } from "../providers.js";
import type { Usage } from "../types.js";

type Files = { rel: string; lang: Usage["lang"]; source: string }[];
const dirOf = (rel: string) => rel.split("/").slice(0, -1).join("/");
const MAP_OPEN = /map\[string\](?:any|interface\s*\{\s*\})\s*\{/g;

/** The brace-balanced end from an opening bracket (strings and runes skipped) */
function closeOf(src: string, open: number): number {
  const o = src[open], c = o === "{" ? "}" : o === "(" ? ")" : "]";
  let d = 0;
  for (let i = open; i < Math.min(src.length, open + 200_000); i++) {
    const ch = src[i];
    if (ch === '"' || ch === "`" || ch === "'") {
      const q = ch;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\" && q !== "`") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j; continue; }
    if (ch === o) d++;
    else if (ch === c && --d === 0) return i;
  }
  return -1;
}

/** The top-level keys of a map literal whose opening brace is at `open`: offsets of each key's text */
function topKeys(src: string, open: number, close: number): { key: string; at: number }[] {
  const out: { key: string; at: number }[] = [];
  let depth = 0;
  let entryStart = true;
  for (let i = open + 1; i < close; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); i = j < 0 ? close : j; continue; }
    if (depth === 0 && entryStart && ch === '"') {
      const m = /^"([A-Za-z_][\w.-]*)"\s*:(?!=)/.exec(src.slice(i, i + 120));
      if (m) {
        out.push({ key: m[1], at: i + 1 });
        i += m[0].length - 1;
        entryStart = false;
        continue;
      }
    }
    if (ch === '"' || ch === "`" || ch === "'") {
      const q = ch;
      for (i++; i < close && src[i] !== q; i++) if (src[i] === "\\" && q !== "`") i++;
      entryStart = false;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) entryStart = true;
    else if (!/\s/.test(ch) && depth === 0 && entryStart) entryStart = false;
  }
  return out;
}

export function goMapBodyUsages(files: Files, found: Usage[]): Usage[] {
  const go = files.filter((f) => f.lang === "go" && f.source.length <= 2_000_000 && /json\.(?:Marshal|NewEncoder)/.test(f.source) && /map\[string\]/.test(f.source));
  if (!go.length) return [];
  const all = files.filter((f) => f.lang === "go" && f.source.length <= 2_000_000);
  const out: Usage[] = [];
  const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
  const lineAt = (s: string, at: number) => s.slice(0, at).split("\n").length;
  const constCache = new Map<string, Map<string, string>>();
  const urlConsts = (dir: string): Map<string, string> => {
    const hit = constCache.get(dir);
    if (hit) return hit;
    const m = new Map<string, string>();
    for (const g of all) {
      if (dirOf(g.rel) !== dir) continue;
      for (const c of g.source.matchAll(/^[ \t]*(?:const\s+|var\s+)?([A-Za-z_]\w*)\s*(?:string\s*)?=\s*"(https:\/\/[^"\s]+)"/gm)) m.set(c[1], c[2]);
    }
    constCache.set(dir, m);
    return m;
  };
  /** The map literals a value stands for inside `body` (its own assignment, or a helper's returns) */
  const mapsOf = (file: (typeof go)[number], body: string, bodyAt: number, v: string, depth = 0): { file: (typeof go)[number]; at: number; open: number; close: number }[] => {
    const res: { file: (typeof go)[number]; at: number; open: number; close: number }[] = [];
    const lit = (g: (typeof go)[number], from: number, upTo: number, re: RegExp) => {
      for (const m of g.source.slice(from, upTo).matchAll(re)) {
        const open = from + m.index! + m[0].length - 1;
        const close = closeOf(g.source, open);
        if (close > 0) res.push({ file: g, at: open, open, close });
      }
    };
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // v := map[string]any{ … } / var v = map[string]any{ … } / v = &map… (the first assignment's literal)
    lit(file, bodyAt, bodyAt + body.length, new RegExp(`(?:\\b${esc}\\s*:?=|\\bvar\\s+${esc}\\s+(?:map\\[string\\]\\w+\\s*)?=)\\s*&?map\\[string\\](?:any|interface\\s*\\{\\s*\\})\\s*\\{`, "g"));
    if (res.length || depth > 1) return res;
    // v := helper(…): the helper's returned map literal(s), in the package
    const h = new RegExp(`\\b${esc}\\s*:?=\\s*(?:\\w+\\.)?(\\w+)\\s*\\(`).exec(body);
    if (h) res.push(...helperMaps(file, h[1]));
    return res;
  };
  const helperMaps = (file: (typeof go)[number], name: string) => {
    const res: { file: (typeof go)[number]; at: number; open: number; close: number }[] = [];
    for (const g of all) {
      if (dirOf(g.rel) !== dirOf(file.rel)) continue;
      const fn = new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${name}\\s*\\([^)]*\\)[^{\\n]*\\{`, "m").exec(g.source);
      if (!fn) continue;
      const open = fn.index! + fn[0].length - 1;
      const close = closeOf(g.source, open);
      if (close < 0) continue;
      for (const m of g.source.slice(open, close).matchAll(/\breturn\s+&?map\[string\](?:any|interface\s*\{\s*\})\s*\{/g)) {
        const mo = open + m.index! + m[0].length - 1;
        const mc = closeOf(g.source, mo);
        if (mc > 0) res.push({ file: g, at: mo, open: mo, close: mc });
      }
    }
    return res;
  };

  for (const f of go) {
    for (const fn of f.source.matchAll(/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(([^)]*)\)[^{\n]*\{/gm)) {
      const open = fn.index! + fn[0].length - 1;
      const close = closeOf(f.source, open);
      if (close < 0) continue;
      const body = f.source.slice(open, close);
      // the provider URLs it names: literals, and package constants passed as the URL
      const urls = [...body.matchAll(/"(https:\/\/[^"\s]+)"/g)].map((m) => m[1]);
      for (const [name, url] of urlConsts(dirOf(f.rel))) if (new RegExp(`(?<![\\w.])${name}(?![\\w])`).test(body)) urls.push(url);
      const hits = urls.map((u) => matchUrl(u)).filter((h): h is NonNullable<typeof h> => !!h && !!h.path && h.path !== "/");
      if (!hits.length) continue;
      const others = /["`][^"`]*\/(?:v\d+\/)?(?:chat\/completions|responses|completions)["`]/.test(body);
      // the values it marshals
      const vars = new Set<string>();
      for (const mm of body.matchAll(/json\.(?:Marshal(?:Indent)?|NewEncoder\([^)]*\)\.Encode)\(\s*&?([\w.]+)(\s*\()?/g)) {
        if (mm[2]) for (const m of helperMaps(f, mm[1].split(".").pop()!)) addKeys(m, `${mm[1]}()`);
        else vars.add(mm[1]);
      }
      for (const v of vars) {
        for (const m of mapsOf(f, body, open, v)) addKeys(m, v);
        // payload["top_p"] = x
        for (const m of body.matchAll(new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[\\s*"([A-Za-z_][\\w.-]*)"\\s*\\]\\s*=(?!=)`, "g"))) emit(f, open + m.index! + m[0].indexOf(`"`) + 1, m[1], v, f, open + m.index!);
      }
      function addKeys(m: { file: (typeof go)[number]; at: number; open: number; close: number }, v: string) {
        for (const k of topKeys(m.file.source, m.open, m.close)) emit(m.file, k.at, k.key, v, f, open);
      }
      function emit(g: (typeof go)[number], at: number, key: string, v: string, sender: (typeof go)[number], sendAt: number) {
        const line = lineAt(g.source, at);
        for (const h of hits) {
          if (have.has(`${g.rel}|${line}|${key}`)) continue;
          have.add(`${g.rel}|${line}|${key}`);
          out.push({
            provider: h.provider.id, kind: "http", lang: "go", file: g.rel, line, op: `POST ${h.path}`, params: [key], confidence: others || hits.length > 1 ? "possible" : "likely",
            snippet: (g.source.split("\n")[line - 1] ?? "").trim().slice(0, 200),
            reason: `"${key}" is a key of the map ${v} that ${fn[1]}() marshals as the body it sends to ${h.path} (${sender.rel}:${lineAt(sender.source, sendAt)})`,
            ...(g.rel === sender.rel && lineAt(sender.source, sendAt) !== line ? { alsoLines: [lineAt(sender.source, sendAt)] } : {}),
          });
        }
      }
    }
  }
  return out;
}
