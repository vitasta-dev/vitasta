/**
 * v9: PHP SDK calls for providers whose operations follow a naming rule (Stripe): static resource calls
 * (`\Stripe\PaymentIntent::create([...])`, `Session::create(...)` with `use Stripe\Checkout\Session;`) and client
 * calls on a receiver named after the provider (`$stripe->paymentIntents->create(...)`, `$this->stripe->…`).
 * Text-based, like the rest of the PHP support. The request array is read from the call, or followed within the file:
 * a local (`$data = [...]`, `$data['k'] = …`), a method of the file that returns an array, or (for a wrapper whose
 * parameter is the request) the arrays its callers pass. Each key is reported on its own line.
 */
import { PROVIDERS, looksLikeSdkPath, sdkOp } from "../providers.js";
import { resourceOf } from "./typedsdk.js";
import type { Usage } from "../types.js";

const MAX_LINE = 2000;
const MAX_LINES = 300;
type Key = { key: string; line: number; start: number; end: number };

const blankStrings = (l: string) => l.replace(/(["'])(?:\\.|(?!\1)[^\\])*?\1/g, (m) => " ".repeat(m.length));

/** Top-level keys of the PHP array opening at (row, col) ('k' => …), by bracket depth on string-blanked text */
export function arrayKeys(lines: string[], starts: number[], row: number, col: number): Key[] {
  const out: Key[] = [];
  let depth = 0;
  for (let r = row; r < Math.min(lines.length, row + MAX_LINES); r++) {
    const l = lines[r];
    const b = blankStrings(l);
    const from = r === row ? col : 0;
    const depthAt: number[] = [];
    let done = false;
    for (let j = from; j < b.length; j++) {
      depthAt[j] = depth;
      const c = b[j];
      if (c === "[" || c === "(" || c === "{") depth++;
      else if (c === "]" || c === ")" || c === "}") {
        depth--;
        if (depth === 0) {
          done = true;
          break;
        }
      }
    }
    for (const m of l.matchAll(/(["'])([a-z_]\w*)\1\s*=>/g)) {
      if (m.index! >= from && depthAt[m.index!] === 1) out.push({ key: m[2], line: r + 1, start: starts[r] + m.index!, end: starts[r] + l.length });
    }
    if (done) break;
  }
  return out;
}

/** The function around row: its name, parameters and line range (by brace matching) */
function enclosingFunction(lines: string[], row: number): { name: string; params: string[]; from: number; to: number } | undefined {
  for (let r = row; r >= Math.max(0, row - MAX_LINES); r--) {
    const m = /\bfunction\s+(\w+)\s*\(([^)]*)\)/.exec(lines[r]);
    if (!m) continue;
    let depth = 0;
    let opened = false;
    for (let e = r; e < Math.min(lines.length, r + MAX_LINES); e++) {
      for (const c of blankStrings(lines[e])) {
        if (c === "{") {
          depth++;
          opened = true;
        } else if (c === "}") depth--;
      }
      if (opened && depth <= 0) return e >= row ? { name: m[1], params: [...m[2].matchAll(/\$(\w+)/g)].map((x) => x[1]), from: r, to: e } : undefined;
    }
    return undefined;
  }
  return undefined;
}

/** Keys a variable gets in [from, to): `$v = [ … ]` and `$v['k'] = …` */
function keysOfLocal(lines: string[], starts: number[], v: string, from: number, to: number): Key[] {
  const out: Key[] = [];
  for (let r = from; r < to; r++) {
    const l = lines[r];
    const a = new RegExp(`\\$${v}\\s*=\\s*(\\[|array\\s*\\()`).exec(l);
    if (a) out.push(...arrayKeys(lines, starts, r, a.index + a[0].length - 1));
    // v11: $v = array_merge($base, [ … ]) / array_replace / $v += [ … ] / $v = $base + [ … ]: the literal arrays' keys
    const mg = new RegExp(`\\$${v}\\s*(?:=\\s*(?:array_merge|array_replace|array_merge_recursive)\\s*\\(|\\+=\\s*|=\\s*\\$\\w+\\s*\\+\\s*)`).exec(l);
    if (mg) {
      const b = blankStrings(l);
      for (let j = mg.index + mg[0].length - 1; j < b.length; j++) if (b[j] === "[") {
        out.push(...arrayKeys(lines, starts, r, j));
        // skip past this array on the line
        let d = 0;
        for (; j < b.length; j++) {
          if (b[j] === "[") d++;
          else if (b[j] === "]" && --d === 0) break;
        }
      }
    }
    for (const m of l.matchAll(new RegExp(`\\$${v}\\[\\s*(["'])([a-z_]\\w*)\\1\\s*\\]\\s*=(?!=)`, "g"))) {
      out.push({ key: m[2], line: r + 1, start: starts[r] + m.index!, end: starts[r] + l.length });
    }
  }
  return out;
}

/** The keys of what reaches an argument written as `text` at (row, col): an array, a local, a method's returned array, a wrapper's callers */
function keysOfArg(lines: string[], starts: number[], text: string, row: number, col: number, depth = 2): Key[] {
  const t = text.trimStart();
  const lead = text.length - t.length;
  if (t.startsWith("[")) return arrayKeys(lines, starts, row, col + lead);
  if (/^array\s*\(/.test(t)) return arrayKeys(lines, starts, row, col + lead + t.indexOf("("));
  const fn = enclosingFunction(lines, row);
  const v = /^\$(\w+)/.exec(t)?.[1];
  if (v && v !== "this") {
    const local = fn ? keysOfLocal(lines, starts, v, fn.from, row) : [];
    if (local.length) return local;
    // A wrapper's parameter: the arrays its callers in this file pass first (the request)
    if (fn && fn.params.indexOf(v) === 0 && depth > 0) {
      const out: Key[] = [];
      lines.forEach((l, r) => {
        if (r >= fn.from && r <= fn.to) return;
        for (const m of l.matchAll(new RegExp(`(?:->|::)${fn.name}\\s*\\(`, "g"))) {
          const end = m.index! + m[0].length;
          const rest = l.slice(end);
          if (rest.trim()) out.push(...keysOfArg(lines, starts, rest, r, end, depth - 1));
          else if (lines[r + 1] !== undefined) out.push(...keysOfArg(lines, starts, lines[r + 1], r + 1, 0, depth - 1));
        }
      });
      return out;
    }
    return [];
  }
  const meth = /^\$this->(\w+)\s*\(/.exec(t)?.[1] ?? /^(?:self|static)::(\w+)\s*\(/.exec(t)?.[1];
  if (meth && depth > 0) {
    const r = lines.findIndex((l) => new RegExp(`\\bfunction\\s+${meth}\\s*\\(`).test(l));
    const body = r >= 0 ? enclosingFunction(lines, r + 1) : undefined;
    if (!body) return [];
    for (let x = body.from; x <= body.to; x++) {
      const ret = /\breturn\s+/.exec(lines[x]);
      if (ret) return keysOfArg(lines, starts, lines[x].slice(ret.index + ret[0].length), x, ret.index + ret[0].length, depth - 1);
    }
  }
  return [];
}

export function phpSdkUsages(file: string, source: string, wrappers?: PhpWrapper[]): Usage[] {
  const providers = PROVIDERS.filter((p) => p.opFor && p.packages.php?.length);
  if (!providers.length || source.length > 2_000_000) return [];
  const lines = source.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const out: Usage[] = [];
  for (const p of providers) {
    const mod = p.id[0].toUpperCase() + p.id.slice(1);
    // use Stripe\Checkout\Session; use Stripe\PaymentIntent as Intent;
    const alias = new Map<string, string>();
    for (const m of source.matchAll(new RegExp(`^[ \\t]*use\\s+\\\\?${mod}\\\\((?:[A-Z]\\w*\\\\)*[A-Z]\\w*)(?:\\s+as\\s+(\\w+))?\\s*;`, "gm"))) {
      alias.set(m[2] ?? m[1].split("\\").pop()!, m[1]);
    }
    const names = [...alias.keys()];
    const statics = new RegExp(`(?<![\\w\\\\$>:])(?:\\\\?${mod}\\\\((?:[A-Z]\\w*\\\\)*[A-Z]\\w*)|(${names.length ? names.join("|") : "(?!)"}))::([a-z]\\w*)\\s*\\(`, "g");
    const client = new RegExp(`\\$(?:this->)?_?${p.id}(?:Client)?->((?:\\w+->)*\\w+)->([a-z]\\w*)\\s*\\(`, "gi");
    // (once per file, not per line: per line it rescans the whole file every line)
    const mentionsStripe = /stripe/i.test(source);
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE || /^\s*(\/\/|\*|#)/.test(l)) return;
      const calls: { path: string; end: number }[] = [];
      for (const m of l.matchAll(statics)) {
        const cls = m[1] ?? alias.get(m[2])!;
        const segs = cls.split("\\");
        const ns = segs.slice(0, -1).map((s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase());
        calls.push({ path: [...ns, segs[segs.length - 1], m[3]].join("."), end: m.index! + m[0].length });
      }
      for (const m of l.matchAll(client)) {
        const path = [...m[1].split("->"), m[2]].join(".");
        if (looksLikeSdkPath(path)) calls.push({ path, end: m.index! + m[0].length });
      }
      // v13: a StripeClient on any receiver ($this->client->paymentIntents->create(…), $this->getClient()->…), when the
      // chain names a known Stripe resource and the file mentions Stripe
      if (mentionsStripe) {
        for (const m of l.matchAll(/->\s*((?:[a-z]\w*\s*->\s*)?)([a-z]\w*)\s*->\s*(create|retrieve|update|all|delete|cancel|confirm|capture|search|expire|finalizeInvoice|pay|voidInvoice)\s*\(/g)) {
          const ns = m[1].replace(/\s*->\s*$/, "");
          const res = resourceOf(p.id, ns + m[2]) ?? resourceOf(p.id, m[2]);
          if (!res || calls.some((c) => c.end === m.index! + m[0].length)) continue;
          calls.push({ path: `${res}.${m[3] === "all" ? "list" : m[3]}`, end: m.index! + m[0].length });
        }
      }
      for (const c of calls) {
        const op = sdkOp(p, c.path);
        if (!op) continue;
        // The first argument: on this line, or the next when the call breaks after "("
        let argText = l.slice(c.end);
        let row = i;
        let col = c.end;
        if (!argText.trim() && lines[i + 1] !== undefined) {
          row = i + 1;
          argText = lines[i + 1];
          col = 0;
        }
        const direct = /^\s*(\[|array\s*\()/.test(argText);
        const keys = keysOfArg(lines, starts, argText, row, col);
        // A wrapper: the request is the enclosing method's first parameter, so callers in other files supply it
        const v = /^\s*\$(\w+)\s*[,)]?/.exec(argText)?.[1];
        const fn = v ? enclosingFunction(lines, i) : undefined;
        if (wrappers && fn && fn.params[0] === v) wrappers.push({ name: fn.name, file, provider: p.id, op, callPath: c.path });
        out.push({ provider: p.id, kind: "sdk", lang: "php", file, line: i + 1, op, sdkCall: c.path, params: direct ? keys.map((k) => k.key) : [], confidence: "likely", snippet: l.trim().slice(0, 200) });
        if (!direct) {
          for (const k of keys) {
            out.push({
              provider: p.id, kind: "sdk", lang: "php", file, line: k.line, op, sdkCall: c.path, params: [k.key], confidence: "possible",
              snippet: (lines[k.line - 1] ?? "").trim().slice(0, 200), reason: "params built elsewhere and passed to this call", paramSpans: { [k.key]: { start: k.start, end: k.end } },
            });
          }
        }
      }
    });
  }
  return out;
}

export type PhpWrapper = { name: string; file: string; provider: string; op: string; callPath: string };

/**
 * v9: callers in other files of a wrapper method whose first parameter is an SDK request
 * (`$this->stripe->createPaymentIntent($data)` where createPaymentIntent passes $data to PaymentIntent::create).
 * The keys the caller builds are reported on their lines, with the wrapped operation.
 */
export function phpWrapperCallUsages(file: string, source: string, wrappers: PhpWrapper[]): Usage[] {
  const mine = wrappers.filter((w) => w.file !== file && source.includes(w.name));
  if (!mine.length || source.length > 2_000_000) return [];
  const lines = source.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const out: Usage[] = [];
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (l.length > MAX_LINE || /^\s*(\/\/|\*|#)/.test(l) || /\bfunction\s/.test(l)) return;
    for (const w of mine) {
      for (const m of l.matchAll(new RegExp(`(?:->|::)${w.name}\\s*\\(`, "g"))) {
        const end = m.index! + m[0].length;
        const rest = l.slice(end);
        const keys = rest.trim() ? keysOfArg(lines, starts, rest, i, end) : lines[i + 1] !== undefined ? keysOfArg(lines, starts, lines[i + 1], i + 1, 0) : [];
        for (const k of keys) {
          const id = `${k.line}|${w.op}|${k.key}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({
            provider: w.provider, kind: "sdk", lang: "php", file, line: k.line, op: w.op, sdkCall: w.callPath, params: [k.key], confidence: "possible",
            snippet: (lines[k.line - 1] ?? "").trim().slice(0, 200), reason: `params passed to ${w.name}, which sends them`, paramSpans: { [k.key]: { start: k.start, end: k.end } },
          });
        }
      }
    }
  });
  return out;
}
