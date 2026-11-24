/** Settings by provider operation, wire name → the spellings a TS options type uses */
const FORWARDED = {
    "POST /v1/messages": { temperature: ["temperature"], top_p: ["top_p", "topP"], top_k: ["top_k", "topK"] },
    "POST /v1/chat/completions": { temperature: ["temperature"], top_p: ["top_p", "topP"] },
    "POST /v1/responses": { temperature: ["temperature"], top_p: ["top_p", "topP"] },
};
export function libraryForwardUsages(files, usages, published, filesNaming) {
    if (!published)
        return [];
    const ts = files.filter((f) => (f.lang === "ts" || f.lang === "js") && f.source.length <= 2_000_000);
    const byRel = new Map(ts.map((f) => [f.rel, f]));
    const out = [];
    const seen = new Set();
    // Declared types by name: interface X { … } / type X = { … }
    const typeDef = (name, from) => {
        const hits = [];
        for (const f of filesNaming(name, from)) {
            const ls = f.source.split("\n");
            ls.forEach((l, i) => {
                if (new RegExp(`\\b(?:interface\\s+${name}\\b[^{]*\\{|type\\s+${name}\\s*(?:<[^=]*>)?\\s*=\\s*\\{?)`).test(l))
                    hits.push({ rel: f.rel, start: i, lines: ls });
            });
        }
        return hits.length === 1 ? hits[0] : undefined;
    };
    for (const u of usages) {
        const keys = u.op ? FORWARDED[u.op] : undefined;
        if (!keys || (u.provider !== "anthropic" && u.provider !== "openai") || u.doc || u.inTest)
            continue;
        const f = byRel.get(u.file);
        if (!f)
            continue;
        const ls = f.source.split("\n");
        // The call's spreads, on its line and the next ones of its argument
        const call = ls.slice(u.line - 1, u.line + 30).join("\n");
        const spreads = [...call.slice(0, call.search(/\)\s*;?\s*$/m) + 1 || 2000).matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]);
        for (const sp of new Set(spreads)) {
            // The spread name's declared type: a parameter (sp: T, { … }: T), or a local typed T
            let typeName;
            for (let r = u.line - 1; r >= Math.max(0, u.line - 80) && !typeName; r--) {
                const m = new RegExp(`(?:\\b${sp.replace(/\$/g, "\\$")}\\??\\s*:\\s*([A-Z][\\w]*)\\b)|(?:\\.\\.\\.${sp.replace(/\$/g, "\\$")}\\s*\\}\\s*:\\s*([A-Z][\\w]*)\\b)`).exec(ls[r]);
                typeName = m?.[1] ?? m?.[2];
            }
            if (!typeName)
                continue;
            const t = typeDef(typeName, u.file);
            if (!t)
                continue;
            let depth = 0;
            for (let r = t.start; r < Math.min(t.lines.length, t.start + 200); r++) {
                const l = t.lines[r];
                if (depth === 1 || r === t.start) {
                    for (const [wire, forms] of Object.entries(keys)) {
                        const m = new RegExp(`^\\s*(?:readonly\\s+)?["']?(${forms.join("|")})["']?\\??\\s*:`).exec(l);
                        if (!m)
                            continue;
                        const k = `${t.rel}|${r + 1}|${wire}`;
                        if (seen.has(k))
                            continue;
                        seen.add(k);
                        out.push({
                            provider: u.provider, kind: "sdk", lang: f.lang, file: t.rel, line: r + 1, op: u.op, params: [wire], confidence: "possible",
                            snippet: l.trim().slice(0, 200), reason: `${typeName}.${m[1]} is forwarded by this library to ${u.op} (${u.file}:${u.line}, ...${sp})`,
                        });
                    }
                }
                depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
                if (r > t.start && depth <= 0)
                    break;
            }
        }
    }
    return out;
}
