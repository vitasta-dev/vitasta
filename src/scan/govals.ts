/**
 * Item 4, Go: versions in package-level constants and variables that reach a provider URL in
 * another file of the package, or in another package through its import path (go.mod's module path). Per package
 * (folder): its const/var declarations (single and grouped). An expression is evaluated across files: "…" + X,
 * pkg.Name, fmt.Sprintf("%s/…", A, B) with %s / %v, up to 3 levels; a URL's leading parts are enough. A line that
 * makes a provider URL with a version from such a value is reported (one per file and version, other lines as
 * alsoLines). A name that resolves to more than one declaration is left alone.
 */
import { matchUrl, urlVersionOf } from "../providers.js";
import type { Usage } from "../types.js";

const MAX_LINE = 2000;

export function goValueUsages(files: { rel: string; lang: Usage["lang"]; source: string }[], found: Usage[], goMods: { dir: string; module: string }[]): Usage[] {
  const go = files.filter((f) => f.lang === "go" && f.source.length <= 2_000_000 && !/_test\.go$/.test(f.rel));
  if (!go.length) return [];
  const dirOf = (rel: string) => rel.split("/").slice(0, -1).join("/");
  // Package-level values by folder
  const vals = new Map<string, Map<string, { expr: string; file: string; line: number }[]>>();
  for (const f of go) {
    const d = dirOf(f.rel);
    const m = vals.get(d) ?? new Map();
    vals.set(d, m);
    let group: "const" | "var" | undefined;
    let depth = 0;
    f.source.split("\n").forEach((l, i) => {
      if (l.length > MAX_LINE) return;
      if (/^\s*func\b/.test(l)) depth = 1;
      if (depth > 0) {
        depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
        if (depth <= 0) depth = 0;
        return;
      }
      if (/^(const|var)\s*\(\s*$/.test(l)) {
        group = l.startsWith("const") ? "const" : "var";
        return;
      }
      if (group && /^\s*\)\s*$/.test(l)) {
        group = undefined;
        return;
      }
      const d1 = group ? /^\s*([A-Za-z_]\w*)\s*(?:[\w.*\[\]]+\s*)?=\s*(.+?)\s*(?:\s\/\/[^"]*)?$/.exec(l) : /^(?:const|var)\s+([A-Za-z_]\w*)\s*(?:[\w.*\[\]]+\s*)?=\s*(.+?)\s*(?:\s\/\/[^"]*)?$/.exec(l);
      if (d1) m.set(d1[1], [...(m.get(d1[1]) ?? []), { expr: d1[2], file: f.rel, line: i + 1 }]);
    });
  }
  const importsOf = (src: string) => {
    const out = new Map<string, string>();
    const block = /import\s*\(([\s\S]*?)\)/.exec(src)?.[1] ?? "";
    for (const m of [...block.matchAll(/^[ \t]*(?:([A-Za-z_]\w*|\.)\s+)?"([^"]+)"/gm), ...src.matchAll(/^import\s+(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/gm)]) out.set(m[1] ?? m[2].split("/").pop()!, m[2]);
    return out;
  };
  /** The folder an import path names, through the module path of a go.mod in the repo */
  const dirForImport = (path: string): string | undefined => {
    for (const g of goMods) if (path === g.module || path.startsWith(`${g.module}/`)) return [g.dir, path.slice(g.module.length).replace(/^\//, "")].filter(Boolean).join("/");
    return undefined;
  };
  const lookup = (dir: string, name: string) => {
    const c = vals.get(dir)?.get(name) ?? [];
    return c.length === 1 ? c[0] : undefined;
  };
  const evalExpr = (expr: string, rel: string, imports: Map<string, string>, depth: number, via: string[]): string | undefined => {
    if (depth > 3) return undefined;
    const sp = /^fmt\.Sprintf\(\s*"((?:\\.|[^"\\])*)"\s*,\s*([\s\S]+)\)$/.exec(expr.trim());
    if (sp) {
      const args = sp[2].split(",").map((a) => a.trim());
      let k = 0, ok = true;
      const s = sp[1].replace(/%[sv]/g, () => {
        const v = ok ? refValue(args[k++] ?? "", rel, imports, depth, via) : undefined;
        if (v === undefined) ok = false;
        return v ?? "\u0000";
      });
      const cut = s.indexOf("\u0000");
      return cut >= 0 ? (cut > 0 ? s.slice(0, cut) : undefined) : s;
    }
    let out = "";
    for (const p of expr.split(/\s*\+\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      const lit = /^"((?:\\.|[^"\\])*)"$|^`([^`]*)`$/.exec(p.trim());
      const v = lit ? lit[1] ?? lit[2] : refValue(p.trim(), rel, imports, depth, via);
      if (v === undefined) return out || undefined;
      out += v;
    }
    return out;
  };
  const refValue = (ref: string, rel: string, imports: Map<string, string>, depth: number, via: string[]): string | undefined => {
    const m = /^(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)$/.exec(ref);
    if (!m) return undefined;
    const dir = m[1] ? (imports.has(m[1]) ? dirForImport(imports.get(m[1])!) : undefined) : dirOf(rel);
    if (dir === undefined) return undefined;
    const d = lookup(dir, m[2]);
    if (!d) return undefined;
    via.push(`${ref} (${d.file}:${d.line})`);
    const src = go.find((f) => f.rel === d.file)?.source ?? "";
    return evalExpr(d.expr, d.file, importsOf(src), depth + 1, via);
  };
  const out: Usage[] = [];
  const have = new Set(found.filter((u) => u.apiVersion && !u.traceOnly).map((u) => `${u.file}|${u.line}`));
  const perFile = new Map<string, Usage>();
  for (const f of go) {
    const imports = importsOf(f.source);
    f.source.split("\n").forEach((l, i) => {
      if (l.length > MAX_LINE || /^\s*\/\//.test(l) || have.has(`${f.rel}|${i + 1}`)) return;
      const exprs: string[] = [];
      for (const m of l.matchAll(/fmt\.Sprintf\(\s*"https?:\/\/[^"]*"\s*,[^)]*\)/g)) exprs.push(m[0]);
      for (const m of l.matchAll(/(?:"https?:\/\/[^"]*"|\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\+[^,;){]+/g)) exprs.push(m[0]);
      // a bare reference used as a URL (http.Get(fb.GraphURL + path) is caught above; http.Get(fb.GraphURL) here)
      for (const m of l.matchAll(/\(\s*([A-Za-z_]\w*\.[A-Z]\w*)\s*[,)]/g)) exprs.push(m[1]);
      for (const e of exprs) {
        if (!/\b[A-Za-z_]\w*\b/.test(e.replace(/"[^"]*"/g, ""))) continue;
        const via: string[] = [];
        const val = evalExpr(e, f.rel, imports, 0, via);
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
          provider: hit.provider.id, kind: "version-pin", lang: "go", file: f.rel, line: i + 1, apiVersion: `url: ${ver}`, confidence: "likely",
          snippet: l.trim().slice(0, 200), reason: `${via.join(" → ")} makes ${val.slice(0, 80)}`,
        };
        perFile.set(key, u);
        out.push(u);
        break;
      }
    });
  }
  return out;
}
