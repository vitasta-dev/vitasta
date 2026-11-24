/**
 * v8: Ruby SDK calls for providers whose operations follow a naming rule (Stripe: `::Stripe::Checkout::Session
 * .create(…)` → POST /v1/checkout/sessions). Text-based, like the rest of the Ruby support. The request hash is read
 * from the call, or followed within the file: a local `payload = { … }` before the call, or a method
 * (`def payment_url_payload … end`) whose hash it returns, including keys added with `payload[:key] = …`. Each key is
 * reported on its own line, so a finding points at the place a fix changes.
 */
import { PROVIDERS, looksLikeSdkPath, sdkOp } from "../providers.js";
import type { Usage } from "../types.js";

const MAX_LINE = 2000;
const MAX_METHOD_LINES = 200;

type Key = { key: string; line: number; start: number; end: number };

/** Keys of a Ruby hash literal starting at line i (`key: …`, `:key => …`, `"key" => …`), at its top level */
export function hashKeys(lines: string[], starts: number[], i: number, col: number): Key[] {
  const out: Key[] = [];
  let depth = 0;
  for (let r = i; r < Math.min(lines.length, i + MAX_METHOD_LINES); r++) {
    const l = lines[r];
    const from = r === i ? col : 0;
    const depthAt: number[] = [];
    let done = false;
    for (let j = from; j < l.length; j++) {
      depthAt[j] = depth;
      const c = l[j];
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") {
        depth--;
        if (depth === 0) { done = true; break; }
      }
    }
    for (const m of l.matchAll(/(?:^|[{(,\s])(?::?([a-z_]\w*):(?!:)|:([a-z_]\w*)\s*=>|["']([a-z_]\w*)["']\s*=>)/g)) {
      const k = m[1] ?? m[2] ?? m[3];
      const at = m.index! + m[0].indexOf(k);
      if (at >= from && depthAt[at] === 1) out.push({ key: k, line: r + 1, start: starts[r] + at, end: starts[r] + l.length });
    }
    if (done) break;
  }
  return out;
}

/** The lines of `def name … end` (by indentation), if the method is in this file */
function methodBody(lines: string[], name: string): [number, number] | undefined {
  const i = lines.findIndex((l) => new RegExp(`^\\s*def\\s+(self\\.)?${name}\\b`).test(l));
  if (i < 0) return undefined;
  const ind = /^\s*/.exec(lines[i])![0].length;
  for (let r = i + 1; r < Math.min(lines.length, i + MAX_METHOD_LINES); r++) {
    if (new RegExp(`^\\s{${ind}}end\\b`).test(lines[r])) return [i, r];
  }
  return undefined;
}

/** Hash keys a name holds within [from, to): `name = { … }` and `name[:key] = …` */
function keysOfLocal(lines: string[], starts: number[], name: string, from: number, to: number): Key[] {
  const out: Key[] = [];
  for (let r = from; r < to; r++) {
    const l = lines[r];
    const a = new RegExp(`^\\s*${name}\\s*=\\s*\\{`).exec(l);
    if (a) out.push(...hashKeys(lines, starts, r, a[0].length - 1));
    // v11: payload = base.merge(k: v) / payload.merge!({ k: v }) / payload = base.merge({ … })
    const mg = new RegExp(`^\\s*(?:${name}\\s*=\\s*[@\\w.]+|${name})\\.(?:merge|deep_merge|reverse_merge)!?\\(\\s*(\\{)?`).exec(l);
    if (mg) out.push(...hashKeys(lines, starts, r, mg[1] ? mg[0].length - 1 : mg[0].lastIndexOf("(")));
    for (const m of l.matchAll(new RegExp(`\\b${name}\\[\\s*(?::([a-z_]\\w*)|["']([a-z_]\\w*)["'])\\s*\\]\\s*=(?!=)`, "g"))) {
      const k = m[1] ?? m[2];
      out.push({ key: k, line: r + 1, start: starts[r] + m.index!, end: starts[r] + l.length });
    }
  }
  return out;
}

export function rubySdkUsages(file: string, source: string): Usage[] {
  const providers = PROVIDERS.filter((p) => p.opFor && p.packages.rb?.length);
  if (!providers.length || source.length > 2_000_000) return [];
  const lines = source.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) (starts.push(at), (at += l.length + 1));
  const out: Usage[] = [];
  for (const p of providers) {
    const mod = p.id[0].toUpperCase() + p.id.slice(1);
    const call = new RegExp(`(?:::)?\\b${mod}::((?:[A-Z]\\w*::)*[A-Z]\\w*)\\.([a-z_]\\w*)\\s*\\(?\\s*`, "g");
    // v10: client calls: names assigned a client (client = Stripe::StripeClient.new(…)), then client.v1.payment_intents.create(…)
    const clientNames = [...source.matchAll(new RegExp(`(@?[a-z_]\\w*)\\s*=\\s*(?:::)?${mod}::${mod}Client\\.new\\b`, "g"))].map((m) => m[1].replace("@", "@?"));
    const client = clientNames.length ? new RegExp(`(?<![\\w@])(?:${[...new Set(clientNames)].join("|")})\\.((?:[a-z_]\\w*\\.)*[a-z_]\\w*)\\.([a-z_]\\w*)\\s*\\(?\\s*`, "g") : undefined;
    lines.forEach((l, i) => {
      if (l.length > MAX_LINE || /^\s*#/.test(l)) return;
      const matches: { m: RegExpMatchArray; callPath: string }[] = [];
      for (const m of l.matchAll(call)) {
        // Stripe::Checkout::Session.create → checkout.Session.create (namespaces lower case, the resource a class)
        const segs = m[1].split("::");
        matches.push({ m, callPath: [...segs.slice(0, -1).map((s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()), segs[segs.length - 1], m[2]].join(".") });
      }
      if (client) for (const m of l.matchAll(client)) if (looksLikeSdkPath(`${m[1]}.${m[2]}`.replace(/_/g, ""))) matches.push({ m, callPath: `${m[1]}.${m[2]}` });
      for (const { m, callPath } of matches) {
        if (p.localOps?.test(callPath)) continue;
        const op = sdkOp(p, callPath);
        if (!op) continue;
        const after = l.slice(m.index! + m[0].length);
        // v13: the hash may open on the next line: create(\n  { … })
        const nextOpen = !after.trim() && /^\s*\{/.test(lines[i + 1] ?? "") ? lines[i + 1].indexOf("{") : -1;
        const arg = /^\{/.test(after) || nextOpen >= 0 ? "{" : /^([a-z_]\w*)/.exec(after.trim() ? after : (lines[i + 1] ?? "").trim())?.[1];
        let keys: Key[] = [];
        if (arg === "{") keys = nextOpen >= 0 ? hashKeys(lines, starts, i + 1, nextOpen) : hashKeys(lines, starts, i, m.index! + m[0].length);
        // v13: keyword arguments after a positional id (update(id, payment_method_types: […])), read from the call's parens
        const paren = l.lastIndexOf("(", m.index! + m[0].length);
        if (arg !== "{" && paren >= m.index!) {
          for (const k of hashKeys(lines, starts, i, paren)) if (!keys.some((x) => x.key === k.key)) keys.push(k);
        }
        if (arg === "{" || keys.length) {
          // keys found directly
        } else if (arg) {
          // A local built before the call in this method, else a method of this file that returns a hash
          const def = lines.slice(0, i).map((x, r) => [x, r] as const).reverse().find(([x]) => /^\s*def\s/.test(x))?.[1] ?? 0;
          keys = keysOfLocal(lines, starts, arg, def, i);
          // payload = payment_intent_payload: a local holding what a method returns
          const via = lines.slice(def, i).map((x) => new RegExp(`^\\s*${arg}\\s*=\\s*([a-z_]\\w*)\\s*$`).exec(x)?.[1]).filter(Boolean).pop();
          const body = keys.length ? undefined : methodBody(lines, via ?? arg);
          if (body) {
            const local = lines.slice(body[0], body[1]).map((x) => /^\s*([a-z_]\w*)\s*=\s*\{/.exec(x)?.[1]).find(Boolean);
            keys = local ? keysOfLocal(lines, starts, local, body[0], body[1]) : [];
            if (!keys.length) {
              const r = lines.slice(body[0] + 1, body[1]).findIndex((x) => /^\s*\{/.test(x));
              if (r >= 0) keys = hashKeys(lines, starts, body[0] + 1 + r, lines[body[0] + 1 + r].indexOf("{"));
            }
          }
        }
        const direct = arg === "{";
        out.push({ provider: p.id, kind: "sdk", lang: "rb", file, line: i + 1, op, sdkCall: callPath, params: direct ? keys.map((k) => k.key) : [], confidence: "likely", snippet: l.trim().slice(0, 200) });
        if (!direct) for (const k of keys) {
          out.push({
            provider: p.id, kind: "sdk", lang: "rb", file, line: k.line, op, sdkCall: callPath, params: [k.key], confidence: "possible",
            snippet: lines[k.line - 1].trim().slice(0, 200), reason: "params built elsewhere and passed to this call",
            paramSpans: { [k.key]: { start: k.start, end: k.end } },
          });
        }
      }
    });
  }
  return out;
}
