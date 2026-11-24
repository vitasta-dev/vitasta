import { vocabs } from "./vocab.js";
const MAX = 2_000_000;
export function rubyClientUsages(files, found) {
    const rb = files.filter((f) => f.lang === "rb" && f.source.length <= MAX);
    const vs = vocabs().filter((v) => v.lang === "rb" && v.types && v.clients);
    if (!rb.length || !vs.length)
        return [];
    const clientNames = [...new Set(vs.flatMap((v) => Object.keys(v.clients)))];
    if (!clientNames.length)
        return [];
    const ctor = new RegExp(`(?<![\\w:])(?:::)?(${clientNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.new\\b`);
    if (!rb.some((f) => ctor.test(f.source)))
        return [];
    // classes and modules by indentation, their defs and instance variables that hold a client
    const classes = [];
    const constants = new Map(); // NAME -> client type
    for (const f of rb) {
        const lines = f.source.split("\n");
        const stack = [];
        lines.forEach((l, i) => {
            const m = /^(\s*)(class|module)\s+([A-Z][\w:]*)(?:\s*<\s*([A-Z][\w:]*))?/.exec(l);
            if (m) {
                const ind = m[1].length;
                while (stack.length && stack[stack.length - 1].ind >= ind)
                    stack.pop();
                const name = [...stack.map((s) => s.c.name), m[3]].join("::");
                const c = { name, simple: m[3].split("::").pop(), parent: m[4], includes: [], file: f.rel, start: i, end: lines.length, holders: new Set() };
                // the class ends at the `end` with its indentation
                for (let j = i + 1; j < lines.length; j++)
                    if (new RegExp(`^\\s{${ind}}end\\b`).test(lines[j])) {
                        c.end = j;
                        break;
                    }
                classes.push(c);
                stack.push({ ind, c });
                return;
            }
            const cur = stack.length ? stack[stack.length - 1].c : undefined;
            const inc = /^\s*(?:include|extend|prepend)\s+([A-Z][\w:]*)/.exec(l);
            if (inc && cur)
                cur.includes.push(inc[1]);
            const k = /^\s*([A-Z][A-Z0-9_]*)\s*(?:\|\|)?=\s*(.+)$/.exec(l);
            if (k) {
                const t = ctor.exec(k[2]);
                if (t)
                    constants.set(k[1], t[1].replace(/^::/, ""));
            }
        });
    }
    const typeOf = new Map(); // `${class}|${name}` -> client type
    for (const c of classes) {
        const f = rb.find((x) => x.rel === c.file);
        const lines = f.source.split("\n").slice(c.start, c.end + 1);
        const body = lines.join("\n");
        // def name … end (or one-line / endless defs) whose body builds a client
        for (const m of body.matchAll(/^([ \t]*)def\s+(?:self\.)?([a-z_]\w*[?!]?)[^\n]*\n([\s\S]*?)^\1end\b/gm)) {
            const t = ctor.exec(m[3]);
            if (t) {
                c.holders.add(m[2]);
                typeOf.set(`${c.name}|${m[2]}`, t[1].replace(/^::/, ""));
            }
        }
        for (const m of body.matchAll(/^[ \t]*def\s+(?:self\.)?([a-z_]\w*)\s*(?:\([^)]*\))?\s*(?:=|;)\s*(.+)$/gm)) {
            const t = ctor.exec(m[2]);
            if (t) {
                c.holders.add(m[1]);
                typeOf.set(`${c.name}|${m[1]}`, t[1].replace(/^::/, ""));
            }
        }
        for (const m of body.matchAll(/@(\w+)\s*(?:\|\|)?=\s*([^\n]+)/g)) {
            const t = ctor.exec(m[2]);
            if (t) {
                c.holders.add(`@${m[1]}`);
                c.holders.add(m[1]);
                typeOf.set(`${c.name}|@${m[1]}`, t[1].replace(/^::/, ""));
                typeOf.set(`${c.name}|${m[1]}`, t[1].replace(/^::/, ""));
            }
        }
        // hops inside the class, until nothing new: def name returning a holder (def client; @client; end, def api =
        // client), an instance variable assigned from a holder (@client = build_client), attr_reader :client over @client
        for (let round = 0, grew = true; grew && round < 4; round++) {
            grew = false;
            const add = (name, t) => {
                if (c.holders.has(name))
                    return;
                c.holders.add(name);
                typeOf.set(`${c.name}|${name}`, t);
                grew = true;
            };
            for (const m of body.matchAll(/^[ \t]*def\s+([a-z_]\w*)\s*(?:\(\))?\s*(?:\n\s*|=\s*|;\s*)(@?\w+)\s*(?:\n\s*end|;\s*end|$)/gm)) {
                const t = typeOf.get(`${c.name}|${m[2]}`);
                if (t)
                    add(m[1], t);
            }
            for (const m of body.matchAll(/@(\w+)\s*(?:\|\|)?=\s*(?:self\.)?([a-z_]\w*[?!]?)\s*(?:\(\s*\))?\s*(?:#[^\n]*)?$/gm)) {
                const t = typeOf.get(`${c.name}|${m[2]}`);
                if (t) {
                    add(`@${m[1]}`, t);
                    add(m[1], t);
                }
            }
            // a local assigned from a holder (client = build_client), in a method of the class
            for (const m of body.matchAll(/^[ \t]*([a-z_]\w*)\s*(?:\|\|)?=\s*(?:self\.)?([a-z_]\w*[?!]?)\s*(?:\(\s*\))?\s*(?:#[^\n]*)?$/gm)) {
                const t = typeOf.get(`${c.name}|${m[2]}`);
                if (t)
                    add(m[1], t);
            }
            for (const m of body.matchAll(/^[ \t]*attr_(?:reader|accessor)\s+([^\n]+)/gm)) {
                for (const a of m[1].matchAll(/:(\w+)/g)) {
                    const t = typeOf.get(`${c.name}|@${a[1]}`);
                    if (t)
                        add(a[1], t);
                }
            }
        }
    }
    const bySimple = new Map();
    for (const c of classes)
        bySimple.set(c.simple, [...(bySimple.get(c.simple) ?? []), c]);
    const one = (n) => {
        if (!n)
            return undefined;
        const cs = bySimple.get(n.split("::").pop()) ?? [];
        return cs.length === 1 ? cs[0] : cs.find((c) => c.name === n || c.name.endsWith(`::${n}`));
    };
    /** The client type a name holds in a class: its own holders, then its parents' and included modules' */
    const holderType = (c, name, depth = 0) => {
        if (depth > 5)
            return undefined;
        const own = typeOf.get(`${c.name}|${name}`);
        if (own)
            return own;
        for (const anc of [c.parent, ...c.includes]) {
            const a = one(anc);
            if (a && a !== c) {
                const t = holderType(a, name, depth + 1);
                if (t)
                    return t;
            }
        }
        return undefined;
    };
    /** Follow the chain on a client type through each vocabulary that has it; the first that resolves */
    const walk = (clientType, chain) => {
        for (const v of vs) {
            if (!v.clients[clientType] && !v.types[clientType])
                continue;
            let t = clientType;
            for (let i = 0; i < chain.length && t; i++) {
                const vt = v.types[t];
                if (!vt) {
                    t = undefined;
                    break;
                }
                if (i === chain.length - 1) {
                    const op = vt.methods[chain[i]]?.[0]?.op;
                    if (op)
                        return { op, v };
                    t = undefined;
                }
                else
                    t = vt.res[chain[i]];
            }
        }
        return undefined;
    };
    const out = [];
    const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
    const near = new Map();
    for (const u of found)
        near.set(`${u.file}|${u.op ?? ""}`, [...(near.get(`${u.file}|${u.op ?? ""}`) ?? []), u.line]);
    for (const f of rb) {
        const lines = f.source.split("\n");
        const mine = classes.filter((c) => c.file === f.rel);
        const classAt = (row) => mine.filter((c) => c.start <= row && row <= c.end).sort((a, b) => b.start - a.start)[0];
        lines.forEach((l, i) => {
            if (l.length > 2000 || /^\s*#/.test(l))
                return;
            for (const m of l.matchAll(/(?<![\w.:])(@?[a-z_]\w*|[A-Z][A-Z0-9_]*|self\.[a-z_]\w*)((?:\s*\.\s*[a-z_]\w*)+)\s*(\(|\s+\w+:|\s*$)/g)) {
                const recv = m[1].replace(/^self\./, "");
                const c = classAt(i);
                const type = /^[A-Z]/.test(recv) ? constants.get(recv) : c ? holderType(c, recv) : undefined;
                if (!type)
                    continue;
                const chain = m[2].split(".").map((x) => x.trim()).filter(Boolean);
                const hit = walk(type, chain);
                if (!hit)
                    continue;
                const key = `${f.rel}|${hit.op}`;
                if ((near.get(key) ?? []).some((x) => Math.abs(x - (i + 1)) <= 3))
                    continue;
                near.set(key, [...(near.get(key) ?? []), i + 1]);
                // the call's arguments: keyword keys at depth 1, and a parameters: { … } hash's keys
                const start = m.index + m[0].length - (m[3] === "(" ? 1 : m[3].length);
                const text = lines.slice(i, i + 80).join("\n").slice(start);
                const keys = [];
                let depth = 0, row = i;
                for (let j = 0; j < text.length; j++) {
                    const ch = text[j];
                    if (ch === "\n") {
                        row++;
                        if (depth === 0 && m[3] !== "(")
                            break;
                        continue;
                    }
                    if (ch === "(" || ch === "{" || ch === "[")
                        depth++;
                    else if (ch === ")" || ch === "}" || ch === "]") {
                        depth--;
                        if (depth <= 0 && m[3] === "(")
                            break;
                    }
                    const k = /^([a-z_]\w*):(?!:)|^:([a-z_]\w*)\s*=>|^["']([a-z_]\w*)["']\s*=>/.exec(text.slice(j, j + 60));
                    const before = text[j - 1] ?? " ";
                    if (k && /[\s({,]/.test(before) && (depth === 1 || depth === 2 || (m[3] !== "(" && depth === 0))) {
                        const name = k[1] ?? k[2] ?? k[3];
                        if (name !== "parameters")
                            keys.push({ key: name, line: row + 1 });
                        j += name.length;
                    }
                }
                const base = {
                    provider: hit.v.provider, kind: "sdk", lang: "rb", file: f.rel, line: i + 1, op: hit.op, confidence: "likely", sdkCall: `${recv}.${chain.join(".")}`,
                    snippet: l.trim().slice(0, 200), reason: `${recv} holds a ${type} (${hit.v.package}); ${chain.join(".")} sends ${hit.op}`,
                };
                out.push(base);
                for (const k of keys.filter((k) => !have.has(`${f.rel}|${k.line}|${k.key}`)))
                    out.push({ ...base, line: k.line, params: [k.key], snippet: (lines[k.line - 1] ?? "").trim().slice(0, 200), reason: `${k.key} in ${base.reason}` });
            }
        });
    }
    return out;
}
