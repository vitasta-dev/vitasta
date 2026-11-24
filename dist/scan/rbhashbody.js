const SAMPLING = new Set(["temperature", "top_p", "top_k"]);
/** The balanced { … } from an opening brace, or -1 */
function closeBrace(s, open) {
    let d = 0;
    for (let i = open; i < Math.min(s.length, open + 20_000); i++) {
        const c = s[i];
        if (c === '"' || c === "'") {
            for (i++; i < s.length && s[i] !== c; i++)
                if (s[i] === "\\")
                    i++;
            continue;
        }
        if (c === "{")
            d++;
        else if (c === "}" && --d === 0)
            return i;
    }
    return -1;
}
export function rubyHashBodyUsages(files, found) {
    const rb = files.filter((f) => f.lang === "rb" && f.source.length <= 2_000_000);
    const out = [];
    const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
    const lineAt = (s, at) => s.slice(0, at).split("\n").length;
    const constDefs = (name) => rb.flatMap((g) => [...g.source.matchAll(new RegExp(String.raw `^\s*${name}\s*=\s*\{`, "gm"))].map((m) => ({ g, open: m.index + m[0].length - 1 })));
    const methodBody = (name) => {
        for (const g of rb) {
            const m = new RegExp(String.raw `^(\s*)def\s+(?:self\.)?${name}\b[^\n]*\n([\s\S]*?)^\1end\b`, "m").exec(g.source);
            if (m)
                return { g, body: m[2], at: m.index + m[0].indexOf(m[2]) };
        }
        return undefined;
    };
    for (const f of rb) {
        if (!/api\.anthropic\.com/.test(f.source) || !/\/v1\/messages/.test(f.source))
            continue;
        const src = f.source;
        // the body expressions
        const bodies = [...src.matchAll(/\b(?:req(?:uest)?\.body\s*=|\bbody:\s*|JSON\.(?:generate|dump)\()\s*([^\n]+)/g)].map((m) => m[1]);
        const seen = new Set();
        const hashes = [];
        const follow = (expr, g, depth, via) => {
            if (depth > 4)
                return;
            // an inline hash in the expression
            for (const m of expr.matchAll(/\{/g)) {
                const at = g.source.indexOf(expr);
                if (at >= 0)
                    hashes.push({ g, open: at + m.index, via });
                break;
            }
            for (const m of expr.matchAll(/(@{0,2}[a-z_]\w*|(?:[A-Z]\w*::)*[A-Z][A-Z0-9_]+\b|(?:[A-Z]\w*::)*[A-Z]\w*\.[a-z_]\w*|self\.[a-z_]\w*)/g)) {
                const name = m[1];
                const key = `${g.rel}|${name}`;
                // (method words and the call's own arguments; an instance variable is always followed)
                if (seen.has(key) || /^(?:to_json|to_h|merge|freeze|dup|deep_merge|reverse_merge|compact|options|opts|params|kwargs|messages|true|false|nil)$/.test(name))
                    continue;
                seen.add(key);
                if (/^@{0,2}[a-z_]/.test(name)) {
                    // its assignments in the same file
                    for (const a of g.source.matchAll(new RegExp(String.raw `(?:^|[\s;])${name.replace(/[@$]/g, "\\$&")}\s*(?:\|\|)?=(?!=)\s*([^\n]+)`, "gm")))
                        follow(a[1], g, depth + 1, `${via} ← ${name}`);
                }
                else if (/\./.test(name)) {
                    const meth = name.split(".").pop();
                    const mb = methodBody(meth);
                    if (mb)
                        follow(mb.body.trim().split("\n").pop() ?? "", mb.g, depth + 1, `${via} ← ${name}`);
                }
                else {
                    for (const d of constDefs(name.split("::").pop()))
                        hashes.push({ g: d.g, open: d.open, via: `${via} ← ${name}` });
                }
            }
        };
        for (const b of bodies)
            follow(b, f, 0, "the request body");
        for (const h of hashes) {
            const close = closeBrace(h.g.source, h.open);
            if (close < 0)
                continue;
            const seg = h.g.source.slice(h.open, close);
            for (const k of seg.matchAll(/(?:^|[{,\s])(?::(\w+)\s*=>|(\w+):(?!:)|["'](\w+)["']\s*(?:=>|:))/g)) {
                const key = k[1] ?? k[2] ?? k[3];
                if (!SAMPLING.has(key))
                    continue;
                // only the hash's own keys
                const inner = seg.slice(0, k.index);
                if ((inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length !== 1)
                    continue;
                const line = lineAt(h.g.source, h.open + k.index) + (/^\s*\n/.test(seg.slice(k.index, k.index + 2)) ? 1 : 0);
                const real = h.g.source.split("\n").findIndex((l, i) => i >= line - 1 && new RegExp(String.raw `\b${key}\b`).test(l)) + 1 || line;
                if (have.has(`${h.g.rel}|${real}|${key}`))
                    continue;
                have.add(`${h.g.rel}|${real}|${key}`);
                out.push({
                    provider: "anthropic", kind: "http", lang: "rb", file: h.g.rel, line: real, op: "POST /v1/messages", params: [key], confidence: "possible",
                    snippet: (h.g.source.split("\n")[real - 1] ?? "").trim().slice(0, 200), reason: `${key} reaches the Anthropic request body in ${f.rel} through ${h.via}`,
                });
            }
        }
    }
    return out;
}
