function starts(lines) {
    const out = [];
    let at = 0;
    for (const l of lines) {
        out.push(at);
        at += l.length + 1;
    }
    return out;
}
/** The def a line is in (by indentation): its name and parameter names */
function enclosingDef(lines, row) {
    const ind = /^\s*/.exec(lines[row] ?? "")[0].length;
    for (let r = row - 1; r >= Math.max(0, row - 200); r--) {
        const m = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/.exec(lines[r]);
        if (m && m[1].length < ind) {
            const raw = m[3].split(",").map((p) => p.trim().split(/[:=\s]/)[0]);
            const kwargs = raw.find((p) => p.startsWith("**"))?.slice(2);
            // a method: the class it's in (by indentation), for whether a caller shows which class it calls
            let cls;
            if (/^self$/.test(raw[0] ?? ""))
                for (let c = r - 1; c >= Math.max(0, r - 2000); c--) {
                    const k = /^(\s*)class\s+(\w+)/.exec(lines[c]);
                    if (k && k[1].length < m[1].length) {
                        cls = k[2];
                        break;
                    }
                }
            return { name: m[2], params: raw.map((p) => p.replace(/^\*+/, "")).filter((p) => p && p !== "self" && p !== "cls"), row: r, kwargs, cls };
        }
    }
    return undefined;
}
/** Keyword arguments of the call whose ( is at (row, col): k=… at the call's own depth */
function callKwargs(lines, st, row, col) {
    const out = [];
    let depth = 0;
    for (let r = row; r < Math.min(lines.length, row + 30); r++) {
        const l = lines[r];
        const b = l.replace(/(["'])(?:\\.|(?!\1)[^\\])*?\1/g, (m) => " ".repeat(m.length));
        const from = r === row ? col : 0;
        const depthAt = [];
        let done = false;
        for (let j = from; j < b.length; j++) {
            depthAt[j] = depth;
            if ("{[(".includes(b[j]))
                depth++;
            else if ("}])".includes(b[j]) && --depth === 0) {
                done = true;
                break;
            }
        }
        for (const m of b.matchAll(/(?<![\w.*])([a-z_]\w*)\s*=(?!=)/g))
            if (m.index >= from && depthAt[m.index] === 1)
                out.push({ key: m[1], line: r + 1, start: st[r] + m.index, end: st[r] + l.length });
        if (done)
            break;
    }
    return out;
}
/** Top-level keys of the dict opening at (row, col): "k": / 'k': */
function dictKeys(lines, st, row, col) {
    const out = [];
    let depth = 0;
    for (let r = row; r < Math.min(lines.length, row + 200); r++) {
        const l = lines[r];
        const b = l.replace(/(["'])(?:\\.|(?!\1)[^\\])*?\1/g, (m) => " ".repeat(m.length));
        const from = r === row ? col : 0;
        const depthAt = [];
        let done = false;
        for (let j = from; j < b.length; j++) {
            depthAt[j] = depth;
            if ("{[(".includes(b[j]))
                depth++;
            else if ("}])".includes(b[j]) && --depth === 0) {
                done = true;
                break;
            }
        }
        for (const m of l.matchAll(/["']([a-z_]\w*)["']\s*:/g))
            if (m.index >= from && depthAt[m.index] === 1)
                out.push({ key: m[1], line: r + 1, start: st[r] + m.index, end: st[r] + l.length });
        if (done)
            break;
    }
    return out;
}
/** Keys a local dict gets before `row` in its function: name = {…}, name["k"] = …, name.update({…}), name = dict(k=…) */
function localKeys(lines, st, name, from, row) {
    const out = [];
    for (let r = from; r < row; r++) {
        const l = lines[r];
        const a = new RegExp(`^\\s*${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(l);
        if (a)
            out.push(...dictKeys(lines, st, r, a[0].length - 1));
        const u = new RegExp(`\\b${name}\\.update\\(\\s*\\{`).exec(l);
        if (u)
            out.push(...dictKeys(lines, st, r, u.index + u[0].length - 1));
        for (const m of l.matchAll(new RegExp(`\\b${name}\\[\\s*["']([a-z_]\\w*)["']\\s*\\]\\s*=(?!=)`, "g")))
            out.push({ key: m[1], line: r + 1, start: st[r] + m.index, end: st[r] + l.length });
        // v14: also a typed params constructor (SetupIntentCreateParams(customer=…): the SDK's TypedDicts)
        const d = new RegExp(`^\\s*${name}\\s*(?::[^=]+)?=\\s*(?:dict|[\\w.]*\\b[A-Z]\\w*(?:Params|Options))\\((.*)`).exec(l);
        if (d)
            for (const m of d[1].matchAll(/\b([a-z_]\w*)\s*=/g))
                out.push({ key: m[1], line: r + 1, start: st[r] + l.indexOf(m[0]), end: st[r] + l.length });
    }
    return out;
}
export function pythonWrapperUsages(files, usages, more) {
    const py = files.filter((f) => f.lang === "py" && f.source.length <= 2_000_000);
    if (!py.length)
        return [];
    const text = new Map(py.map((f) => [f.rel, f.source.split("\n")]));
    // 1. Wrappers: an SDK call whose ** / params= argument is a parameter of the enclosing def
    const wrappers = [];
    for (const u of usages) {
        if (u.lang !== "py" || u.kind !== "sdk" || !u.op || u.model)
            continue;
        const lines = text.get(u.file);
        if (!lines)
            continue;
        const call = lines.slice(u.line - 1, u.line + 4).join(" ");
        const arg = /\*\*\s*(\w+)/.exec(call)?.[1] ?? /\bparams\s*=\s*(\w+)/.exec(call)?.[1];
        if (!arg)
            continue;
        const def = enclosingDef(lines, u.line - 1);
        const index = def ? def.params.indexOf(arg) : -1;
        // (a ** parameter forwarded whole, def generate(self, prompt, **kwargs): …create(…, **kwargs): the caller's keyword
        // arguments are the request's; test sets)
        const kw = !!def?.kwargs && def.kwargs === arg && /\*\*\s*\w+/.test(call);
        if (def && index >= 0 && !wrappers.some((w) => w.name === def.name && w.file === u.file))
            wrappers.push({ name: def.name, index, op: u.op, provider: u.provider, file: u.file, sdkCall: u.sdkCall, ...(kw ? { kw, cls: def.cls } : {}) });
    }
    if (!wrappers.length)
        return [];
    // keyword wrappers' callers that name no provider (the prefilter skipped them)
    const kwNames = [...new Set(wrappers.filter((w) => w.kw).map((w) => w.name))];
    if (kwNames.length && more)
        for (const f of more()) {
            if (f.lang !== "py" || f.source.length > 2_000_000 || text.has(f.rel) || !kwNames.some((n) => f.source.includes(`.${n}(`)))
                continue;
            py.push(f);
            text.set(f.rel, f.source.split("\n"));
        }
    // 2. Callers in other files that import the wrapper
    const out = [];
    const seen = new Set();
    for (const f of py) {
        const lines = text.get(f.rel);
        const st = starts(lines);
        for (const w of wrappers) {
            if (w.file === f.rel || !f.source.includes(w.name))
                continue;
            if (!new RegExp(`\\bimport\\b[^\\n]*\\b${w.name}\\b|\\b\\w+\\.${w.name}\\s*\\(`).test(f.source))
                continue;
            lines.forEach((l, i) => {
                if (/^\s*(#|def\s|from\s|import\s)/.test(l))
                    return;
                const m = new RegExp(`\\b${w.name}\\s*\\(`).exec(l);
                if (!m)
                    return;
                const rest = l.slice(m.index + m[0].length);
                const args = rest.split(",").map((s) => s.trim());
                const arg = args[w.index] ?? "";
                let keys = [];
                // where the caller doesn't show which class it calls (backend.generate(…) on any backend), the finding says so
                let unresolved;
                if (w.kw) {
                    keys = callKwargs(lines, st, i, m.index + m[0].length - 1);
                    // (and a dict passed whole, create_payment_intent(**params): the keys the caller wrote into it)
                    const spread = /^\s*\*\*\s*(\w+)/.exec(args.find((x) => x.startsWith("**")) ?? "")?.[1];
                    if (spread)
                        keys.push(...localKeys(lines, st, spread, enclosingDef(lines, i)?.row ?? Math.max(0, i - 200), i));
                    const same = wrappers.filter((x) => x.kw && x.name === w.name);
                    const shown = !!w.cls && (new RegExp(`\\b${w.cls}\\s*\\(`).test(f.source) && same.length === 1);
                    if (!shown || /^\s*def\s/.test(l))
                        unresolved = `the caller's object isn't shown${same.length > 1 ? `; ${same.length} classes define ${w.name}(**kwargs), one of them` : ""} ${w.cls ? `${w.cls}.` : ""}${w.name} (${w.file}) sends it as ${w.op}`;
                }
                else if (arg.startsWith("{"))
                    keys = dictKeys(lines, st, i, m.index + m[0].length + rest.indexOf("{"));
                else {
                    const name = /^\*{0,2}(\w+)/.exec(arg)?.[1];
                    const def = enclosingDef(lines, i);
                    if (name)
                        keys = localKeys(lines, st, name, def?.row ?? Math.max(0, i - 200), i);
                }
                for (const k of keys) {
                    const id = `${f.rel}|${k.line}|${w.op}|${k.key}`;
                    if (seen.has(id))
                        continue;
                    seen.add(id);
                    out.push({
                        provider: w.provider, kind: "sdk", lang: "py", file: f.rel, line: k.line, op: w.op, sdkCall: w.sdkCall, params: [k.key], confidence: "possible",
                        snippet: (lines[k.line - 1] ?? "").trim().slice(0, 200), reason: `params passed to ${w.name} (${w.file}), which sends them`, paramSpans: { [k.key]: { start: k.start, end: k.end } },
                        ...(unresolved ? { context: "provider-unresolved", contextReason: unresolved } : {}),
                    });
                }
            });
        }
    }
    return out;
}
