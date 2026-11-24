/**
 * Layer 1 (client recognition, 23 Nov design): SDK vocabulary generated from each SDK's published package
 * (src/data/sdk-vocab/*.json, built by tools/vocab from the registry release, never installed or run). Nothing here
 * names an SDK: adding one means adding its generated data file.
 *
 * Params-type rule (typed languages): a value of a params / options type the vocabulary knows (C#: `new T { … }`,
 * a variable or field declared T and later `x.Prop = …`; Go: a composite literal `pkg.T{ Field: … }`, or `x.Field =`
 * on a variable of that type) sets request fields for the operations that take T. Each mapped property is reported
 * at its own line with its wire name, so it doesn't matter where the client is built or how the call is reached.
 * A type name resolves through the file's usings / imports (and C# global usings anywhere in the repo); an unqualified
 * name that two packages define is left alone.
 */
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "../types.js";

interface ParamType { fields: Record<string, string>; ops: string[]; versions: string[] }
export interface VType { res: Record<string, string>; methods: Record<string, { op: string; params?: string }[]> }
export interface Vocab {
  lang: "cs" | "go" | "java" | "rb" | "php"; package: string; provider: string; versions: string[]; namespaces: string[]; paramTypes: Record<string, ParamType>; types: Record<string, VType>; clients: Record<string, string[]>;
  /** A provider-neutral options type (Microsoft.Extensions.AI ChatOptions) sent by this SDK's adapter: only in a repo
   *  that turns this SDK's client into the neutral one (client.AsIChatClient(…)), and then "possible" */
  adapter?: { package: string; packageVersions: string[]; methods: string[] };
}

const require = createRequire(import.meta.url);
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "sdk-vocab");
let VOCABS: Vocab[] | undefined;
export function vocabs(): Vocab[] {
  if (!VOCABS) {
    VOCABS = [];
    let names: string[] = [];
    try {
      names = readdirSync(DIR).filter((n) => n.endsWith(".json"));
    } catch {
      /* none */
    }
    for (const n of names) VOCABS.push(require(join(DIR, n)) as Vocab);
  }
  return VOCABS;
}

interface Known { full: string; ns: string; simple: string; v: Vocab; t: ParamType }
/** Params types by simple name, per language */
function paramIndex(lang: Vocab["lang"]): Map<string, Known[]> {
  const out = new Map<string, Known[]>();
  for (const v of vocabs()) {
    if (v.lang !== lang) continue;
    for (const [full, t] of Object.entries(v.paramTypes)) {
      if (!t.ops?.length || !Object.keys(t.fields).length) continue;
      const clean = full.replace(/\+/g, ".");
      const i = clean.lastIndexOf(".");
      const k: Known = { full: clean, ns: clean.slice(0, i), simple: clean.slice(i + 1), v, t };
      out.set(k.simple, [...(out.get(k.simple) ?? []), k]);
    }
  }
  return out;
}

const MAX_LINE = 2000;
type Files = { rel: string; lang: Usage["lang"]; source: string }[];

/** Top-level `Key = value` / `Key: value` entries of a brace block starting at offset `open` */
function blockKeys(src: string, open: number, sep: "=" | ":"): { key: string; at: number; end: number }[] {
  const out: { key: string; at: number; end: number }[] = [];
  let depth = 0, q: string | undefined, start = open + 1;
  const take = (a: number, b: number) => {
    const seg = src.slice(a, b);
    const m = (sep === "=" ? /^\s*([A-Z_]\w*)\s*=(?![=>])/ : /^\s*([A-Z]\w*)\s*:(?!=)/).exec(seg);
    if (m) out.push({ key: m[1], at: a + seg.indexOf(m[1]), end: b });
  };
  for (let j = open; j < Math.min(src.length, open + 20000); j++) {
    const c = src[j];
    if (q) {
      if (c === "\\") j++;
      else if (c === q) q = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) {
        take(start, j);
        break;
      }
    } else if (c === "," && depth === 1) {
      take(start, j);
      start = j + 1;
    }
  }
  return out;
}

