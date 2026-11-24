const SAMPLING = ["temperature", "top_p", "top_k"];
export function pythonProviderUsages(files, manifestsText, found) {
    const py = files.filter((f) => f.lang === "py" && f.source.includes("init_chat_model(") && !/(^|\/)tests?\/|test_[^/]*\.py$|_test\.py$/.test(f.rel));
    if (!py.length)
        return [];
    const depAnthropic = /\blangchain[-_]anthropic\b/i.test(manifestsText);
    const namesAnthropic = depAnthropic || /\banthropic\b/i.test(manifestsText) || files.some((f) => f.lang === "py" && /["']anthropic["']/.test(f.source));
    const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
    const out = [];
    for (const f of py) {
        const lines = f.source.split("\n");
        const lineAt = (at) => f.source.slice(0, at).split("\n").length;
        for (const m of f.source.matchAll(/\binit_chat_model\s*\(/g)) {
            const open = m.index + m[0].length - 1;
            let d = 0, close = -1;
            for (let j = open; j < Math.min(f.source.length, open + 8000); j++) {
                const c = f.source[j];
                if (c === "(" || c === "[" || c === "{")
                    d++;
                else if (c === ")" || c === "]" || c === "}") {
                    if (--d === 0) {
                        close = j;
                        break;
                    }
                }
            }
            if (close < 0)
                continue;
            const args = f.source.slice(open + 1, close);
            const kw = (name) => new RegExp(`(?:^|[,(\\s])${name}\\s*=\\s*([^,\\n]+)`).exec(args)?.[1]?.trim();
            const prov = kw("model_provider");
            const model = kw("model") ?? /^\s*([^,=\n]+?)\s*(?:,|$)/.exec(args)?.[1]?.trim();
            const literal = (v) => !!v && /^["'][^"']*["']$/.test(v);
            let why;
            if (prov && !literal(prov) && !(model && literal(model)) && depAnthropic)
                why = `the provider comes from ${prov} (configuration) and the repo depends on langchain-anthropic`;
            else if (model && /\+\s*["']\/["']|f["'][^"']*\{[^}]+\}\/\{/.test(model) && kw("base_url") && namesAnthropic)
                why = `a provider-prefixed model id (${model}) through an OpenAI-compatible proxy (${kw("base_url")}), and the repo names Anthropic`;
            if (!why)
                continue;
            for (const w of SAMPLING) {
                const k = new RegExp(`(?:^|[,(\\s])(${w})\\s*=`).exec(args);
                if (!k)
                    continue;
                const line = lineAt(open + 1 + k.index + k[0].indexOf(w));
                if (have.has(`${f.rel}|${line}|${w}`))
                    continue;
                out.push({
                    provider: "anthropic", kind: "sdk", lang: "py", file: f.rel, line, op: "POST /v1/messages", params: [w], confidence: "possible",
                    snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `${w} in init_chat_model: ${why}`, alsoLines: [lineAt(m.index)],
                });
            }
        }
    }
    return out;
}
