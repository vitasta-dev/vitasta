/**
 * Per-language syntax for the value tracer (src/scan/flow.ts): how each language declares classes, functions,
 * fields, constants and locals, writes literals, object initializers and builder calls, passes arguments, reads
 * configuration and builds URLs. Syntax only: nothing here names an SDK or a provider.
 */
type At = { at: number; expr: string };
export interface LangSyntax {
  self: string[];
  implicitFields: boolean;
  classes(src: string): { name: string; start: number; end: number; parent?: string; supers?: string[] }[];
  functions(src: string): { cls?: string; name: string; params: { name: string; type?: string; def?: string }[]; start: number; end: number; recv?: { name: string; type: string } }[];
  localType(scope: string, id: string): string | undefined;
  fieldType(classBody: string, id: string): string | undefined;
  fieldInits(classBody: string, field: string): At[];
  selfAssigns(classBody: string, field: string): At[];
  annotationDefaults(classBody: string, field: string): At[];
  literals(src: string, type: string, field: string): At[];
  memberAssigns(src: string, field: string): (At & { recv?: string; how: string })[];
  returns(body: string): At[];
  constDecls(scope: string, name: string): At[];
  localAssigns(scope: string, id: string): At[];
  callArgs(src: string, name: string): { at: number; args: { text: string; at: number }[]; named: Map<string, { text: string; at: number }> }[];
  flagDefaults(src: string, id: string): (At & { flag: string })[];
  clean(e: string): string;
  literal(e: string): string | undefined;
  alternatives(e: string): string[];
  unwrap(e: string): string;
  configRead(e: string): { key?: string; def?: string } | undefined;
  construct(e: string): string | undefined;
  getter(e: string): { recv?: string; method: string; field: string } | undefined;
  member(e: string): { recv: string; field: string } | undefined;
  settingValue(line: string, wire: string): string | undefined;
  urlBuilds(src: string): { at: number; parts: { lit?: string; expr: string }[] }[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const camel = (w: string) => w.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = (w: string) => camel(w).replace(/^./, (c) => c.toUpperCase());
const lcFirst = (w: string) => w.replace(/^./, (c) => c.toLowerCase());

/** Matching close for an opening bracket at `open`, skipping strings and comments (brace languages) */
function closeOf(src: string, open: number, limit = 400_000): number {
  const o = src[open], c = o === "{" ? "}" : o === "(" ? ")" : "]";
  let d = 0;
  for (let i = open; i < Math.min(src.length, open + limit); i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j; continue; }
    if (ch === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? src.length : j + 1; continue; }
    if (ch === o) d++;
    else if (ch === c && --d === 0) return i;
  }
  return -1;
}
/** Top-level comma split of an argument string, with offsets */
function splitArgs(s: string, base: number): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let d = 0, from = 0, q: string | undefined;
  for (let i = 0; i <= s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === "\\") i++; else if (ch === q) q = undefined; continue; }
    if (ch === '"' || ch === "'" || ch === "`") q = ch;
    else if (ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ")" || ch === "]" || ch === "}") d--;
    if ((ch === "," && d === 0) || i === s.length) { out.push({ text: s.slice(from, i), at: base + from }); from = i + 1; }
  }
  return out.filter((a) => a.text.trim());
}
/** The value after a position: up to a top-level `,` `;` newline or an unmatched closer */
function valueAt(src: string, from: number): string {
  let d = 0, q: string | undefined, i = from;
  for (; i < Math.min(src.length, from + 2000); i++) {
    const ch = src[i];
    if (q) { if (ch === "\\") i++; else if (ch === q) q = undefined; continue; }
    if (ch === '"' || ch === "'" || ch === "`") q = ch;
    else if (ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ")" || ch === "]" || ch === "}") { if (d === 0) break; d--; }
    else if ((ch === "," || ch === ";") && d === 0) break;
    else if (ch === "\n" && d === 0) {
      // a line break ends the value unless the expression visibly goes on (an operator at the end of this line, or
      // a .method / + / ? / : / && / || at the start of the next)
      const before = src.slice(from, i).trimEnd();
      const after = src.slice(i + 1, i + 200).trimStart();
      if (!before || /[=+.(,?:&|]$/.test(before)) continue;
      if (/^(?:\.(?!\.)|\+|\?|:(?!:)|&&|\|\|)/.test(after)) continue;
      break;
    }
  }
  return src.slice(from, i).trim();
}
const all = (src: string, re: RegExp, f: (m: RegExpMatchArray) => At | undefined): At[] => [...src.matchAll(re)].map(f).filter((x): x is At => !!x && !!x.expr);

/** Shared expression syntax (C-family, Python and Ruby differences handled where they appear) */
const common = {
  clean(e: string): string {
    // comments out (// and # outside strings), then await / return
    let s = "";
    for (let i = 0, q: string | undefined; i < e.length; i++) {
      const ch = e[i];
      if (q) { s += ch; if (ch === "\\") { s += e[i + 1] ?? ""; i++; } else if (ch === q) q = undefined; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { q = ch; s += ch; continue; }
      if ((ch === "/" && e[i + 1] === "/") || (ch === "#" && e[i + 1] !== "{" && e[i + 1] !== "[")) { const j = e.indexOf("\n", i); if (j < 0) break; i = j - 1; continue; }
      s += ch;
    }
    s = s.replace(/^\s*(?:await|return)\s+/, "");
    let d = 0;
    for (let q = 0; q < s.length; q++) {
      const ch = s[q];
      if (ch === "(" || ch === "{" || ch === "[") d++;
      else if (ch === ")" || ch === "}" || ch === "]") { if (d === 0) { s = s.slice(0, q); break; } d--; }
    }
    return s.replace(/[\s;,]+$/, "").trim();
  },
  literal(e: string): string | undefined {
    const s = /^(?:[rbuf]?)(["'`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(e);
    if (s && !/\$\{|\{\w/.test(s[2])) return s[2];
    if (/^-?\d+(?:\.\d+)?[fFdDmMlL]?$/.test(e)) return e.replace(/[fFdDmMlL]$/, "");
    return undefined;
  },
  alternatives(e: string): string[] {
    // top-level a ? b : c / a ?? b / a ?: b / a || b / a or b
    let d = 0, q: string | undefined;
    for (let i = 0; i < e.length; i++) {
      const ch = e[i];
      if (q) { if (ch === "\\") i++; else if (ch === q) q = undefined; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") d++;
      else if (ch === ")" || ch === "]" || ch === "}") d--;
      if (d) continue;
      if (e.startsWith("??", i) || e.startsWith("?:", i) || e.startsWith("||", i)) return [e.slice(0, i), e.slice(i + 2)].map((x) => x.trim());
      if (/^\sor\s/.test(e.slice(i - 1, i + 3))) return [e.slice(0, i), e.slice(i + 2)].map((x) => x.trim());
      if (ch === "?" && e[i + 1] !== "." && e[i + 1] !== "?") {
        let k = i + 1, dd = 0;
        for (; k < e.length; k++) {
          if (e[k] === "(" || e[k] === "[") dd++;
          else if (e[k] === ")" || e[k] === "]") dd--;
          else if (e[k] === ":" && dd === 0 && e[k + 1] !== ":") break;
        }
        if (k < e.length) return [e.slice(i + 1, k), e.slice(k + 1)].map((x) => x.trim());
      }
    }
    const py = /^(.+?)\s+if\s+.+?\s+else\s+(.+)$/.exec(e);
    if (py) return [py[1], py[2]];
    return [e];
  },
  unwrap(e: string): string {
    let s = e.trim();
    for (let k = 0; k < 4; k++) {
      const before = s;
      s = s.replace(/^\(\s*(?:double|float|int|long|decimal|float32|float64|Double|Float|Integer|Long)\s*\)\s*/, "");
      s = s.replace(/!$/, "").replace(/\.(?:Value|toString\(\)|ToString\(\)|doubleValue\(\)|floatValue\(\))$/, "");
      // a wrapper call with the value as its first argument: Float(x), float64(x), Optional.of(x),
      // Objects.requireNonNull(x, "…"), anthropic.Float(x), JsonValue.from(x), float(x), str(x)
      const w = /^(?:[A-Za-z_][\w]*\.)*[A-Za-z_]\w*\s*\(([\s\S]*)\)$/.exec(s);
      if (w) {
        const a = splitArgs(w[1], 0);
        if (a.length >= 1 && /^(?:[a-z]\w*\.)*(?:[A-Z]\w*\.)?(?:Float|Double|Int|Int64|Int32|Float32|Float64|Bool|String|Opt|of|ofNullable|from|requireNonNull|valueOf|parse\w*|float|int|str|Number|Decimal|NewOpt|F|Ptr|cast\w*|toDouble|toFloat|\w*Model(?:Name|Id|ID)?)$/.test(s.slice(0, s.indexOf("(")).trim().split(".").pop()!)) s = a[0].text.trim();
        else if (a.length === 1 && /^(?:float32|float64|int|int32|int64|double|decimal)$/.test(s.slice(0, s.indexOf("(")).trim())) s = a[0].text.trim();
      }
      if (s === before) break;
    }
    return s;
  },
  configRead(e: string): { key?: string; def?: string } | undefined {
    const m = /^(?:[\w$]+(?:\.|->|::))*(get|getOrDefault|getProperty|getenv|getValue|GetValue(?:<[^>]+>)?|env|config|optional|fetch|Get|GetEnvironmentVariable)\s*\(([\s\S]*)\)$/.exec(e);
    if (!m) return undefined;
    const a = splitArgs(m[2], 0).map((x) => x.text.trim());
    if (!a.length) return undefined;
    const recv = e.slice(0, e.indexOf(m[1])).replace(/(?:\.|->|::)$/, "");
    // only configuration-like receivers for a bare get(): config, cfg, conf, options, props, environ, settings, ReadonlyConfig
    if (m[1] === "get" && !/(?:conf|cfg|config|option|props|properties|environ|settings|env)/i.test(recv)) return undefined;
    return { key: a[0], def: a.length > 1 ? a[a.length - 1] : undefined };
  },
  construct(e: string): string | undefined {
    const m = /^(?:new\s+)?(?:[\w.]+\.)?[A-Z]\w*\s*\(\s*(["'][^"']*["'])\s*\)$/.exec(e);
    return m?.[1];
  },
  getter(e: string): { recv?: string; method: string; field: string } | undefined {
    const m = /^(?:([\w$]+)\s*(?:\.|->|::|\?\.)\s*)?((?:get|Get|is)([A-Z]\w*))\s*\(\s*\)$/.exec(e);
    if (m) return { recv: m[1], method: m[2], field: lcFirst(m[3]) };
    const r = /^([\w$]+)\s*\.\s*([a-z]\w*)\s*\(\s*\)$/.exec(e);
    if (r && !/^(?:trim|toLowerCase|toUpperCase|length|size|build|get)$/.test(r[2])) return { recv: r[1], method: r[2], field: r[2] };
    return undefined;
  },
  member(e: string): { recv: string; field: string } | undefined {
    const m = /^(?:\$)?([\w$]+)\s*(?:\.|->|::)\s*\$?([A-Za-z_]\w*)$/.exec(e);
    if (m) return { recv: m[1], field: m[2] };
    // a key of an array / dict / map: $options['temperature'], opts["top_p"]
    const k = /^(?:\$)?([A-Za-z_]\w*)\s*\[\s*["']([A-Za-z_]\w*)["']\s*\]$/.exec(e);
    if (k) return { recv: k[1], field: k[2] };
    const iv = /^@([a-z_]\w*)$/.exec(e);
    if (iv) return { recv: "self", field: iv[1] };
    return undefined;
  },
  settingValue(line: string, wire: string): string | undefined {
    // a tuple assignment (a.X, a.Y = u.X, u.Y) pairs values by position: not read
    if (/^\s*[\w$.\[\]]+\s*,\s*[\w$.\[\]]+[^=]*=(?!=)/.test(line)) return undefined;
    const forms = [...new Set([wire, camel(wire), pascal(wire)])].map(esc).join("|");
    const pats = [
      new RegExp(`["'](?:${forms})["']\\s*(?:=>|:|,)\\s*(.+)$`),
      new RegExp(`\\.(?:set|with|With|Set)?(?:${forms})\\s*\\((.+)$`, "i"),
      new RegExp(`(?<![\\w$])(?:${forms})\\s*(?::(?!:)|=(?![=>]))\\s*(.+)$`),
      // Ruby: params[:temperature] = x, :temperature => x
      new RegExp(`\\[\\s*:(?:${forms})\\s*\\]\\s*(?:\\|\\|)?=(?![=>])\\s*(.+)$`),
      // PHP / JS / Python: $body['temperature'] = x, body["temperature"] = x
      new RegExp(`\\[\\s*["'](?:${forms})["']\\s*\\]\\s*(?:\\?\\?|\\|\\|)?=(?![=>])\\s*(.+)$`),
      new RegExp(`(?<![\\w$]):(?:${forms})\\s*=>\\s*(.+)$`),
    ];
    for (const p of pats) {
      const m = p.exec(line);
      if (m) {
        // (a Ruby statement modifier, `x if cond`, isn't part of the value)
        const v = common.clean(valueAt(m[1], 0)).replace(/\s+(?:if|unless)\s+.*$/, "");
        if (v) return v;
      }
    }
    return undefined;
  },
  urlBuilds(src: string): { at: number; parts: { lit?: string; expr: string }[] }[] {
    const out: { at: number; parts: { lit?: string; expr: string }[] }[] = [];
    // "https://host/…" + a + "/…" (Java, C#, Go, TS, Python, PHP with .)
    // (a dot joins strings only in PHP; elsewhere it is member access: cfg.Version stays one part)
    const dot = !(this as { noDotConcat?: boolean } | undefined)?.noDotConcat;
    const joined = dot ? /(["'])(https?:\/\/[\w.-]+\/?[^"'\n]*)\1((?:\s*(?:\+|\.(?!\w))\s*(?:["'][^"'\n]*["']|[\w$.>()\-]+(?:\([^()\n]*\))?))+)/g : /(["'])(https?:\/\/[\w.-]+\/?[^"'\n]*)\1((?:\s*\+\s*(?:["'][^"'\n]*["']|[\w$.>()\-]+(?:\([^()\n]*\))?))+)/g;
    for (const m of src.matchAll(joined)) {
      const parts: { lit?: string; expr: string }[] = [{ lit: m[2], expr: m[0] }];
      for (const p of m[3].split(dot ? /\s*(?:\+|\.(?=\s*["'$\w]))\s*/ : /\s*\+\s*/).filter(Boolean)) {
        const l = /^["']([^"']*)["']$/.exec(p.trim());
        parts.push(l ? { lit: l[1], expr: p } : { expr: p.trim() });
      }
      if (parts.some((p) => p.lit === undefined)) out.push({ at: m.index!, parts });
    }
    // a + "/" + b … with no literal URL, where a part is named like a URL piece (baseUrl, endpoint, apiVersion, host):
    // the parts are evaluated (the endpoint and the version may both come from configuration defaults)
    for (const m of src.matchAll(/(?<![\w$."'])((?:[\w$]+(?:\s*(?:\.|->)\s*[\w$]+)*(?:\(\s*\))?)(?:\s*\+\s*(?:["'][^"'\n]*["']|[\w$]+(?:\s*(?:\.|->)\s*[\w$]+)*(?:\(\s*\))?))+)/g)) {
      const raw = m[1];
      const parts = raw.split(/\s*\+\s*/).map((p) => p.trim());
      if (parts.length < 3 || !parts.some((p) => /^["']\/?[\w./-]*["']$/.test(p)) || !parts.some((p) => /(?:url|uri|endpoint|host|base|version)/i.test(p) && !/^["']/.test(p))) continue;
      if (/^["']https?:/.test(parts[0])) continue;
      out.push({ at: m.index!, parts: parts.map((p) => { const l = /^["']([^"']*)["']$/.exec(p); return l ? { lit: l[1], expr: p } : { expr: p }; }) });
    }
    // template strings `https://host/${a}/`, $"https://host/{a}/", f"https://host/{a}/", "https://host/{$a}/"
    for (const m of src.matchAll(/(?:\$|f)?(["'`])(https?:\/\/[\w.-]+\/[^"'`\n]*?(?:\$\{[^}]+\}|\{\$?[\w.\->()]+\})[^"'`\n]*)\1/g)) {
      const parts: { lit?: string; expr: string }[] = [];
      let last = 0;
      for (const v of m[2].matchAll(/\$\{([^}]+)\}|\{\$?([\w.\->()]+)\}/g)) {
        parts.push({ lit: m[2].slice(last, v.index!), expr: "" });
        parts.push({ expr: (v[1] ?? v[2]).trim() });
        last = v.index! + v[0].length;
      }
      parts.push({ lit: m[2].slice(last), expr: "" });
      out.push({ at: m.index!, parts });
    }
    return out;
  },
};

/** C-family helpers: assignments, member writes, call arguments */
const cfam = {
  returns(body: string): At[] {
    return all(body, /\breturn\s+([^;\n]+)/g, (m) => ({ at: m.index!, expr: m[1] }));
  },
  localAssigns(scope: string, id: string): At[] {
    return all(scope, new RegExp(`(?<![\\w.$>])(?:(?:var|let|const|final|val|auto|[A-Z][\\w<>,.?\\[\\]]*|int|long|double|float|bool|boolean|string|decimal)\\s+)?\\$?${esc(id)}\\s*(?::=|=(?![=>]))`, "g"), (m) => ({ at: m.index!, expr: valueAt(scope, m.index! + m[0].length) }));
  },
  memberAssigns(src: string, field: string): (At & { recv?: string; how: string })[] {
    const out: (At & { recv?: string; how: string })[] = [];
    if (/^(?:null|this|self|true|false|class|new|String|Object|super|base)$/.test(field)) return out;
    /** the identifier just before position i (skipping spaces): the receiver */
    const recvBefore = (i: number) => {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      let k = j;
      while (k >= 0 && /[\w$]/.test(src[k])) k--;
      return k < j ? { name: src.slice(k + 1, j + 1), at: k + 1 } : undefined;
    };
    // recv.field = …  /  $recv->field = …
    for (const m of src.matchAll(new RegExp(`(?:\\.|->)\\s*\\$?${esc(field)}\\s*=(?![=>])`, "g"))) {
      if (!/[\w$]/.test(src[m.index! + m[0].length - 1 - (m[0].length - m[0].trimEnd().length)] ?? "")) { /* keep */ }
      const r = recvBefore(m.index!);
      if (!r) continue;
      out.push({ at: r.at, expr: valueAt(src, m.index! + m[0].length), recv: r.name.replace(/^\$/, ""), how: `${r.name}.${field} =` });
    }
    // recv.setField(…) / builder .field(…), one argument
    for (const m of src.matchAll(new RegExp(`\\.\\s*(?:set${esc(pascal(field))}|${esc(field)})\\s*\\(`, "g"))) {
      const open = m.index! + m[0].length - 1;
      const close = closeOf(src, open, 4000);
      if (close < 0) continue;
      const args = splitArgs(src.slice(open + 1, close), open + 1);
      if (args.length !== 1) continue;
      const r = recvBefore(m.index!);
      // a builder chain with no receiver name: its root type (T.builder() / new T.Builder() / new T(…)) stands in,
      // as "#Type", so the caller can check it against the field's type
      let recv = r?.name;
      if (!recv) {
        const stmt = src.slice(Math.max(0, m.index! - 3000), m.index!);
        const cut = Math.max(stmt.lastIndexOf(";"), stmt.lastIndexOf("{\n"), stmt.lastIndexOf("}\n"));
        const chain = stmt.slice(cut + 1);
        const root = [...chain.matchAll(/(?:new\s+)?([A-Z][\w]*)(?:\.Builder)?\s*(?:\.\s*(?:builder|newBuilder|toBuilder|create)\s*)?\(/g)].shift()?.[1];
        recv = root ? `#${root}` : "#?";
      }
      out.push({ at: r?.at ?? m.index!, expr: args[0].text.trim(), recv, how: `.${field}(…)` });
    }
    return out;
  },
  callArgs(src: string, name: string) {
    const out: { at: number; args: { text: string; at: number }[]; named: Map<string, { text: string; at: number }> }[] = [];
    // the name followed by "(", not part of a longer identifier: found by plain search, checked by hand
    for (const m of src.matchAll(new RegExp(`${esc(name)}\\s*\\(`, "g"))) {
      if (/[\w$]/.test(src[m.index! - 1] ?? "")) continue;
      const open = m.index! + m[0].length - 1;
      const close = closeOf(src, open, 8000);
      if (close < 0) continue;
      const args = splitArgs(src.slice(open + 1, close), open + 1);
      const named = new Map<string, { text: string; at: number }>();
      for (const a of args) {
        const n = /^\s*\$?([A-Za-z_]\w*)\s*(?::(?!:)|=(?!=))\s*([\s\S]+)$/.exec(a.text);
        if (n && !/^\s*["']/.test(a.text)) named.set(n[1], { text: n[2], at: a.at + a.text.indexOf(n[2]) });
      }
      out.push({ at: m.index!, args, named });
    }
    return out;
  },
  literals(src: string, type: string, field: string): At[] {
    const out: At[] = [];
    // T{ Field: v } (Go), new T { Field = v } / new T(...) { Field = v } (C#), new T({ field: v }) (TS), T(field=v) (Python), new T(field: v) (PHP, C# named)
    // the type's name, then (optionally) a balanced argument list and generic args, then a `{`: no regex backtracking
    for (const m of src.matchAll(new RegExp(`(?<![\\w$])${esc(type)}\\b`, "g"))) {
      let j = m.index! + m[0].length;
      while (/\s/.test(src[j] ?? "")) j++;
      if (src[j] === "<") { const c = src.indexOf(">", j); if (c < 0 || c - j > 200) continue; j = c + 1; while (/\s/.test(src[j] ?? "")) j++; }
      if (src[j] === "(") { const c = closeOf(src, j, 4000); if (c < 0) continue; j = c + 1; while (/\s/.test(src[j] ?? "")) j++; }
      if (src[j] !== "{") continue;
      const open = j;
      const close = closeOf(src, open);
      if (close < 0) continue;
      const body = src.slice(open + 1, close);
      if (!body.includes(field) && !body.includes(pascal(field))) continue;
      for (const a of splitArgs(body, open + 1)) {
        const k = new RegExp(`^\\s*["']?(?:${esc(field)}|${esc(pascal(field))})["']?\\s*(?::(?!:)|=(?![=>]))\\s*([\\s\\S]+)$`).exec(a.text);
        if (k) out.push({ at: a.at + a.text.indexOf(k[1]) - 1, expr: k[1].trim() });
      }
    }
    for (const c of cfam.callArgs(src, type)) {
      const n = c.named.get(field) ?? c.named.get(pascal(field));
      if (n) out.push({ at: n.at, expr: n.text.trim() });
    }
    return out;
  },
  constDecls(scope: string, name: string): At[] {
    const out: At[] = [];
    // static final T NAME = v; const T NAME = v; static readonly T NAME = v; const NAME = v; NAME = v (Go const groups, enums)
    for (const m of scope.matchAll(new RegExp(`(?:^|[\\s(,;{])(?:(?:public|private|protected|internal|static|final|const|readonly|export|let|var|val)\\s+)*(?:[\\w<>,.?\\[\\]]+\\s+)?${esc(name)}\\s*(?::\\s*[\\w<>.\\[\\]|]+\\s*)?=(?![=>])`, "gm")))
      out.push({ at: m.index!, expr: valueAt(scope, m.index! + m[0].length) });
    // enum constant NAME("v25.0", …) / NAME = "x" in an enum
    for (const m of scope.matchAll(new RegExp(`(?:^|[\\s,{])${esc(name)}\\s*\\(\\s*(["'][^"']*["'])`, "gm"))) out.push({ at: m.index!, expr: m[1] });
    // define('NAME', v)
    for (const m of scope.matchAll(new RegExp(`define\\(\\s*["']${esc(name)}["']\\s*,\\s*`, "g"))) out.push({ at: m.index!, expr: valueAt(scope, m.index! + m[0].length) });
    return out;
  },
};

function braceClasses(re: RegExp) {
  return (src: string) => {
    const out: { name: string; start: number; end: number; parent?: string; supers?: string[] }[] = [];
    for (const m of src.matchAll(re)) {
      const open = src.indexOf("{", m.index! + m[0].length - 1);
      if (open < 0) continue;
      const close = closeOf(src, open);
      // every type named in the header after the class name: extends / implements / : supertypes
      const header = src.slice(m.index! + m[0].indexOf(m[1]) + m[1].length, open).replace(/<[^>]*>/g, "");
      const supers = [...header.matchAll(/\b([A-Z]\w*)\b/g)].map((x) => x[1]).filter((x) => x !== m[1]);
      out.push({ name: m[1], start: open, end: close < 0 ? src.length : close, parent: m[2], supers });
    }
    return out;
  };
}
type Param = { name: string; type?: string; def?: string };
function params(list: string, style: "name-type" | "type-name" | "py"): Param[] {
  return splitArgs(list, 0).map((a): Param | undefined => {
    const t = a.text.trim().replace(/^(?:final|readonly|private|public|protected|ref|out|in|params|this|\.\.\.)\s+/g, "").replace(/^@\w+(?:\([^)]*\))?\s+/g, "");
    const [decl, def] = t.split(/\s*=(?!=)\s*/, 2);
    if (style === "name-type") {
      const m = /^\$?(\w+)\s*(?::\s*)?([\w.*\[\]<>|?\\]+)?/.exec(decl);
      return m ? { name: m[1], type: m[2], def } : undefined;
    }
    if (style === "py") {
      const m = /^\*{0,2}(\w+)\s*(?::\s*([\w.\[\], |]+))?/.exec(decl);
      return m ? { name: m[1], type: m[2]?.trim(), def } : undefined;
    }
    const m = /^(?:([\w.<>,?\[\]\\]+)\s+)?\$?(\w+)$/.exec(decl.replace(/\s+/g, " ").replace(/<[^>]*>/g, (x) => x.replace(/\s/g, "")));
    return m ? { name: m[2], type: m[1], def } : undefined;
  }).filter((x): x is Param => !!x);
}
function braceFunctions(re: RegExp, style: "name-type" | "type-name", recvGroup = false) {
  return (src: string) => {
    const out: ReturnType<LangSyntax["functions"]> = [];
    for (const m of src.matchAll(re)) {
      // control statements and calls are never function declarations
      if (/^(?:if|for|foreach|while|switch|catch|synchronized|try|else|do|return|new|using|lock|fixed|when|elseif|function)$/.test(recvGroup ? m[3] : m[1])) continue;
      const po = m.index! + m[0].length - 1;
      const pc = closeOf(src, po, 8000);
      if (pc < 0) continue;
      const open = src.indexOf("{", pc);
      if (open < 0 || /[;]/.test(src.slice(pc, open)) || src.slice(pc, open).length > 300) continue;
      const close = closeOf(src, open);
      out.push({
        name: recvGroup ? m[3] : m[1], params: params(src.slice(po + 1, pc), style), start: open, end: close < 0 ? src.length : close,
        ...(recvGroup && m[1] ? { recv: { name: m[1], type: m[2].replace(/^\*/, "") } } : {}),
      });
    }
    return out;
  };
}

const java = {
  ...common, ...cfam, self: ["this"], implicitFields: true,
  classes: braceClasses(/\b(?:class|record|enum|interface|object)\s+(\w+)(?:\s*\([^)]*\))?(?:\s+extends\s+([\w.]+))?[^{;]*\{/g),
  functions: braceFunctions(/(?:^|\n)[ \t]*(?:(?:public|private|protected|static|final|abstract|synchronized|override|suspend|fun|default|@\w+(?:\([^)]*\))?)\s+)*(?:<[^<>(){};=]*(?:<[^<>(){};=]*>[^<>(){};=]*)*>\s+)?(?:[\w<>,.?\[\]]+\s+)?(\w+)\s*\(/g, "type-name"),
  localType: (scope: string, id: string) => new RegExp(`\\b([A-Z][\\w<>,.]*)\\s+${esc(id)}\\s*[=;:]`).exec(scope)?.[1] ?? new RegExp(`\\b(?:var|val)\\s+${esc(id)}\\s*=\\s*new\\s+([\\w.]+)`).exec(scope)?.[1],
  fieldType: (b: string, id: string) => new RegExp(`(?:private|protected|public|final|static|\\s)\\s*([A-Z][\\w<>,.]*)\\s+${esc(id)}\\s*[=;]`).exec(b)?.[1],
  fieldInits: (b: string, f: string) => all(b, new RegExp(`(?:private|protected|public|final|static|\\s)\\s*[\\w<>,.?\\[\\]]+\\s+${esc(f)}\\s*=(?!=)`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  selfAssigns: (b: string, f: string) => all(b, new RegExp(`\\bthis\\.${esc(f)}\\s*=(?!=)`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  annotationDefaults: (b: string, f: string) => [
    ...all(b, new RegExp(`@Value\\(\\s*"\\$\\{[^:}]+:([^}]*)\\}"\\s*\\)[\\s\\S]{0,120}?\\b${esc(f)}\\s*[;=]`, "g"), (m) => ({ at: m.index!, expr: JSON.stringify(m[1]) })),
    ...all(b, new RegExp(`defaultValue\\s*=\\s*("[^"]*")[\\s\\S]{0,160}?\\b${esc(f)}\\s*[;=]`, "g"), (m) => ({ at: m.index!, expr: m[1] })),
  ],
  flagDefaults: () => [],
};
const csharp = {
  ...java,
  classes: braceClasses(/\b(?:class|record|struct|interface)\s+(\w+)(?:\s*\([^)]*\))?(?:\s*:\s*([\w.]+))?[^{;]*\{/g),
  fieldType: (b: string, id: string) => new RegExp(`\\b([A-Z][\\w<>,.?]*)\\??\\s+${esc(id)}\\s*(?:[=;{])`).exec(b)?.[1],
  fieldInits: (b: string, f: string) => [
    ...all(b, new RegExp(`[\\w<>,.?\\[\\]]+\\s+${esc(f)}\\s*=(?![=>])`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
    ...all(b, new RegExp(`\\b${esc(f)}\\s*\\{\\s*get;[^}]*\\}\\s*=\\s*`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  ],
  selfAssigns: (b: string, f: string) => all(b, new RegExp(`(?:\\bthis\\.|(?<![\\w.]))${esc(f)}\\s*=(?![=>])`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  annotationDefaults: () => [],
};

/** Tag keys that give a struct field's default value in the common Go configuration libraries */
const GO_DEFAULT_TAGS = ["envDefault", "default", "env-default"];
function goTagDefaults(body: string, field: string): At[] {
  const out: At[] = [];
  for (const m of body.matchAll(new RegExp(`^[ \\t]*${esc(field)}[ \\t]+[^\\n\`]*?\`([^\`\\n]*)\``, "gm"))) {
    const tagStart = m.index! + m[0].lastIndexOf("`", m[0].length - 2) + 1;
    for (const key of GO_DEFAULT_TAGS) {
      const t = new RegExp(`(?:^|\\s)${esc(key)}:"((?:\\\\.|[^"\\\\])*)"`).exec(m[1]);
      if (t) out.push({ at: tagStart + t.index + t[0].indexOf('"'), expr: `"${t[1]}"` });
    }
  }
  return out;
}
const goNorm = (w: string) => w.replace(/[_-]/g, "").toLowerCase();
function goViperDefaults(src: string, field: string): { at: number; expr: string; recv?: string; how: string }[] {
  if (!src.includes("SetDefault")) return [];
  // the keys this field goes by: its own name, and its mapstructure / yaml / json / koanf / toml tag
  const keys = new Set([goNorm(field)]);
  for (const m of src.matchAll(new RegExp(`^[ \\t]*${esc(field)}[ \\t]+[^\\n\`]*?\`([^\`\\n]*)\``, "gm"))) {
    for (const t of m[1].matchAll(/(?:mapstructure|yaml|json|koanf|toml):"([^",]+)/g)) keys.add(goNorm(t[1]));
  }
  const out: { at: number; expr: string; how: string }[] = [];
  for (const m of src.matchAll(/\bSetDefault\(\s*"([^"]+)"\s*,\s*/g)) {
    const last = m[1].split(".").pop()!;
    if (keys.has(goNorm(last))) out.push({ at: m.index!, expr: valueAt(src, m.index! + m[0].length), how: `SetDefault("${m[1]}")` });
  }
  return out;
}
const go = {
  ...common, ...cfam, self: [], implicitFields: false, noDotConcat: true,
  classes: braceClasses(/^type\s+(\w+)\s+struct\s*\{/gm),
  functions: braceFunctions(/^func\s+(?:\((\w+)\s+\*?([\w.]+)\)\s+)?(\w+)\s*\(/gm, "name-type", true),
  localType: (scope: string, id: string) => new RegExp(`\\b${esc(id)}\\s*:?=\\s*&?(?:\\w+\\.)?([A-Z]\\w*)\\s*\\{`).exec(scope)?.[1] ?? new RegExp(`\\b${esc(id)}\\s*(?:,\\s*\\w+\\s*)?:?=\\s*(?:new\\(\\s*(?:\\w+\\.)?([A-Z]\\w*)\\s*\\)|(?:\\w+\\.)?\\w*(?:Parse\\w*|Load\\w*|Unmarshal\\w*|Must\\w*)\\[\\*?(?:\\w+\\.)?([A-Z]\\w*)\\]\\()`).exec(scope)?.slice(1).find(Boolean) ?? new RegExp(`\\bvar\\s+${esc(id)}\\s+\\*?(?:\\w+\\.)?([A-Z]\\w*)`).exec(scope)?.[1] ?? [...scope.matchAll(/func\s*\(([^)]*)\)/g)].reverse().map((l) => new RegExp(`(?:^|,)\\s*${esc(id)}\\s+\\*?([\\w.]+)`).exec(l[1])?.[1]).find(Boolean),
  // a struct field's type (Go puts it after the name): OpenAI OpenAIConfig, Cfg *LLM, Inner `mapstructure:"x"`
  fieldType: (b: string, id: string) => new RegExp(`^[ \\t]*${esc(id)}[ \\t]+\\*?(?:\\w+\\.)?([A-Z]\\w*)[ \\t]*(?:[\\x60]|$|//)`, "m").exec(b)?.[1],
  // Go puts the type after the name: const defaultTemperature float32 = 0.7 (also inside const ( … ) groups)
  constDecls: (scope: string, name: string) => [
    ...all(scope, new RegExp(`^[ \\t]*(?:const\\s+|var\\s+)?${esc(name)}\\s+(?:[\\w.*\\[\\]]+\\s*)?=(?!=)`, "gm"), (m) => ({ at: m.index!, expr: valueAt(scope, m.index! + m[0].length) })),
    ...all(scope, new RegExp(`^[ \\t]*(?:const\\s+|var\\s+)?${esc(name)}\\s*=(?!=)`, "gm"), (m) => ({ at: m.index!, expr: valueAt(scope, m.index! + m[0].length) })),
  ],
  fieldInits: () => [], selfAssigns: () => [],
  // struct tags that carry a default (caarlos0/env envDefault, kelseyhightower/envconfig and creasty/defaults default,
  // cleanenv env-default): `Model string `env:"LLM_MODEL" envDefault:"gpt-4o"``. The tag's value is the field's default
  annotationDefaults: (b: string, f: string) => goTagDefaults(b, f),
  // viper.SetDefault("llm.model", "gpt-4o") for a field whose name or mapstructure/yaml/json/koanf tag is the key's last part
  memberAssigns: (src: string, field: string) => [...cfam.memberAssigns(src, field), ...goViperDefaults(src, field)],
  flagDefaults: (src: string, id: string) => [...src.matchAll(new RegExp(`\\.\\w*Var\\w*\\(\\s*&${esc(id)}\\s*,\\s*"([^"]+)"\\s*,\\s*(?:"[^"]*"\\s*,\\s*)?([^,]+),`, "g"))].map((m) => ({ at: m.index!, expr: m[2].trim(), flag: `--${m[1]}` })),
};
const ts = {
  ...common, ...cfam, self: ["this"], implicitFields: false,
  classes: braceClasses(/\bclass\s+(\w+)(?:\s+extends\s+([\w.]+))?[^{]*\{/g),
  functions: (src: string) => [
    ...braceFunctions(/(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/g, "name-type")(src),
    ...braceFunctions(/(?:^|\n)[ \t]*(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*\(/g, "name-type")(src).filter((f) => !/^(?:if|for|while|switch|catch|function|return)$/.test(f.name)),
    ...braceFunctions(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g, "name-type")(src),
  ],
  localType: (scope: string, id: string) => new RegExp(`\\b${esc(id)}\\s*:\\s*([A-Z][\\w.]*)`).exec(scope)?.[1] ?? new RegExp(`\\b${esc(id)}\\s*=\\s*new\\s+([\\w.]+)`).exec(scope)?.[1],
  fieldType: (b: string, id: string) => new RegExp(`\\b${esc(id)}\\??\\s*:\\s*([A-Z][\\w.]*)`).exec(b)?.[1],
  fieldInits: (b: string, f: string) => all(b, new RegExp(`(?:^|\\n)[ \\t]*(?:(?:private|public|protected|readonly|static)\\s+)*${esc(f)}\\??\\s*(?::\\s*[\\w<>.\\[\\]| ]+)?=(?![=>])`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  selfAssigns: (b: string, f: string) => all(b, new RegExp(`\\bthis\\.${esc(f)}\\s*=(?![=>])`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  annotationDefaults: () => [], flagDefaults: () => [],
};
const php = {
  ...common, ...cfam, self: ["this"], implicitFields: false,
  classes: braceClasses(/\b(?:class|trait)\s+(\w+)(?:\s+extends\s+\\?([\w\\]+))?[^{]*\{/g),
  functions: braceFunctions(/\bfunction\s+(\w+)\s*\(/g, "type-name"),
  localType: (scope: string, id: string) => new RegExp(`\\$${esc(id)}\\s*=\\s*new\\s+\\\\?([\\w\\\\]+)`).exec(scope)?.[1],
  fieldType: (b: string, id: string) => new RegExp(`(?:private|protected|public)\\s+(?:readonly\\s+)?\\??([\\w\\\\]+)\\s+\\$${esc(id)}\\b`).exec(b)?.[1],
  fieldInits: (b: string, f: string) => all(b, new RegExp(`(?:private|protected|public|var)\\s+(?:static\\s+)?(?:\\??[\\w\\\\]+\\s+)?\\$${esc(f)}\\s*=(?!=)`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  selfAssigns: (b: string, f: string) => all(b, new RegExp(`\\$this->${esc(f)}\\s*=(?![=>])`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  annotationDefaults: () => [], flagDefaults: () => [],
};

/** Python: indentation blocks */
function pyBlocks(src: string, re: RegExp) {
  const out: { m: RegExpMatchArray; start: number; end: number }[] = [];
  for (const m of src.matchAll(re)) {
    const ind = (m[1] ?? "").length;
    const bodyStart = src.indexOf("\n", m.index! + m[0].length) + 1;
    let end = src.length;
    const rest = src.slice(bodyStart);
    const re2 = /^(?!\s*$)(\s*)\S/gm;
    for (const l of rest.matchAll(re2)) if (l[1].length <= ind) { end = bodyStart + l.index!; break; }
    out.push({ m, start: bodyStart, end });
  }
  return out;
}
const python = {
  ...common, ...cfam, self: ["self", "cls"], implicitFields: false,
  classes: (src: string) => pyBlocks(src, /^([ \t]*)class\s+(\w+)(?:\(([\w.]+)[^)]*\))?\s*:/gm).map((b) => ({ name: b.m[2], start: b.start, end: b.end, parent: b.m[3] })),
  functions: (src: string) => pyBlocks(src, /^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/gm).map((b) => {
    const po = b.m.index! + b.m[0].length - 1;
    const pc = closeOf(src, po, 8000);
    return { name: b.m[2], params: params(src.slice(po + 1, pc < 0 ? po + 1 : pc), "py"), start: b.start, end: b.end };
  }),
  returns: (body: string) => all(body, /\breturn\s+([^\n]+)/g, (m) => ({ at: m.index!, expr: m[1] })),
  localType: (scope: string, id: string) => new RegExp(`\\b${esc(id)}\\s*(?::\\s*([A-Z]\\w*))?\\s*=\\s*([A-Z]\\w*)\\(`).exec(scope)?.[2] ?? new RegExp(`\\b${esc(id)}\\s*:\\s*([A-Z]\\w*)`).exec(scope)?.[1],
  fieldType: (b: string, id: string) => new RegExp(`^[ \\t]*${esc(id)}\\s*:\\s*([A-Z][\\w.]*)`, "m").exec(b)?.[1],
  // class attributes (dataclasses, pydantic): `temperature: float = 0.7`
  fieldInits: (b: string, f: string) => all(b, new RegExp(`^[ \\t]*${esc(f)}\\s*(?::\\s*[\\w\\[\\], .|]+)?=(?!=)`, "gm"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  selfAssigns: (b: string, f: string) => all(b, new RegExp(`\\bself\\.${esc(f)}\\s*(?::\\s*[\\w\\[\\]. |]+)?=(?!=)`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  annotationDefaults: () => [],
  // (not a name inside an annotation: `x: float | None = 1.0` isn't an assignment to None)
  localAssigns: (scope: string, id: string) => all(scope, new RegExp(`(?<![\\w.]|\\|\\s*|\\[\\s*)${esc(id)}\\s*(?::\\s*[\\w\\[\\]. |]+)?=(?!=)`, "g"), (m) => ({ at: m.index!, expr: valueAt(scope, m.index! + m[0].length) })),
  memberAssigns: (src: string, field: string) => [
    ...cfam.memberAssigns(src, field),
    // argparse: add_argument("--temperature", …, default=0.7) feeds args.temperature
    ...[...src.matchAll(new RegExp(`add_argument\\(\\s*["']--${esc(field.replace(/_/g, "-"))}["'][^)]*?default\\s*=\\s*`, "g"))].map((m) => ({ at: m.index!, expr: valueAt(src, m.index! + m[0].length), how: `--${field} flag default` })),
  ],
  flagDefaults: () => [],
};

/** Ruby blocks (class / module / def … end), by the end at the opener's indentation */
function rbBlocks(src: string, re: RegExp) {
  const out: { m: RegExpMatchArray; start: number; end: number }[] = [];
  for (const m of src.matchAll(re)) {
    const ind = (m[1] ?? "").length;
    const bodyStart = src.indexOf("\n", m.index! + m[0].length) + 1;
    if (bodyStart <= 0) continue;
    const endRe = new RegExp(`^ {${ind}}end\\b`, "gm");
    endRe.lastIndex = bodyStart;
    const e = endRe.exec(src);
    out.push({ m, start: bodyStart, end: e ? e.index : src.length });
  }
  return out;
}
/** Ruby parameters: name, name = default, name: default, name:, *args, **opts, &blk */
function rbParams(list: string): { name: string; def?: string }[] {
  return splitArgs(list, 0).map((a) => {
    const t = a.text.trim();
    const kw = /^(\w+):\s*(.*)$/s.exec(t);
    if (kw) return { name: kw[1], def: kw[2].trim() || undefined };
    const pos = /^(\w+)\s*=\s*(.+)$/s.exec(t);
    if (pos) return { name: pos[1], def: pos[2].trim() };
    const bare = /^(\w+)$/.exec(t);
    return bare ? { name: bare[1] } : undefined;
  }).filter((x): x is { name: string; def?: string } => !!x);
}
const ruby = {
  ...common, ...cfam, self: ["self"], implicitFields: false,
  classes: (src: string) => rbBlocks(src, /^([ \t]*)(?:class|module)\s+([A-Z][\w:]*)(?:\s*<\s*([A-Z][\w:]*))?[^\n]*$/gm).map((b) => ({ name: b.m[2].split("::").pop()!, start: b.start, end: b.end, parent: b.m[3]?.split("::").pop() })),
  functions: (src: string) => rbBlocks(src, /^([ \t]*)def\s+(?:self\.)?([a-z_]\w*[?!]?)\s*(?:\(([^)]*)\)|([^\n=]*))?\s*$/gm).map((b) => ({ name: b.m[2], params: rbParams(b.m[3] ?? b.m[4] ?? ""), start: b.start, end: b.end })),
  // explicit returns, and a method's last expression (Ruby returns it)
  returns: (body: string) => {
    const out = all(body, /\breturn\s+([^\n]+)/g, (m) => ({ at: m.index!, expr: m[1] }));
    const lines = body.split("\n");
    let off = body.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      off -= lines[i].length + (i < lines.length - 1 ? 1 : 0);
      const t = lines[i].trim();
      if (!t || /^#/.test(t)) continue;
      if (!/^(?:end|else|elsif|ensure|rescue|when|\}|\])\b/.test(t) && !/^\w+\s*=[^=]/.test(t)) out.push({ at: off + lines[i].indexOf(t), expr: t.replace(/\s+(?:if|unless)\s+.*$/, "") });
      break;
    }
    return out;
  },
  localType: (scope: string, id: string) => new RegExp(`\\b${esc(id)}\\s*=\\s*([A-Z][\\w:]*)\\.new\\b`).exec(scope)?.[1]?.split("::").pop(),
  fieldType: () => undefined,
  fieldInits: () => [],
  selfAssigns: (b: string, f: string) => all(b, new RegExp(`@${esc(f)}\\s*(?:\\|\\|)?=(?!=)`, "g"), (m) => ({ at: m.index!, expr: valueAt(b, m.index! + m[0].length) })),
  annotationDefaults: () => [],
  // locals and instance variables (@temperature = …, temperature ||= …)
  localAssigns: (scope: string, id: string) => all(scope, new RegExp(`(?<![\\w.:])@?${esc(id)}\\s*(?:\\|\\|)?=(?![=~>])`, "g"), (m) => ({ at: m.index!, expr: valueAt(scope, m.index! + m[0].length) })),
  constDecls: (scope: string, name: string) => all(scope, new RegExp(`^[ \\t]*${esc(name)}\\s*=(?!=)`, "gm"), (m) => ({ at: m.index!, expr: valueAt(scope, m.index! + m[0].length) })),
  memberAssigns: (src: string, field: string) => [
    ...cfam.memberAssigns(src, field),
    // hash[:temperature] = x
    ...[...src.matchAll(new RegExp(`(\\w+)\\[\\s*:${esc(field)}\\s*\\]\\s*(?:\\|\\|)?=(?!=)`, "g"))].map((m) => ({ at: m.index!, expr: valueAt(src, m.index! + m[0].length), recv: m[1], how: `[:${field}] =` })),
  ],
  flagDefaults: () => [],
};

export const LANGS: Partial<Record<string, LangSyntax>> = { java: java as LangSyntax, kotlin: java as LangSyntax, cs: csharp as LangSyntax, go: go as LangSyntax, ts: ts as LangSyntax, js: ts as LangSyntax, php: php as LangSyntax, py: python as LangSyntax, rb: ruby as unknown as LangSyntax };
