const WIRE = { temperature: "temperature", top_p: "top_p", topP: "top_p", top_k: "top_k", topK: "top_k" };
export function claudeConfigUsages(files, found) {
    const out = [];
    const have = new Set(found.filter((u) => u.provider === "anthropic").flatMap((u) => [u.line, ...(u.alsoLines ?? [])].flatMap((l) => (u.params ?? []).map((p) => `${u.file}|${l}|${p}`))));
    for (const f of files) {
        if (!["py", "ts", "js", "rb"].includes(f.lang) || f.source.length > 2_000_000 || !/claude-/.test(f.source))
            continue;
        const src = f.source;
        for (const m of src.matchAll(/["']?model["']?\s*(?::|=>|=)\s*["'](?:anthropic\/)?claude-[\w.:@-]+["']/g)) {
            // the innermost braces around the model key
            let d = 0, open = -1;
            for (let i = m.index - 1; i >= Math.max(0, m.index - 4000); i--) {
                const c = src[i];
                if (c === "}")
                    d++;
                else if (c === "{") {
                    if (d === 0) {
                        open = i;
                        break;
                    }
                    d--;
                }
            }
            if (open < 0)
                continue;
            let close = -1;
            d = 0;
            for (let i = open; i < Math.min(src.length, open + 6000); i++) {
                const c = src[i];
                if (c === "{")
                    d++;
                else if (c === "}" && --d === 0) {
                    close = i;
                    break;
                }
            }
            if (close < 0)
                continue;
            const body = src.slice(open, close);
            for (const k of body.matchAll(/["']?\b(temperature|top_p|topP|top_k|topK)\b["']?\s*(?::|=>|=(?!=))\s*([^,}\n]+)/g)) {
                // only the literal's own keys (not a nested object's)
                const inner = body.slice(0, k.index);
                if ((inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length !== 1)
                    continue;
                const wire = WIRE[k[1]];
                const line = src.slice(0, open + k.index).split("\n").length;
                if (have.has(`${f.rel}|${line}|${wire}`))
                    continue;
                have.add(`${f.rel}|${line}|${wire}`);
                out.push({
                    provider: "anthropic", kind: "sdk", lang: f.lang, file: f.rel, line, op: "POST /v1/messages", params: [wire], confidence: "possible",
                    snippet: (src.split("\n")[line - 1] ?? "").trim().slice(0, 200), reason: `${wire} set next to a Claude model in the same config`,
                });
            }
        }
    }
    return out;
}
/**
 * A client built for Anthropic by name (AgentClient(provider="anthropic"), new Llm({ provider: "anthropic" }),
 * chat(provider::anthropic)) whose call passes sampling settings: "possible"
 * Anthropic settings at their lines. Chained (X(provider=…).call(…, temperature=…)) or through a variable assigned in
 * the same file.
 */
export function namedProviderCallUsages(files, found) {
    const out = [];
    const have = new Set(found.filter((u) => u.provider === "anthropic").flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
    const PROV = /\bprovider\s*(?:=|:|=>)\s*(?:["']anthropic["']|:anthropic\b)/;
    for (const f of files) {
        if (!["py", "ts", "js", "rb"].includes(f.lang) || f.source.length > 2_000_000 || !PROV.test(f.source))
            continue;
        const src = f.source;
        const close = (open) => {
            let d = 0;
            for (let i = open; i < Math.min(src.length, open + 4000); i++) {
                const c = src[i];
                if (c === "(")
                    d++;
                else if (c === ")" && --d === 0)
                    return i;
            }
            return -1;
        };
        const calls = [];
        // chained: Ctor(… provider="anthropic" …).method(
        for (const m of src.matchAll(/\b[A-Za-z_]\w*\s*\(/g)) {
            const o = m.index + m[0].length - 1;
            const c = close(o);
            if (c < 0 || !PROV.test(src.slice(o, c)))
                continue;
            const next = /^\s*\.\s*\w+[!?]?\s*\(/.exec(src.slice(c + 1, c + 200));
            if (next)
                calls.push(c + 1 + next[0].length - 1);
            // assigned: x = Ctor(… provider="anthropic" …) then x.method(
            const v = /(?:^|[\s;(,])(?:(?:const|let|var)\s+)?(@?[A-Za-z_]\w*)\s*=\s*(?:new\s+)?$/.exec(src.slice(Math.max(0, m.index - 80), m.index));
            if (v)
                for (const u of src.matchAll(new RegExp(`(?<![\\w$])${v[1].replace(/[$@]/g, "\\$&")}\\s*\\.\\s*\\w+[!?]?\\s*\\(`, "g")))
                    if (u.index > c)
                        calls.push(u.index + u[0].length - 1);
        }
        for (const o of calls) {
            const c = close(o);
            if (c < 0)
                continue;
            const args = src.slice(o, c);
            for (const k of args.matchAll(/(?<![\w$.])(temperature|top_p|topP|top_k|topK)\s*(?:=(?!=)|:(?!:)|=>)\s*/g)) {
                const wire = WIRE[k[1]];
                const line = src.slice(0, o + k.index).split("\n").length;
                if (have.has(`${f.rel}|${line}|${wire}`))
                    continue;
                have.add(`${f.rel}|${line}|${wire}`);
                out.push({
                    provider: "anthropic", kind: "sdk", lang: f.lang, file: f.rel, line, op: "POST /v1/messages", params: [wire], confidence: "possible",
                    snippet: (src.split("\n")[line - 1] ?? "").trim().slice(0, 200), reason: `${wire} passed to a client built with provider anthropic`,
                });
            }
        }
    }
    return out;
}
/**
 * An OpenAI Responses prompt object built by hand ($payload['prompt'] = ['id' => $id], body.prompt = { id }, "prompt":
 * {"id": …}) in a file that sends to a /responses destination (a URL or path ending in /responses, or a helper named
 * for it): the Responses prompt parameter.
 */
export function promptObjectUsages(files, found) {
    const out = [];
    const have = new Set(found.filter((u) => u.params?.includes("prompt")).map((u) => `${u.file}|${u.line}`));
    for (const f of files) {
        if (f.source.length > 2_000_000 || !/responses/i.test(f.source))
            continue;
        if (!/\/responses\b|responses_?api|ResponsesApi|responses_url|ResponsesUrl/i.test(f.source))
            continue;
        f.source.split("\n").forEach((l, i) => {
            // (and Go / C# / Java typed forms: req.Prompt = &PromptConfig{ID: id}, Prompt: &openai.Prompt{ID: …}, new Prompt { Id = … })
            const typed = /\bPrompt\s*(?:=(?!=)|:)\s*(?:&|new\s+)?[\w.]*\s*\{\s*(?:ID|Id)\s*[:=]/.test(l);
            if ((!typed && !/(?:\[\s*["']prompt["']\s*\]\s*=|["']?\bprompt["']?\s*(?::|=>|=(?!=)))\s*(?:\[|\{|array\s*\()\s*["']?id["']?\s*(?::|=>)/.test(l)) || have.has(`${f.rel}|${i + 1}`))
                return;
            have.add(`${f.rel}|${i + 1}`);
            out.push({
                provider: "openai", kind: "http", lang: f.lang, file: f.rel, line: i + 1, op: "POST /v1/responses", params: ["prompt"], confidence: "likely",
                snippet: l.trim().slice(0, 200), reason: "a Responses prompt object ({ id: … }) in a file that sends to /responses",
            });
        });
    }
    return out;
}
