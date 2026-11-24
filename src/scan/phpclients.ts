/**
 * Layer 2 (client recognition, 23 Nov design), PHP: one-hop receiver resolution over the generated SDK vocabulary.
 * A receiver holds an SDK client when, in its class, a parent class or a trait it uses:
 *   $this->client = OpenAI::client($key)            (a vocabulary maker chain: OpenAI::factory()->…->make(),
 *   $this->claude = new \Anthropic\Client(…)          new of a vocabulary client)
 *   public function __construct(private Client $c)  (a typed or promoted parameter / property of a client type)
 *   function client(): Client { … }                  (a method returning one)
 * or it is a local set from a maker in the same function, or a static facade (OpenAI::chat()). A call follows the
 * vocabulary's resource chain (->chat()->create, ->messages->create, ->threads()->runs()->create) to the method's op.
 * Wire names: the top-level keys of an array argument ('temperature' => 0.2), or named arguments (temperature: 0.2,
 * maxTokens: 100) through the method's params type. Calls the other rules already report aren't repeated.
 */
import type { Usage } from "../types.js";
import { vocabs, type Vocab } from "./vocab.js";

type Files = { rel: string; lang: Usage["lang"]; source: string }[];
interface PClass { name: string; parent?: string; traits: string[]; file: string; ns: string; uses: Map<string, string>; start: number; end: number; holders: Map<string, string> }

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

