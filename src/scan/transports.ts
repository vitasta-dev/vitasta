/**
 * Fix 6: requests a provider path names, sent by the repo's own transport or described as data.
 *
 * Transport wrappers: a JS/TS function that builds its URL from a provider base written in it plus one of its own
 * parameters (`uri: \`${baseUrl}${endpoint}\`` with baseUrl = credentials.url || 'https://api.openai.com/v1'). Its
 * callers (found through the call map) name the operation: apiRequest.call(this, 'POST', requestPath`/audio/translations`)
 * is POST /v1/audio/translations.
 *
 * Declarative routing (n8n-style node descriptions): `routing: { request: { method: 'POST', url: '/v1/edits' } }`, with
 * the provider base from a `baseURL` in the same file or a file that imports it (requestDefaults of the node).
 *
 * Either way the operation comes from matchUrl on base + path, so only a provider's own host counts.
 */
import { matchUrl } from "../providers.js";
import type { Usage } from "../types.js";
import type { CallMap, CmDef } from "./callmap.js";
import { normalizePath } from "./js.js";

const BASE_LIT = /https:\/\/[A-Za-z0-9.-]+(?:\/[\w./-]*)?/;

function opFor(base: string, method: string, path: string): { provider: string; op: string } | undefined {
  const url = base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
  const hit = matchUrl(url.replace(/\$\{[^}]*\}/g, "{id}"));
  if (!hit) return undefined;
  return { provider: hit.provider.id, op: `${method.toUpperCase()} ${normalizePath(hit.path)}` };
}

/** Top-level arguments of the call opening at `open` (the "("), as raw text */
function args(src: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0, start = open + 1, q: string | undefined;
  for (let j = open; j < Math.min(src.length, open + 4000); j++) {
    const c = src[j];
    if (q) {
      if (c === "\\") j++;
      else if (c === q) q = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") q = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (--depth === 0) {
        out.push(src.slice(start, j).trim());
        return out;
      }
    } else if (c === "," && depth === 1) {
      out.push(src.slice(start, j).trim());
      start = j + 1;
    }
  }
  return out;
}

const pathOf = (a: string | undefined) => (a ? /^(?:[\w$]+)?[`'"]([^`'"\n]*)[`'"]$/.exec(a.trim())?.[1] : undefined);
const methodOf = (a: string | undefined) => (a ? /^["'`](GET|POST|PUT|PATCH|DELETE)["'`]$/i.exec(a.trim())?.[1] : undefined);

export function transportUsages(
  map: CallMap,
  usages: Usage[],
  text: (rel: string) => string | undefined,
  candidates: (any: string[], all?: string[]) => string[],
  isTest: (file: string) => boolean,
  modulePaths: (file: string) => string[],
  localsFor: (map: CallMap, g: string, file: string, def: CmDef) => string[],
): Usage[] {
  const out: Usage[] = [];
  const have = new Set(usages.filter((u) => u.op).map((u) => `${u.file}|${u.line}|${u.op}`));
  const push = (u: Usage) => {
    const k = `${u.file}|${u.line}|${u.op}`;
    if (have.has(k)) return;
    have.add(k);
    out.push(u);
  };
  // 1. Transport wrappers: files with a provider base literal and a function joining a base name with a parameter
  for (const f of candidates(["https://api.openai.com", "https://api.anthropic.com", "https://graph.facebook.com", "https://api.stripe.com"])) {
    if (isTest(f) || !/\.[cm]?[jt]sx?$/.test(f)) continue;
    const src = text(f);
    const idx = map.get(f);
    if (!src || !idx || src.length > 2_000_000) continue;
    const lines = src.split("\n");
    for (const def of idx.defs) {
      if (def.kind !== "function" || !def.params?.length) continue;
      const body = lines.slice(def.start - 1, def.end).join("\n");
      const b = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?["'`](https:\/\/[^"'`\s]+)["'`]/.exec(body);
      if (!b || !matchUrl(b[2])) continue;
      const pi = def.params.findIndex((p) => new RegExp(`\\$\\{\\s*${b[1].replace(/\$/g, "\\$")}\\s*\\}\\s*\\$\\{\\s*${p.replace(/\$/g, "\\$")}\\s*\\}|\\b${b[1]}\\s*\\+\\s*${p}\\b`).test(body));
      if (pi < 0) continue;
      const mi = def.params.findIndex((p) => /^method$/i.test(p));
      // `this` typed as the first parameter (TS) isn't an argument
      const shift = def.params[0] === "this" ? 1 : 0;
      for (const g of candidates([def.name, ...modulePaths(f)])) {
        if (g === f || isTest(g)) continue;
        const locals = localsFor(map, g, f, def);
        const gs = locals.length ? text(g) : undefined;
        if (!gs) continue;
        for (const l of locals) {
          for (const m of gs.matchAll(new RegExp(`(?<![\\w$.])${l.replace(/\$/g, "\\$")}(\\.call\\s*)?\\(`, "g"))) {
            const a = args(gs, m.index! + m[0].length - 1);
            const off = m[1] ? 1 : 0;
            const path = pathOf(a[pi - shift + off]);
            const method = mi >= 0 ? methodOf(a[mi - shift + off]) : "GET";
            if (!path || !method) continue;
            const hit = opFor(b[2], method, path);
            if (!hit) continue;
            const line = gs.slice(0, m.index).split("\n").length;
            push({
              provider: hit.provider, kind: "http", lang: /\.[cm]?jsx?$/.test(g) ? "js" : "ts", file: g, line, op: hit.op, confidence: "likely",
              snippet: (gs.split("\n")[line - 1] ?? "").trim().slice(0, 200), reason: `sent by ${def.name} (${f}:${def.start}) to ${b[2]}`,
            });
          }
        }
      }
    }
  }
  // 2. Declarative routing: request descriptions with a path, and the base URL of the node that uses them
  for (const f of candidates(["routing"], ["request"])) {
    if (isTest(f)) continue;
    const src = text(f);
    if (!src || src.length > 2_000_000) continue;
    const baseIn = (s: string) => /\bbaseURL\s*:\s*[^\n]*/.exec(s)?.[0].match(BASE_LIT)?.[0];
    let base = baseIn(src);
    if (!base) {
      // A file that imports this one (the node whose requestDefaults hold the base)
      for (const g of candidates(modulePaths(f))) {
        const gi = map.get(g);
        if (!gi || !gi.imports.some((im) => map.resolveSpec(g, im.spec) === f)) continue;
        base = baseIn(text(g) ?? "");
        if (base) break;
      }
    }
    if (!base || !matchUrl(base)) continue;
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (!/\brouting\s*:\s*\{/.test(l)) return;
      // The request block: method and url within the next lines
      const blk = lines.slice(i, i + 12).join("\n");
      const url = /\burl\s*:\s*["'`](\/[^"'`\n]+)["'`]/.exec(blk);
      if (!url) return;
      const method = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(blk)?.[1] ?? "GET";
      const hit = opFor(base!, method, url[1]);
      if (!hit) return;
      const line = i + 1 + blk.slice(0, url.index).split("\n").length - 1;
      push({
        provider: hit.provider, kind: "http", lang: /\.[cm]?jsx?$/.test(f) ? "js" : "ts", file: f, line, op: hit.op, confidence: "likely",
        snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `a routed request to ${base}`,
      });
    });
  }
  return out;
}
