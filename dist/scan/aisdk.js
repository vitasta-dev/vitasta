export const PROVIDER_OPS = {
    anthropic: { pkg: "@ai-sdk/anthropic", op: "POST /v1/messages" },
    openai: { pkg: "@ai-sdk/openai", op: "POST /v1/chat/completions" },
};
export const PARAM_NAMES = { temperature: "temperature", topP: "top_p", topK: "top_k", maxTokens: "max_tokens", maxOutputTokens: "max_tokens", stopSequences: "stop_sequences", seed: "seed", presencePenalty: "presence_penalty", frequencyPenalty: "frequency_penalty" };
const CALL = /\b(generateText|streamText|generateObject|streamObject)\s*\(\s*\{/g;
/** Factories imported from a provider package (import { anthropic, createAnthropic } from '@ai-sdk/anthropic'), and
 * names bound to one (const anthropic = createAnthropic({…})): name → provider */
export function aiSdkFactories(source) {
    const factories = new Map();
    for (const [prov, { pkg }] of Object.entries(PROVIDER_OPS)) {
        for (const m of source.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${pkg.replace(/[/@]/g, "\\$&")}["']`, "g"))) {
            for (const n of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean))
                factories.set(n, prov);
        }
        // const anthropic = createAnthropic({…})
        for (const m of source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(create\w+)\s*\(/g))
            if (factories.get(m[2]) === prov)
                factories.set(m[1], prov);
    }
    return factories;
}
/** The closing bracket of the one opening at `open` (strings and comments blanked), within 20,000 characters */
export function closeAt(blanked, open) {
    let depth = 0;
    for (let j = open; j < Math.min(blanked.length, open + 20000); j++) {
        const c = blanked[j];
        if (c === "{" || c === "(" || c === "[")
            depth++;
        else if ((c === "}" || c === ")" || c === "]") && --depth === 0)
            return j;
    }
    return open;
}
/** Top-level keys of the object literal from `open` to `end`: key: …, shorthand, ...spread (name), with offsets */
export function topKeys(source, blanked, open, end) {
    const out = [];
    let d = 0;
    for (let j = open; j <= end; j++) {
        const c = blanked[j];
        if (c === "{" || c === "(" || c === "[")
            d++;
        else if (c === "}" || c === ")" || c === "]")
            d--;
        if (d !== 1 || !/[{,\s]/.test(source[j - 1] ?? "{"))
            continue;
        const rest = source.slice(j, Math.min(end, j + 300));
        const sp = /^\.\.\.\s*([\w$.]+)/.exec(rest);
        if (sp) {
            out.push({ key: "...", at: j, value: sp[1], spread: true });
            j += sp[0].length - 1;
            continue;
        }
        const k = /^([A-Za-z_$][\w$]*)\s*(:|,|\n|\})/.exec(rest);
        if (!k)
            continue;
        let value = k[1];
        if (k[2] === ":") {
            // The value up to the next top-level comma or the end
            let e = j + k[0].length, dd = 0;
            for (; e < end; e++) {
                const ch = blanked[e];
                if (ch === "{" || ch === "(" || ch === "[")
                    dd++;
                else if (ch === "}" || ch === ")" || ch === "]")
                    dd--;
                if (dd < 0 || (dd === 0 && ch === ","))
                    break;
            }
            value = source.slice(j + k[0].length, e).trim();
        }
        out.push({ key: k[1], at: j, value });
        j += k[0].length - 1;
    }
    return out;
}
export function aiSdkUsages(file, lang, source) {
    if ((lang !== "ts" && lang !== "js") || source.length > 2_000_000 || !/\b(generateText|streamText|generateObject|streamObject)\b/.test(source))
        return [];
    const factories = aiSdkFactories(source);
    const lines = source.split("\n");
    const starts = [];
    let at = 0;
    for (const l of lines) {
        starts.push(at);
        at += l.length + 1;
    }
    const out = [];
    let blanked0;
    for (const m of source.matchAll(CALL)) {
        const open = m.index + m[0].length - 1;
        // The options object: up to its closing brace, depth-tracked, strings blanked
        let depth = 0;
        let end = open;
        const blanked = blanked0 ??= blankCode(source);
        for (let j = open; j < Math.min(source.length, open + 20000); j++) {
            const c = blanked[j];
            if (c === "{" || c === "(" || c === "[")
                depth++;
            else if ((c === "}" || c === ")" || c === "]") && --depth === 0) {
                end = j;
                break;
            }
        }
        const body = source.slice(open, end + 1);
        const model = /\bmodel\s*:\s*(?:(\w+)\s*(?:\.\w+)?\s*\(|["'`](\w+)\/)/.exec(body);
        let prov = model ? (model[1] ? factories.get(model[1]) : model[2]) : undefined;
        // v13: the model held in a name (const model = anthropic('…'); generateText({ model, … }) / { model: chatModel })
        if (!prov) {
            const held = /\bmodel\s*(?::\s*(\w+)\s*[,}\n]|[,}\n])/.exec(body);
            const name = held ? held[1] ?? "model" : undefined;
            const bound = name ? new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(\\w+)\\s*(?:\\.\\w+)?\\s*\\(`).exec(source) : undefined;
            if (bound)
                prov = factories.get(bound[1]);
        }
        // v17: the model id when it's written in the call (anthropic('claude-…')), or held in a name bound to one
        let aiSdk;
        if (prov === "anthropic" && !(model && model[2])) {
            const expr = modelExpr(body);
            const held = expr && /^[\w$]+$/.test(expr) ? new RegExp(`\\b(?:const|let|var)\\s+${expr}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`).exec(source)?.[1] : undefined;
            const id = /\(\s*["'`]([\w.:@/-]+)["'`]\s*\)/.exec(held ?? expr ?? "")?.[1];
            aiSdk = id ? { model: id } : {};
        }
        // v17: the model picked at runtime (getModel(opts), resolveProvider(cfg, providerMap)): Anthropic's when a name in
        // the model expression reaches an Anthropic factory from @ai-sdk/anthropic in this file, within three hops
        if (!prov && [...factories.values()].includes("anthropic")) {
            const expr = modelExpr(body);
            const path = expr ? wiring(source, expr, [...factories].filter(([, p]) => p === "anthropic").map(([n]) => n)) : undefined;
            if (path) {
                prov = "anthropic";
                aiSdk = { runtime: path };
            }
        }
        if (!prov || !PROVIDER_OPS[prov])
            continue;
        const op = PROVIDER_OPS[prov].op;
        // Top-level keys (key: …, shorthand, ...spreadIfDefined('key', …))
        const bodyBlank = blanked.slice(open, end + 1);
        let d = 0;
        for (let j = 0; j < body.length; j++) {
            const c = bodyBlank[j];
            if (c === "{" || c === "(" || c === "[")
                d++;
            else if (c === "}" || c === ")" || c === "]")
                d--;
            if (d !== 1 || !/[{,\s]/.test(body[j - 1] ?? "{"))
                continue;
            const k = /^(\w+)\s*(?::|,|\n|\s*\})/.exec(body.slice(j)) ?? /^\.\.\.\s*\w+\(\s*["'](\w+)["']/.exec(body.slice(j));
            if (!k)
                continue;
            const name = PARAM_NAMES[k[1]];
            if (!name)
                continue;
            const off = open + j;
            const line = source.slice(0, off).split("\n").length;
            out.push({
                provider: prov, kind: "sdk", lang, file, line, op, sdkCall: m[1], params: [name], confidence: "likely",
                snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `${k[1]} in an AI SDK ${m[1]} call to ${prov}`, paramSpans: { [name]: { start: off, end: starts[line - 1] + lines[line - 1].length } },
                ...(aiSdk ? { aiSdk } : {}),
            });
            j += k[0].length - 1;
        }
    }
    return out;
}
/** The `model:` value of a call's options (up to the next top-level comma), or the name for shorthand `model,` */
function modelExpr(body) {
    const m = /[{,\s]model\s*(:|,|\n|\})/.exec(body);
    if (!m)
        return undefined;
    if (m[1] !== ":")
        return "model";
    let d = 0;
    const from = m.index + m[0].length;
    for (let j = from; j < Math.min(body.length, from + 500); j++) {
        const c = body[j];
        if (c === "(" || c === "[" || c === "{")
            d++;
        else if (c === ")" || c === "]" || c === "}") {
            if (d === 0)
                return body.slice(from, j).trim();
            d--;
        }
        else if (c === "," && d === 0)
            return body.slice(from, j).trim();
    }
    return undefined;
}
const KEYWORDS = new Set(["this", "await", "new", "return", "const", "let", "var", "function", "async", "true", "false", "null", "undefined", "process", "env", "model"]);
/**
 * v17: a path from a name in `expr` to an Anthropic factory call, through the definitions of names in this file
 * (a function, a variable, a method, an object key), at most three hops. Returns it as text for the finding's note.
 */
function wiring(source, expr, factories) {
    const call = new RegExp(`(?<![\\w$.])(?:${factories.map((f) => f.replace(/[$]/g, "\\$&")).join("|")})\\s*\\(`);
    const seen = new Set();
    const step = (text, path, depth) => {
        const hit = call.exec(text);
        if (hit)
            return [...path, hit[0].replace(/\s*\($/, "")].join(" → ");
        if (depth >= 3)
            return undefined;
        for (const [, name] of text.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)/g)) {
            if (seen.has(name) || KEYWORDS.has(name) || seen.size > 40)
                continue;
            seen.add(name);
            for (const span of definitions(source, name)) {
                const r = step(span, [...path, name], depth + 1);
                if (r)
                    return r;
            }
        }
        return undefined;
    };
    // A name the model expression itself is (model, used as shorthand) counts as a hop too
    return step(expr === "model" ? "model" : expr.replace(call, "\u0000"), [], 0)?.replace(/\u0000/g, "");
}
/** Text of each definition of `name` in the file: function / method bodies, a variable's or key's value */
function definitions(source, name) {
    const n = name.replace(/[$]/g, "\\$&");
    const out = [];
    const res = [
        new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*(?=\\()`, "g"),
        new RegExp(`(?:\\b(?:const|let|var)\\s+|\\bthis\\.|^[ \\t]*(?:(?:private|public|protected|readonly|static)\\s+)*)${n}\\s*(?::[^=\\n]+)?=(?![=>])`, "gm"),
        new RegExp(`^[ \\t]*(?:(?:async|static|private|public|protected)\\s+)*${n}\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{`, "gm"),
        new RegExp(`[{,]\\s*["']?${n}["']?\\s*:`, "g"),
    ];
    for (const re of res) {
        for (const m of source.matchAll(re)) {
            const start = m.index + m[0].length;
            out.push(valueSpan(source, start));
            if (out.length > 6)
                return out;
        }
    }
    return out;
}
/** From `start`: up to the end of the first balanced block, or the statement / entry (a top-level , ; or line end) */
function valueSpan(source, start) {
    let d = 0;
    let opened = false;
    for (let j = start; j < Math.min(source.length, start + 8000); j++) {
        const c = source[j];
        if (c === "(" || c === "[" || c === "{") {
            d++;
            opened = true;
        }
        else if (c === ")" || c === "]" || c === "}") {
            if (d === 0)
                return source.slice(start, j);
            if (--d === 0 && opened && c === "}")
                return source.slice(start, j + 1);
        }
        else if (d === 0 && (c === ";" || c === "," || (c === "\n" && opened)))
            return source.slice(start, j);
    }
    return source.slice(start, start + 8000);
}
/**
 * v17: comments and strings blanked to spaces (same length, newlines kept). Comments first, and '…' / "…" end at the
 * line: an apostrophe in a comment (the workspace's …) no longer swallows the code after it
 */
export function blankCode(source) {
    return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|(["'])(?:\\.|(?!\1)[^\\\n])*\1|`(?:\\[\s\S]|[^\\`])*`/g, (s) => s.replace(/[^\n]/g, " "));
}