export function phpClientUsages(files: Files, found: Usage[]): Usage[] {
  const php = files.filter((f) => f.lang === "php" && f.source.length <= 2_000_000);
  const vs = vocabs().filter((v) => v.lang === "php" && v.types);
  if (!php.length || !vs.length) return [];
  const known = (t: string) => vs.some((v) => v.types[t] || v.clients[t]);
  if (!php.some((f) => vs.some((v) => v.namespaces.some((n) => f.source.includes(n.split("\\")[0]))))) return [];

  const usesOf = (src: string) => new Map([...src.matchAll(/^[ \t]*use\s+\\?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)].map((m) => [m[2] ?? m[1].split("\\").pop()!, m[1]] as [string, string]));
  const resolveName = (n: string, ns: string, uses: Map<string, string>): string => {
    const clean = n.replace(/^\?/, "");
    if (clean.startsWith("\\")) return clean.slice(1);
    const head = clean.split("\\")[0];
    if (uses.has(head)) return uses.get(head)! + clean.slice(head.length);
    const inNs = ns ? `${ns}\\${clean}` : clean;
    return known(inNs) ? inNs : clean;
  };
  /** The type an expression's call chain ends in, through vocabulary makers and resources (OpenAI::client($k), new X) */
  const exprType = (expr: string, ns: string, uses: Map<string, string>): string | undefined => {
    const nw = /^\s*new\s+(\\?[\w\\]+)\s*\(/.exec(expr);
    if (nw) {
      const t = resolveName(nw[1], ns, uses);
      return known(t) ? t : undefined;
    }
    const st = /^\s*(\\?[\w\\]+)::(\w+)\s*\(/.exec(expr);
    if (!st) return undefined;
    let t: string | undefined = resolveName(st[1], ns, uses);
    const segs = [`${st[2]}()`, ...[...expr.slice(st[0].length).matchAll(/->\s*(\w+)\s*(\()?/g)].map((m) => (m[2] ? `${m[1]}()` : m[1]))];
    for (const s of segs) {
      const next: string | undefined = vs.map((v) => v.types[t!]?.res[s]).find(Boolean);
      if (!next) break;
      t = next;
    }
    return t && t !== resolveName(st[1], ns, uses) && vs.some((v) => v.types[t!]) ? t : undefined;
  };

  // classes with their holders (property / method names that hold a client type)
  const classes: PClass[] = [];
  for (const f of php) {
    const ns = /^[ \t]*namespace\s+([\w\\]+)\s*;/m.exec(f.source)?.[1] ?? "";
    const uses = usesOf(f.source);
    for (const m of f.source.matchAll(/^[ \t]*(?:(?:final|abstract|readonly)\s+)*(?:class|trait)\s+(\w+)(?:\s+extends\s+(\\?[\w\\]+))?[^{]*\{/gm)) {
      const open = m.index! + m[0].length - 1;
      let depth = 0, end = f.source.length;
      for (let j = open; j < f.source.length; j++) {
        if (f.source[j] === "{") depth++;
        else if (f.source[j] === "}" && --depth === 0) { end = j; break; }
      }
      const body = f.source.slice(open, end);
      const c: PClass = { name: (ns ? `${ns}\\` : "") + m[1], parent: m[2] && resolveName(m[2], ns, uses), traits: [...body.matchAll(/^[ \t]*use\s+(\\?[\w\\]+)\s*;/gm)].map((t) => resolveName(t[1], ns, uses)), file: f.rel, ns, uses, start: open, end, holders: new Map() };
      // $this->x = <maker>
      for (const a of body.matchAll(/\$this->(\w+)\s*=\s*([^;]+);/g)) {
        const t = exprType(a[2], ns, uses);
        if (t) c.holders.set(a[1], t);
      }
      // typed properties and promoted constructor parameters
      for (const p of body.matchAll(/(?:private|protected|public)\s+(?:readonly\s+)?(\??\\?[\w\\]+)\s+\$(\w+)/g)) {
        const t = resolveName(p[1], ns, uses);
        if (known(t)) c.holders.set(p[2], t);
      }
      // constructor parameter typed as a client, assigned to $this->x
      for (const p of body.matchAll(/(\??\\?[\w\\]+)\s+\$(\w+)\s*[,)]/g)) {
        const t = resolveName(p[1], ns, uses);
        if (!known(t)) continue;
        const asg = new RegExp(`\\$this->(\\w+)\\s*=\\s*\\$${p[2]}\\s*;`).exec(body);
        if (asg) c.holders.set(asg[1], t);
      }
      // methods returning a client: by declared return type, or by returning a maker
      for (const fn of body.matchAll(/function\s+(\w+)\s*\(\s*\)\s*(?::\s*(\??\\?[\w\\]+))?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
        const t = (fn[2] && known(resolveName(fn[2], ns, uses)) ? resolveName(fn[2], ns, uses) : undefined) ?? exprType(/return\s+([^;]+);/.exec(fn[3])?.[1] ?? "", ns, uses);
        if (t) c.holders.set(`${fn[1]}()`, t);
      }
      classes.push(c);
    }
  }
  const byName = new Map(classes.map((c) => [c.name, c]));
  const bySimple = new Map<string, PClass[]>();
  for (const c of classes) bySimple.set(c.name.split("\\").pop()!, [...(bySimple.get(c.name.split("\\").pop()!) ?? []), c]);
  /** A parent or trait named in a class: as written, in the class's namespace, or the one repo class with that name */
  const ancestor = (c: PClass, a: string): PClass | undefined => {
    const one = bySimple.get(a.split("\\").pop()!) ?? [];
    return byName.get(a) ?? byName.get(c.ns ? `${c.ns}\\${a}` : a) ?? (one.length === 1 ? one[0] : undefined);
  };
  const holder = (c: PClass | undefined, name: string, depth = 0): string | undefined => {
    if (!c || depth > 5) return undefined;
    return c.holders.get(name) ?? [c.parent, ...c.traits].map((a) => holder(a ? ancestor(c, a) : undefined, name, depth + 1)).find(Boolean);
  };
  const walk = (t: string, segs: string[]): { op: string; v: Vocab; params?: string } | undefined => {
    for (const v of vs) {
      let cur: string | undefined = t;
      for (let i = 0; i < segs.length && cur; i++) {
        const vt: Vocab["types"][string] | undefined = v.types[cur];
        if (!vt) break;
        const plain = segs[i].replace(/\(\)$/, "");
        if (i === segs.length - 1 && segs[i].endsWith("()")) {
          const e = vt.methods[plain]?.[0];
          if (e) return { op: e.op, v, params: e.params };
          cur = undefined;
        } else cur = vt.res[segs[i]];
      }
    }
    return undefined;
  };

  const out: Usage[] = [];
  const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
  const near = new Map<string, number[]>();
  for (const u of found) near.set(`${u.file}|${u.op ?? ""}`, [...(near.get(`${u.file}|${u.op ?? ""}`) ?? []), u.line]);
  for (const f of php) {
    const ns = /^[ \t]*namespace\s+([\w\\]+)\s*;/m.exec(f.source)?.[1] ?? "";
    const uses = usesOf(f.source);
    const mine = classes.filter((c) => c.file === f.rel);
    const lineOf = (at: number) => f.source.slice(0, at).split("\n").length;
    const lines = f.source.split("\n");
    // receivers: $this->x / $this->x() / $local / Static:: … followed by a ->chain(…)
    for (const m of f.source.matchAll(/(\$this->\w+(?:\(\))?|\$\w+|\\?[A-Z][\w\\]*::\w+\(\))((?:\s*->\s*\w+(?:\s*\(\s*\))?)*)\s*->\s*(\w+)\s*\(/g)) {
      const at = m.index!;
      const c = mine.filter((x) => x.start <= at && at <= x.end).sort((a, b) => b.start - a.start)[0];
      let type: string | undefined, segs: string[];
      const rest = [...m[2].matchAll(/->\s*(\w+)\s*(\(\s*\))?/g)].map((s) => (s[2] ? `${s[1]}()` : s[1]));
      if (m[1].startsWith("$this->")) {
        const name = m[1].slice(7).replace(/\s+/g, "");
        type = holder(c, name);
        segs = [...rest, `${m[3]}()`];
      } else if (m[1].startsWith("$")) {
        // a local set from a maker earlier in the file (the nearest assignment above)
        const before = f.source.slice(Math.max(0, at - 4000), at);
        const asg = [...before.matchAll(new RegExp(`\\${m[1]}\\s*=\\s*([^;]+);`, "g"))].pop();
        type = asg ? exprType(asg[1], ns, uses) : undefined;
        segs = [...rest, `${m[3]}()`];
      } else {
        // a static facade or factory: Facade::chat()->create(…)
        const st = /^(\\?[\w\\]+)::(\w+)\(\)$/.exec(m[1])!;
        const cands = [resolveName(st[1], ns, uses), ...vs.flatMap((v) => Object.keys(v.clients).filter((k) => k.split("\\").pop() === st[1].replace(/^\\/, "")))];
        type = cands.find((t) => vs.some((v) => v.types[t]?.res[`${st[2]}()`]));
        segs = [`${st[2]}()`, ...rest, `${m[3]}()`];
      }
      if (!type) continue;
      const hit = walk(type, segs);
      if (!hit) continue;
      const line = lineOf(at + m[0].length - 1);
      const key = `${f.rel}|${hit.op}`;
      if ((near.get(key) ?? []).some((x) => Math.abs(x - line) <= 3)) continue;
      near.set(key, [...(near.get(key) ?? []), line]);
      const base: Usage = {
        provider: hit.v.provider, kind: "sdk", lang: "php", file: f.rel, line, op: hit.op, confidence: "likely", sdkCall: [...segs].join("->"),
        snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `${m[1]} holds a ${type} (${hit.v.package}); ${segs.join("->")} sends ${hit.op}`,
      };
      out.push(base);
      // arguments: top-level array keys, or named arguments mapped through the params type
      const argStart = at + m[0].length;
      let depth = 1, j = argStart;
      for (; j < Math.min(f.source.length, argStart + 20000) && depth > 0; j++) {
        const ch = f.source[j];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
      }
      const args = f.source.slice(argStart, j - 1);
      const fields = hit.params ? vs.map((v) => v.paramTypes[hit.params!]?.fields).find(Boolean) : undefined;
      let d = 0;
      for (let k = 0; k < args.length; k++) {
        const ch = args[k];
        if (ch === "(" || ch === "[" || ch === "{") d++;
        else if (ch === ")" || ch === "]" || ch === "}") d--;
        const key2 = /^['"]([a-z_][\w]*)['"]\s*=>/.exec(args.slice(k, k + 60));
        const named = /^([a-zA-Z_]\w*)\s*:(?!:)/.exec(args.slice(k, k + 60));
        const prev = args[k - 1] ?? "(";
        let wire: string | undefined;
        if (key2 && d === 1 && /[\s[,(]/.test(prev)) wire = key2[1];
        else if (named && d === 0 && /[\s,(]/.test(prev)) wire = fields?.[named[1]] ?? snake(named[1]);
        if (!wire) continue;
        const l = lineOf(argStart + k);
        if (have.has(`${f.rel}|${l}|${wire}`)) continue;
        out.push({ ...base, line: l, params: [wire], snippet: (lines[l - 1] ?? "").trim().slice(0, 200), reason: `${wire} in ${base.reason}` });
        k += (key2?.[0] ?? named?.[0] ?? "").length - 1;
      }
    }
  }
  return out;
}