export function vocabUsages(files: Files, found: Usage[]): Usage[] {
  const out: Usage[] = [];
  const have = new Set(found.filter((u) => u.params?.length).map((u) => `${u.file}|${u.line}|${u.params!.join(",")}`));
  // a setting another rule already reports for the same call (a few lines away: the call vs its builder) isn't repeated
  const near = new Map<string, number[]>();
  for (const u of found) for (const p of u.params ?? []) near.set(`${u.file}|${u.provider}|${p}`, [...(near.get(`${u.file}|${u.provider}|${p}`) ?? []), u.line, ...(u.alsoLines ?? [])]);
  const lineAt = (src: string, at: number) => src.slice(0, at).split("\n").length;
  const emit = (f: Files[number], k: Known, prop: string, at: number, end: number, how: string) => {
    const wire = k.t.fields[prop];
    if (!wire) return;
    const line = lineAt(f.source, at);
    if (have.has(`${f.rel}|${line}|${wire}`)) return;
    if ((near.get(`${f.rel}|${k.v.provider}|${wire}`) ?? []).some((l) => Math.abs(l - line) <= 8)) return;
    have.add(`${f.rel}|${line}|${wire}`);
    const lines = f.source.split("\n");
    // the setting's value is a local declared above (var temperature = state.Get(…, 0.0m)): that line is where the
    // default lives, a place a fix changes too
    const val = /(?:=|:)\s*([a-z_]\w*)\s*[;,)}\n]/.exec(f.source.slice(at, Math.min(f.source.length, end + 2)));
    const also: number[] = [];
    if (val) {
      for (let r = line - 2; r >= Math.max(0, line - 60); r--) {
        if (/^\s*(?:(?:public|private|protected|internal|static|async|override)\s+)+[\w<>,\[\]?\s]+\s+\w+\s*\(|^\s*func\s/.test(lines[r])) break;
        if (new RegExp(`^\\s*(?:var|[\\w<>?\\[\\]]+)\\s+${val[1]}\\s*=(?!=)|^\\s*${val[1]}\\s*:=`).test(lines[r])) {
          also.push(r + 1);
          break;
        }
      }
    }
    out.push({
      ...(also.length ? { alsoLines: also } : {}),
      provider: k.v.provider, kind: "sdk", lang: f.lang, file: f.rel, line, op: k.t.ops[0], params: [wire], confidence: k.v.adapter ? "possible" : "likely",
      snippet: (lines[line - 1] ?? "").trim().slice(0, 200), sdkCall: k.simple, paramSpans: { [wire]: { start: at, end } },
      reason: k.v.adapter
        ? `${wire} (${k.simple}.${prop}, ${how}) is sent to ${k.t.ops[0]} when the chat client is ${k.v.package}'s (${k.v.adapter.methods.join("/")} in this repo)`
        : `${wire} (${k.simple}.${prop}, ${how}) is sent by ${k.v.package} to ${k.t.ops[0]}`,
    });
  };

  // C#: usings per file, plus global usings anywhere
  const cs = files.filter((f) => f.lang === "cs" && f.source.length <= 2_000_000);
  if (cs.length) {
    const idx = paramIndex("cs");
    if (idx.size) {
      const globals = new Set<string>();
      for (const f of cs) for (const m of f.source.matchAll(/^[ \t]*global\s+using\s+([\w.]+)\s*;/gm)) globals.add(m[1]);
      // an adapter vocabulary counts when some file calls its adapter and uses the SDK's own namespaces
      const sdkNs = (v: Vocab) => new Set(vocabs().filter((x) => x.lang === "cs" && x.package === v.package && !x.adapter).flatMap((x) => x.namespaces));
      const adaptedCache = new Map<Vocab, boolean>();
      const adapted = (v: Vocab): boolean => {
        if (!adaptedCache.has(v)) {
          const ns = sdkNs(v);
          const call = new RegExp(`\\.(?:${v.adapter!.methods.join("|")})\\s*\\(`);
          adaptedCache.set(v, cs.some((f) => call.test(f.source) && ([...globals].some((g) => ns.has(g)) || [...f.source.matchAll(/^[ \t]*using\s+(?:static\s+)?([\w.]+)\s*;/gm)].some((m) => ns.has(m[1])) || /\bnew\s+AnthropicClient\b/.test(f.source) && ns.size > 0)));
        }
        return adaptedCache.get(v)!;
      };
      const names = [...idx.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const anyName = new RegExp(`\\b(${names.join("|")})\\b`);
      for (const f of cs) {
        if (!anyName.test(f.source)) continue;
        const usings = new Set([...globals, ...[...f.source.matchAll(/^[ \t]*using\s+(?:static\s+)?([\w.]+)\s*;/gm)].map((m) => m[1])]);
        const fileNs = /^[ \t]*namespace\s+([\w.]+)/m.exec(f.source)?.[1];
        const resolve = (written: string): Known | undefined => {
          const simple = written.split(".").pop()!;
          const cands = (idx.get(simple) ?? []).filter((k) => !k.v.adapter || adapted(k.v));
          const qual = written.includes(".") ? written.slice(0, written.lastIndexOf(".")) : undefined;
          const hit = cands.filter((k) => (qual ? k.ns === qual || k.ns.endsWith("." + qual) : usings.has(k.ns) || (fileNs && (fileNs === k.ns || fileNs.startsWith(k.ns + ".")))));
          return hit.length === 1 ? hit[0] : undefined;
        };
        const qn = `((?:[A-Z]\\w*\\.)*(?:${names.join("|")}))`;
        // typed names: declarations (T x = / T x; / T x) / T x,) and `var x = new T`
        const vars = new Map<string, Known>();
        for (const m of f.source.matchAll(new RegExp(`\\b${qn}\\??\\s+(_?[a-z]\\w*)\\s*(?=[=;,)])`, "g"))) {
          const k = resolve(m[1]);
          if (k) vars.set(m[2], k);
        }
        for (const m of f.source.matchAll(new RegExp(`\\bvar\\s+(_?\\w+)\\s*=\\s*new\\s+${qn}\\b`, "g"))) {
          const k = resolve(m[2]);
          if (k) vars.set(m[1], k);
        }
        // initializers: new T(...) { Prop = … }, and `T x = new() { … }`
        for (const m of f.source.matchAll(new RegExp(`\\bnew\\s+${qn}\\s*(?:\\([^)]*\\))?\\s*\\{`, "g"))) {
          const k = resolve(m[1]);
          if (!k) continue;
          for (const e of blockKeys(f.source, m.index! + m[0].length - 1, "=")) emit(f, k, e.key, e.at, e.end, "set in its initializer");
        }
        for (const m of f.source.matchAll(new RegExp(`\\b${qn}\\s+_?\\w+\\s*=\\s*new\\s*\\(\\s*\\)\\s*\\{`, "g"))) {
          const k = resolve(m[1]);
          if (!k) continue;
          for (const e of blockKeys(f.source, m.index! + m[0].length - 1, "=")) emit(f, k, e.key, e.at, e.end, "set in its initializer");
        }
        // later assignments: x.Prop = …
        for (const [name, k] of vars) {
          for (const m of f.source.matchAll(new RegExp(`(?<![\\w.])(?:this\\.)?${name.replace(/\$/g, "\\$")}\\.([A-Z]\\w*)\\s*=(?![=>])`, "g"))) {
            const end = f.source.indexOf(";", m.index!);
            emit(f, k, m[1], m.index! + m[0].indexOf(m[1]), end < 0 ? m.index! + m[0].length : end, `assigned to ${name}`);
          }
        }
      }
    }
  }

  // Java (JVM SDKs build params with builders): T.builder().field(…)… up to .build(), T resolved through imports
  // (exact or wildcard) or a fully qualified name; the builder method names are the vocabulary's field names
  const java = files.filter((f) => f.lang === "java" && f.source.length <= 2_000_000);
  if (java.length) {
    const idx = paramIndex("java");
    if (idx.size) {
      const names = [...idx.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const anyName = new RegExp(`\\b(${names.join("|")})\\b`);
      for (const f of java) {
        if (!anyName.test(f.source)) continue;
        const exact = new Map([...f.source.matchAll(/^[ \t]*import\s+([\w.]+)\.(\w+)\s*;/gm)].map((m) => [m[2], `${m[1]}.${m[2]}`]));
        const wild = new Set([...f.source.matchAll(/^[ \t]*import\s+([\w.]+)\.\*\s*;/gm)].map((m) => m[1]));
        const pkg = /^[ \t]*package\s+([\w.]+)\s*;/m.exec(f.source)?.[1];
        const resolve = (written: string): Known | undefined => {
          const simple = written.split(".").pop()!;
          const cands = idx.get(simple) ?? [];
          const full = written.includes(".") ? written : exact.get(simple);
          const hit = cands.filter((k) => (full ? k.full === full : wild.has(k.ns) || k.ns === pkg));
          return hit.length === 1 ? hit[0] : undefined;
        };
        for (const m of f.source.matchAll(new RegExp(`\\b((?:[a-z]\\w*\\.)*(?:${names.join("|")}))\\s*\\.\\s*builder\\s*\\(\\s*\\)`, "g"))) {
          const k = resolve(m[1]);
          if (!k) continue;
          // the chain: .name(…) calls at depth 0 until .build() or the end of the statement
          let depth = 0;
          for (let j = m.index! + m[0].length; j < Math.min(f.source.length, m.index! + 8000); j++) {
            const c = f.source[j];
            if (c === "(") depth++;
            else if (c === ")") depth--;
            else if (c === ";" && depth <= 0) break;
            else if (c === "." && depth === 0) {
              const call = /^\.\s*(\w+)\s*\(/.exec(f.source.slice(j, j + 80));
              if (!call) continue;
              if (call[1] === "build") break;
              const close = f.source.indexOf(")", j);
              emit(f, k, call[1], j, close < 0 ? j + call[0].length : close + 1, "set on its builder");
            }
          }
        }
      }
    }
  }

  // Go: imports per file; composite literals pkg.T{ Field: … } and x.Field = on a variable of that type
  const go = files.filter((f) => f.lang === "go" && f.source.length <= 2_000_000 && !/_test\.go$/.test(f.rel));
  if (go.length) {
    const byFull = new Map<string, Known>();
    for (const ks of paramIndex("go").values()) for (const k of ks) byFull.set(k.full, k);
    if (byFull.size) {
      const pkgs = new Set([...byFull.values()].map((k) => k.ns));
      for (const f of go) {
        const imports = new Map<string, string>();
        const block = /import\s*\(([\s\S]*?)\)/.exec(f.source)?.[1] ?? "";
        for (const m of [...block.matchAll(/^[ \t]*(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/gm), ...f.source.matchAll(/^import\s+(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/gm)]) {
          if (!pkgs.has(m[2])) continue;
          // the default name of a versioned module path (…/openai-go/v3) is its last non-version element, dashes dropped
          const parts = m[2].split("/");
          const last = /^v\d+$/.test(parts[parts.length - 1]) ? parts[parts.length - 2] : parts[parts.length - 1];
          imports.set(m[1] ?? last.replace(/^go-/, "").replace(/-go$/, "").replace(/-/g, ""), m[2]);
        }
        if (!imports.size) continue;
        const vars = new Map<string, Known>();
        for (const [alias, path] of imports) {
          const a = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          for (const m of f.source.matchAll(new RegExp(`(?<![\\w.])&?${a}\\.([A-Z]\\w*)\\s*\\{`, "g"))) {
            const k = byFull.get(`${path}.${m[1]}`);
            if (!k) continue;
            for (const e of blockKeys(f.source, m.index! + m[0].length - 1, ":")) emit(f, k, e.key, e.at, e.end, "set in its struct literal");
            const lhs = /(\w+)\s*:?=\s*&?$/.exec(f.source.slice(Math.max(0, m.index! - 60), m.index!));
            if (lhs) vars.set(lhs[1], k);
          }
          for (const m of f.source.matchAll(new RegExp(`\\bvar\\s+(\\w+)\\s+\\*?${a}\\.([A-Z]\\w*)\\b`, "g"))) {
            const k = byFull.get(`${path}.${m[2]}`);
            if (k) vars.set(m[1], k);
          }
        }
        for (const [name, k] of vars) {
          for (const m of f.source.matchAll(new RegExp(`(?<![\\w.])${name}\\.([A-Z]\\w*)\\s*=(?!=)`, "g"))) {
            const end = f.source.indexOf("\n", m.index!);
            emit(f, k, m[1], m.index! + m[0].indexOf(m[1]), end < 0 ? f.source.length : end, `assigned to ${name}`);
          }
        }
      }
    }
  }
  return out.filter((u) => (u.snippet ?? "").length <= MAX_LINE);
}

/**
 * Layer 4: call shapes from the vocabulary, for calls whose receiver isn't known. A shape is a resource chain plus
 * a method of at least two segments (C# `.Messages.GetClaudeMessageAsync(`, Java `.messages().create(`, Go
 * `.Chat.Completions.New(`), built from the generated resources and routed methods. It counts only in a file that
 * imports the SDK (a using / import of one of its namespaces or packages), and is reported "possible". A call
 * another rule already reports for the same op within a few lines isn't repeated.
 */
interface Shape { re: RegExp; op: string; v: Vocab; text: string; meth: string }
const SHAPES = new Map<string, Shape[]>();
function shapes(lang: Vocab["lang"]): Shape[] {
  if (SHAPES.has(lang)) return SHAPES.get(lang)!;
  const out: Shape[] = [];
  const seen = new Set<string>();
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const seg = (f: string) => {
    const call = f.endsWith("()");
    const name = esc(f.replace(/\(\)$/, ""));
    return lang === "java" ? `\\.\\s*${name}\\s*\\(\\s*\\)` : call ? `\\.\\s*${name}\\s*\\([^()]*\\)` : `\\.\\s*${name}\\b(?!\\s*\\()`;
  };
  for (const v of vocabs()) {
    if (v.lang !== lang || !v.types) continue;
    // owners of each type: (owner, field)
    const owners = new Map<string, [string, string][]>();
    for (const [o, t] of Object.entries(v.types)) for (const [f, ty] of Object.entries(t.res)) owners.set(ty, [...(owners.get(ty) ?? []), [o, f]]);
    for (const [ty, t] of Object.entries(v.types)) {
      for (const [m, ops] of Object.entries(t.methods)) {
        const op = ops[0]?.op;
        if (!op || /^(get|set|to|with|equals|hashCode|close|build)/i.test(m) && m.length < 6) continue;
        for (const [o, f] of owners.get(ty) ?? []) {
          const chains = [[f], ...(owners.get(o) ?? []).map(([, f0]) => [f0, f])];
          for (const ch of chains) {
            const text = [...ch, m].join(".");
            const key = `${v.package}|${text}|${op}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ re: new RegExp(`${ch.map(seg).join("\\s*")}\\s*\\.\\s*${esc(m)}\\s*\\(`, "g"), op, v, text, meth: m });
          }
        }
      }
    }
  }
  SHAPES.set(lang, out);
  return out;
}

export function callShapeUsages(files: Files, found: Usage[]): Usage[] {
  const out: Usage[] = [];
  const near = new Map<string, number[]>();
  for (const u of [...found]) if (u.op) near.set(`${u.file}|${u.op}`, [...(near.get(`${u.file}|${u.op}`) ?? []), u.line]);
  for (const f of files) {
    const lang = f.lang === "cs" || f.lang === "go" || f.lang === "java" ? f.lang : undefined;
    if (!lang || f.source.length > 2_000_000) continue;
    const imported = (v: Vocab) =>
      lang === "go"
        ? v.namespaces.some((n) => f.source.includes(`"${n}"`))
        : v.namespaces.some((n) => new RegExp(`^[ \\t]*(?:global\\s+)?(?:using|import)\\s+(?:static\\s+)?${n.replace(/\./g, "\\.")}(?:\\.[\\w*]+)*\\s*;`, "m").test(f.source));
    const ok = new Map<Vocab, boolean>();
    // every match, then the longest chain per call (Chat.Completions.New, not Completions.New, at the same call)
    const hits = new Map<number, { sh: Shape; start: number; len: number }>();
    for (const sh of shapes(lang)) {
      if (!ok.has(sh.v)) ok.set(sh.v, imported(sh.v));
      if (!ok.get(sh.v) || !f.source.includes(sh.meth)) continue;
      sh.re.lastIndex = 0;
      for (const m of f.source.matchAll(sh.re)) {
        const end = m.index! + m[0].length;
        const len = sh.text.split(".").length;
        const prev = hits.get(end);
        if (!prev || len > prev.len) hits.set(end, { sh, start: m.index!, len });
      }
    }
    const lines = f.source.split("\n");
    for (const { sh, start } of [...hits.values()].sort((a, b) => a.start - b.start)) {
      const line = f.source.slice(0, start).split("\n").length;
      const k = `${f.rel}|${sh.op}`;
      if ((near.get(k) ?? []).some((l) => Math.abs(l - line) <= 3)) continue;
      near.set(k, [...(near.get(k) ?? []), line]);
      out.push({
        provider: sh.v.provider, kind: "sdk", lang, file: f.rel, line, op: sh.op, confidence: "possible", sdkCall: sh.text,
        snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `${sh.text} is ${sh.v.package}'s call for ${sh.op} (the receiver isn't known)`,
      });
    }
  }
  return out;
}
