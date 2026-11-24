/**
 * Automatic library maps, trial ("if lib exist then use it otherwise start building the lib
 * map"). A map, built offline from a library release's published package (parse only; see tools in the trial notes),
 * says which public functions reach a provider operation, directly or through another library's function. Here, an
 * app's call of a mapped function becomes a "possible" finding with usage.libmap = "auto", the chain in its reason.
 * Off unless VITASTA_LIBMAP_DIR names a map cache (<dir>/pypi/<package>/<version>.json). Python only for the trial.
 * Packages the app imports that have no map for their locked version are returned, so a runner can queue them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installedFor, type ReadFile } from "./lockfiles.js";
import type { Usage } from "../types.js";

type Files = { rel: string; lang: Usage["lang"]; source: string }[];
type MapFn = { file: string; line: number; params: string[]; defaults?: Record<string, string>; ops?: { provider: string; op: string; params: string[] }[]; calls?: string[] };
type LibMap = { package: string; version: string; functions: Record<string, MapFn>; aliases: Record<string, string> };

const SETTINGS = new Set(["temperature", "top_p", "top_k", "model", "max_tokens"]);
const pyName = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");

export function autoMapUsages(files: Files, read: ReadFile, found: Usage[], cacheDir: string): { usages: Usage[]; unmapped: { package: string; version?: string }[] } {
  const out: Usage[] = [];
  const unmapped = new Map<string, string | undefined>();
  const base = join(cacheDir, "pypi");
  if (!existsSync(base)) return { usages: out, unmapped: [] };
  const cache = new Map<string, LibMap | null>();
  const load = (pkg: string, version?: string): LibMap | undefined => {
    const dir = join(base, pyName(pkg));
    const k = `${pyName(pkg)}@${version ?? "*"}`;
    if (cache.has(k)) return cache.get(k) ?? undefined;
    let m: LibMap | null = null;
    try {
      if (existsSync(dir)) {
        const vs = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
        const v = version ? vs.find((x) => x === version) : vs.length === 1 ? vs[0] : undefined;
        if (v) m = JSON.parse(readFileSync(join(dir, `${v}.json`), "utf8")) as LibMap;
      }
    } catch {
      m = null;
    }
    cache.set(k, m);
    return m ?? undefined;
  };
  const resolve = (m: LibMap, key: string): [string, MapFn] | undefined => {
    const t = m.functions[key] ? key : m.aliases[key];
    if (t && m.functions[t]) return [t, m.functions[t]];
    // a name the package's root exports with a star import (from .assistants.main import *): the unique non-method
    // function of that name under the package
    const name = key.split(".").pop()!;
    const root = key.split(".")[0];
    const cands = Object.keys(m.functions).filter((k) => k.startsWith(root + ".") && k.endsWith("." + name) && k.split(".").length <= 4).sort((a, b) => a.length - b.length);
    return cands.length ? [cands[0], m.functions[cands[0]]] : undefined;
  };
  // a mapped function's provider operations, through its calls into other mapped libraries (up to 3 libraries deep)
  const reach = (m: LibMap, fn: MapFn, key: string, from: string, depth = 0): { provider: string; op: string; chain: string }[] => {
    const here = `${key} (${m.package} ${m.version}, auto map)`;
    const res = (fn.ops ?? []).map((o) => ({ provider: o.provider, op: o.op, chain: `${here} → ${o.provider} ${o.op}` }));
    if (depth >= 3) return res;
    for (const c of fn.calls ?? []) {
      const [dep, fname] = c.split(":");
      const dm = load(dep, installedFor(read, from, "pypi", dep)?.version) ?? load(dep);
      // (a library's own dependency without a map isn't listed: only what the app imports is queued here)
      if (!dm) continue;
      const r = resolve(dm, `${dep.replace(/-/g, "_")}.${fname}`);
      if (r) for (const x of reach(dm, r[1], r[0], from, depth + 1)) res.push({ ...x, chain: `${here} → ${x.chain}` });
    }
    return res;
  };
  const have = new Set(found.filter((u) => u.op).map((u) => `${u.file}|${u.line}|${u.op}`));
  for (const f of files) {
    if (f.lang !== "py" || f.source.length > 2_000_000) continue;
    // imported names: from pkg.mod import a, b as c / import pkg(.mod) (as x)
    const names = new Map<string, string>();
    for (const m of f.source.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(?:\(([^)]*)\)|([^\n(]+))/gm)) {
      for (const part of (m[2] ?? m[3]).split(",")) {
        const pm = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part.replace(/#.*$/, ""));
        if (pm) names.set(pm[2] ?? pm[1], `${m[1]}.${pm[1]}`);
      }
    }
    for (const m of f.source.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+(\w+))?\s*$/gm)) names.set(m[2] ?? m[1].split(".")[0], m[2] ? m[1] : m[1].split(".")[0]);
    if (!names.size) continue;
    const roots = new Set([...names.values()].map((v) => v.split(".")[0]));
    const lines = f.source.split("\n");
    for (const root of roots) {
      const inst = installedFor(read, f.rel, "pypi", root);
      if (!inst?.version && !inst?.range) continue; // not a declared third-party package
      const m = load(root, inst.version) ?? (inst.version ? undefined : load(root));
      if (!m) { unmapped.set(pyName(root), inst.version); continue; }
      lines.forEach((l, i) => {
        if (l.length > 2000 || /^\s*(?:#|from\s|import\s)/.test(l)) return;
        for (const c of l.matchAll(/(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)) {
          const [head, ...rest] = c[1].split(".");
          const full = names.get(head);
          if (!full || full.split(".")[0] !== root) continue;
          const key = [full, ...rest].join(".");
          const r = resolve(m, key);
          if (!r) continue;
          const kw = [...l.slice(c.index! + c[0].length).matchAll(/\b([a-z_]\w*)\s*=(?!=)/g)].map((x) => x[1]).filter((x) => SETTINGS.has(x));
          for (const x of reach(m, r[1], r[0], f.rel)) {
            if (have.has(`${f.rel}|${i + 1}|${x.op}`)) continue;
            have.add(`${f.rel}|${i + 1}|${x.op}`);
            out.push({
              provider: x.provider, kind: "sdk", lang: "py", file: f.rel, line: i + 1, op: x.op, confidence: "possible", libmap: "auto",
              ...(kw.length ? { params: kw } : {}), snippet: l.trim().slice(0, 200), reason: `${c[1]}(…) → ${x.chain}`,
            });
          }
        }
      });
    }
  }
  return { usages: out, unmapped: [...unmapped].map(([p, v]) => ({ package: p, ...(v ? { version: v } : {}) })) };
}
