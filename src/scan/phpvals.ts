/**
 * Item 4, PHP: versions in class constants, property defaults and config fallbacks that reach a
 * provider URL, also through a parent class in another file. Per file: namespace, use aliases, classes (parent, const,
 * property defaults). An expression is evaluated across files: '…' . "…" concatenation, self:: / static:: / parent:: /
 * Class::CONST, $this->prop (the class and its ancestors), a local's last assignment above in the function, and
 * config('key', DEFAULT) / env('KEY', DEFAULT) as their default; up to 3 levels, a URL's leading parts are enough.
 * A line that makes a provider URL with a version from such a value is reported (one per file and version, other
 * lines as alsoLines). A class name that doesn't resolve to exactly one class is left alone.
 */
import { matchUrl, urlVersionOf } from "../providers.js";
import type { Usage } from "../types.js";

interface PhpClass {
  file: string;
  name: string;
  ns: string;
  parent?: string;
  consts: Map<string, { expr: string; line: number }>;
  props: Map<string, { expr: string; line: number }>;
}
interface PhpFile {
  rel: string;
  ns: string;
  uses: Map<string, string>;
  classes: PhpClass[];
}

const MAX_LINE = 2000;

function indexPhp(rel: string, source: string): PhpFile {
  const ns = /^[ \t]*namespace\s+([\w\\]+)\s*;/m.exec(source)?.[1] ?? "";
  const uses = new Map<string, string>();
  for (const m of source.matchAll(/^[ \t]*use\s+\\?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) uses.set(m[2] ?? m[1].split("\\").pop()!, m[1]);
  const classes: PhpClass[] = [];
  let cur: PhpClass | undefined;
  source.split("\n").forEach((l, i) => {
    if (l.length > MAX_LINE) return;
    const c = /^\s*(?:abstract\s+|final\s+|readonly\s+)*(?:class|trait|interface)\s+(\w+)(?:\s+extends\s+\\?([\w\\]+))?/.exec(l);
    if (c) {
      cur = { file: rel, name: c[1], ns, parent: c[2], consts: new Map(), props: new Map() };
      classes.push(cur);
      return;
    }
    if (!cur) return;
    const k = /^\s*(?:(?:public|protected|private|final)\s+)*const\s+(\w+)\s*=\s*([^;]+);/.exec(l);
    if (k) cur.consts.set(k[1], { expr: k[2].trim(), line: i + 1 });
    const p = /^\s*(?:(?:public|protected|private|static|readonly|var)\s+)+(?:\??[\w\\]+\s+)?\$(\w+)\s*=\s*([^;]+);/.exec(l);
    if (p) cur.props.set(p[1], { expr: p[2].trim(), line: i + 1 });
  });
  return { rel, ns, uses, classes };
}

/** Top-level parts of a PHP concatenation ('a' . X::Y . $b) */
function splitDots(expr: string): string[] {
  const parts: string[] = [];
  let cur = "", q: string | undefined, depth = 0;
  for (let j = 0; j < expr.length; j++) {
    const c = expr[j];
    if (q) {
      cur += c;
      if (c === "\\") cur += expr[++j] ?? "";
      else if (c === q) q = undefined;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === "." && depth === 0 && !/\d/.test(expr[j + 1] ?? "")) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

export function phpValueUsages(files: { rel: string; lang: Usage["lang"]; source: string }[], found: Usage[]): Usage[] {
  const php = files.filter((f) => f.lang === "php" && f.source.length <= 2_000_000);
  if (!php.length) return [];
  const idx = php.map((f) => indexPhp(f.rel, f.source));
  const byFqn = new Map<string, PhpClass[]>();
  for (const f of idx) for (const c of f.classes) {
    const fq = (f.ns ? `${f.ns}\\` : "") + c.name;
    byFqn.set(fq, [...(byFqn.get(fq) ?? []), c]);
  }
  const fileOf = new Map(idx.map((f) => [f.rel, f]));
  const classFor = (rel: string, name: string): PhpClass | undefined => {
    const f = fileOf.get(rel);
    const clean = name.replace(/^\\/, "");
    const own = f?.classes.find((c) => c.name === clean);
    if (own) return own;
    const fq = name.startsWith("\\") ? clean : f?.uses.get(clean.split("\\")[0]) ? f!.uses.get(clean.split("\\")[0])! + clean.slice(clean.split("\\")[0].length) : (f?.ns ? `${f.ns}\\` : "") + clean;
    const c = byFqn.get(fq) ?? [];
    return c.length === 1 ? c[0] : undefined;
  };
  /** A constant or property, looked up in the class and its ancestors */
  const member = (cls: PhpClass | undefined, name: string, kind: "consts" | "props"): { cls: PhpClass; expr: string; line: number } | undefined => {
    for (let c = cls, n = 0; c && n < 6; c = c.parent ? classFor(c.file, c.parent) : undefined, n++) {
      const m = c[kind].get(name);
      if (m) return { cls: c, ...m };
    }
    return undefined;
  };
  const evalExpr = (expr: string, rel: string, cls: PhpClass | undefined, lines: string[] | undefined, row: number, depth: number, via: string[]): string | undefined => {
    if (depth > 3) return undefined;
    let out = "";
    for (const p of splitDots(expr)) {
      const v = partValue(p.trim(), rel, cls, lines, row, depth, via);
      if (v === undefined) return out || undefined;
      out += v;
    }
    return out;
  };
  const partValue = (p: string, rel: string, cls: PhpClass | undefined, lines: string[] | undefined, row: number, depth: number, via: string[]): string | undefined => {
    const lit = /^'((?:\\.|[^'\\])*)'$|^"((?:\\.|[^"\\$])*)"$/.exec(p);
    if (lit) return lit[1] ?? lit[2];
    // config('key', DEFAULT), env('KEY', DEFAULT): the default
    const cfg = /^(?:config|env|\\?Config::get|getenv)\s*\(\s*['"][^'"]*['"]\s*,\s*([\s\S]+)\)$/.exec(p);
    if (cfg) return evalExpr(cfg[1], rel, cls, lines, row, depth + 1, via);
    const st = /^(self|static|parent|\\?[A-Z][\w\\]*)::\$?(\w+)$/.exec(p);
    if (st) {
      const target = st[1] === "self" || st[1] === "static" ? cls : st[1] === "parent" ? (cls?.parent ? classFor(cls.file, cls.parent) : undefined) : classFor(rel, st[1]);
      const m = member(target, st[2], "consts") ?? member(target, st[2], "props");
      if (!m) return undefined;
      via.push(`${st[1]}::${st[2]} (${m.cls.file}:${m.line})`);
      return evalExpr(m.expr, m.cls.file, m.cls, undefined, 0, depth + 1, via);
    }
    const th = /^\$this->(\w+)$/.exec(p);
    if (th) {
      const m = member(cls, th[1], "props");
      if (!m) return undefined;
      via.push(`$this->${th[1]} (${m.cls.file}:${m.line})`);
      return evalExpr(m.expr, m.cls.file, m.cls, undefined, 0, depth + 1, via);
    }
    const local = /^\$(\w+)$/.exec(p);
    if (local && lines) {
      // its last assignment above, within the function
      for (let r = row - 1; r >= Math.max(0, row - 40); r--) {
        if (/\bfunction\s+\w+\s*\(/.test(lines[r])) break;
        const a = new RegExp(`^\\s*\\$${local[1]}\\s*=\\s*([^;]+);`).exec(lines[r]);
        if (a) return evalExpr(a[1].trim(), rel, cls, lines, r, depth + 1, via);
      }
    }
    return undefined;
  };
  const out: Usage[] = [];
  const have = new Set(found.filter((u) => u.apiVersion && !u.traceOnly).map((u) => `${u.file}|${u.line}`));
  const perFile = new Map<string, Usage>();
  for (const f of php) {
    const fi = fileOf.get(f.rel)!;
    const lines = f.source.split("\n");
    let cls: PhpClass | undefined;
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE) return;
      const c = /^\s*(?:abstract\s+|final\s+|readonly\s+)*(?:class|trait)\s+(\w+)/.exec(l);
      if (c) cls = fi.classes.find((x) => x.name === c[1]);
      // a URL made with a value: a string literal concatenated with a reference (::, $this->, $var)
      if (!/['"][^'"]*https?:\/\//.test(l) || !/\.\s*(?:\$|\\?[A-Za-z_]\w*::|self::|static::)/.test(l) || have.has(`${f.rel}|${i + 1}`)) return;
      for (const m of l.matchAll(/(['"]https?:\/\/[^'"]*['"]\s*\.[^,;)]+)/g)) {
        const via: string[] = [];
        const val = evalExpr(m[1], f.rel, cls, lines, i, 0, via);
        if (!val || !via.length) continue;
        const hit = matchUrl(val);
        const ver = hit ? urlVersionOf(hit.provider, val) : undefined;
        if (!hit || !ver) continue;
        const key = `${f.rel}|${hit.provider.id}|${ver}`;
        const prev = perFile.get(key);
        if (prev) {
          if (prev.line !== i + 1) prev.alsoLines = [...new Set([...(prev.alsoLines ?? []), i + 1])].sort((a, b) => a - b);
          break;
        }
        const u: Usage = {
          provider: hit.provider.id, kind: "version-pin", lang: "php", file: f.rel, line: i + 1, apiVersion: `url: ${ver}`, confidence: "likely",
          snippet: l.trim().slice(0, 200), reason: `${via.join(" → ")} makes ${val.slice(0, 80)}`,
        };
        perFile.set(key, u);
        out.push(u);
        break;
      }
    });
  }
  // The defining line is the finding: the property or constant a URL takes its
  // version from (public static $fb_api_version = '14.0', joined after a literal ".../v"). Its own file's URL lines are
  // its alsoLines; another file's uses stay findings of their own. A same-named property declared in a file whose
  // URL uses that name through another class (FbApi::$fb_api_version) holds the version too.
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const decls = new Map<string, Usage>();
  for (const u of [...out]) {
    const ver = u.apiVersion?.split(": ").pop();
    if (!ver) continue;
    const names = new Set<string>();
    for (const m of (u.reason ?? "").matchAll(/(?:^|→\s*)(?:[\w\\]+::|self::|static::|\$this->)?\$?(\w+)\s*\(([^()\s]+):(\d+)\)/g)) {
      names.add(m[1]);
      const file = m[2], line = +m[3];
      const src = byRel.get(file);
      if (!src || found.some((x) => x.file === file && x.line === line) || out.some((x) => x.file === file && x.line === line)) continue;
      const k = `${file}|${line}|${ver}`;
      const same = file === u.file ? [u.line, ...(u.alsoLines ?? [])] : [];
      const prev = decls.get(k);
      if (prev) { prev.alsoLines = [...new Set([...(prev.alsoLines ?? []), ...same])].sort((a, b) => a - b); continue; }
      const text = src.source.split("\n")[line - 1] ?? "";
      const d: Usage = {
        provider: u.provider, kind: "version-pin", lang: "php", file, line, apiVersion: u.apiVersion, confidence: "likely",
        snippet: text.trim().slice(0, 200), reason: `holds the ${ver} that ${u.file}:${u.line} puts in its URL`, ...(same.length ? { alsoLines: same } : {}),
      };
      decls.set(k, d);
    }
    // a same-named property of this file's own class (private static $fb_api_version = '14.0')
    const src = byRel.get(u.file);
    if (!src) continue;
    const bare = ver.replace(/^v/, "");
    for (const n of names) {
      for (const m of src.source.matchAll(new RegExp(`^[ \\t]*(?:(?:public|private|protected|static|const|readonly|var)\\s+)+(?:\\??\\w+\\s+)?\\$?${n}\\s*=\\s*['"]v?${bare.replace(/\./g, "\\.")}['"]`, "gm"))) {
        const line = src.source.slice(0, m.index!).split("\n").length;
        const k = `${u.file}|${line}|${ver}`;
        if (decls.has(k) || found.some((x) => x.file === u.file && x.line === line) || out.some((x) => x.file === u.file && x.line === line)) continue;
        decls.set(k, { provider: u.provider, kind: "version-pin", lang: "php", file: u.file, line, apiVersion: u.apiVersion, confidence: "likely", snippet: m[0].trim().slice(0, 200), reason: `holds ${ver}, as ${n} does where ${u.file}:${u.line} puts it in its URL` });
      }
    }
  }
  out.push(...decls.values());
  return out;
}
