const WIRE = { temperature: "temperature", topP: "top_p", topK: "top_k" };
const TESTISH = /(^|\/)(tests?|__tests__|spec|__mocks__)\/|\.(test|spec)\.[jt]sx?$/;
export function mastraUsages(files, manifestsText, found) {
    if (!/"@mastra\/core"/.test(manifestsText))
        return [];
    const ts = files.filter((f) => (f.lang === "ts" || f.lang === "js") && f.source.length <= 2_000_000 && !TESTISH.test(f.rel));
    const reach = /"@ai-sdk\/anthropic"|"@anthropic-ai\/sdk"/.test(manifestsText) || ts.some((f) => /["'`]anthropic\/claude/.test(f.source));
    if (!reach)
        return [];
    const version = /"@mastra\/core"\s*:\s*"[~^>=\s]*([\d.]+)/.exec(manifestsText)?.[1];
    const have = new Set(found.filter((u) => u.provider === "anthropic").flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
    const out = [];
    for (const f of ts) {
        if (!f.source.includes("modelSettings"))
            continue;
        const lines = f.source.split("\n");
        const lineAt = (at) => f.source.slice(0, at).split("\n").length;
        for (const m of f.source.matchAll(/\bmodelSettings\s*:\s*\{/g)) {
            // the object's own braces (spreads of { temperature: … } inside it included)
            const open = m.index + m[0].length - 1;
            let d = 0, close = -1;
            for (let j = open; j < Math.min(f.source.length, open + 4000); j++) {
                const c = f.source[j];
                if (c === "{" || c === "(" || c === "[")
                    d++;
                else if ((c === "}" || c === ")" || c === "]") && --d === 0) {
                    close = j;
                    break;
                }
            }
            if (close < 0)
                continue;
            const body = f.source.slice(open, close);
            for (const k of body.matchAll(/(?<![\w$.])(temperature|topP|topK)\s*(?::(?!:)|(?=\s*[,}]))/g)) {
                const wire = WIRE[k[1]];
                const line = lineAt(open + k.index);
                if (have.has(`${f.rel}|${line}|${wire}`))
                    continue;
                have.add(`${f.rel}|${line}|${wire}`);
                out.push({
                    provider: "anthropic", kind: "sdk", lang: f.lang, file: f.rel, line, op: "POST /v1/messages", params: [wire], confidence: "possible",
                    snippet: (lines[line - 1] ?? "").trim().slice(0, 200),
                    reason: `${wire} in a Mastra agent's modelSettings: @mastra/core${version ? ` ${version}` : ""} passes it to the agent's model call; Anthropic when that model is a Claude model`,
                });
            }
        }
    }
    return out;
}
