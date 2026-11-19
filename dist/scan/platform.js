/**
 * Which platform serves a model the code names, when the code says so around it rather than through an SDK client:
 * - the entry it sits in has a provider/platform field: { id: "o4-mini", provider: "azure-openai-responses" };
 * - a key, call or constructor it sits inside names the platform: azure: { deployment_name: "gpt-image-1" },
 *   VertexAIProvider(model=kwargs.get("model", "gemini-2.5-flash"));
 * - the branch it sits in is for the platform: elif API_TYPE == "azure": … / case "bedrock": …;
 * - the file is for the platform: providers/azure/chat/models.ts, githubCopilotProvider.ts, or it only talks to a
 *   platform endpoint (models.github.ai, chatgpt.com/backend-api) and never to the provider's own host.
 *
 * Azure, Vertex and Bedrock have their own retirement records ("host"); GitHub Models, Copilot, the ChatGPT app and
 * VS Code's model API aren't the provider's API at all ("via"), so the provider's API dates don't apply there.
 * Platforms and their names: src/data/model-platforms.json. Plain text scanning, any language.
 */
import { createRequire } from "node:module";
import { PROVIDERS, hostOfClass, partnerProviders } from "../providers.js";
import { linesOf } from "./parser.js";
const DATA = createRequire(import.meta.url)("../data/model-platforms.json");
// A cloud platform also serves the partner vendors src/data/partner-models.json lists for it
for (const p of DATA.platforms)
    if (p.host)
        p.providers = [...new Set([...p.providers, ...partnerProviders(p.host)])];
const NAME = new Map();
for (const p of DATA.platforms)
    for (const n of p.names)
        NAME.set(n.toLowerCase(), p);
const PATH_NAMES = new Set(DATA.pathNames.map((n) => n.toLowerCase()));
/** Words of an identifier or path segment: githubCopilotProvider → github, copilot, provider (and joined pairs) */
function words(s) {
    const parts = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const out = [...parts];
    for (let i = 0; i + 1 < parts.length; i++)
        out.push(`${parts[i]}-${parts[i + 1]}`, `${parts[i]}_${parts[i + 1]}`, parts[i] + parts[i + 1]);
    return out;
}
const byName = (value) => NAME.get(value.toLowerCase()) ?? NAME.get(value.toLowerCase().replace(/[\s_]+/g, "-"));
/** A provider/platform field in an entry: provider: "Github", "api_type": "azure", platform = 'vertex' */
const FIELD = /["']?\b(provider|provider_?id|provider_?name|platform|api_?type|vendor|backend|host_?type|endpoint_?type|deployment_?type|service)\b["']?\s*[:=]\s*["'`]([\w .\/-]{2,40})["'`]/gi;
/** The text of the innermost entry ({…}, (…), […] or a YAML block) around `at`, at most `max` chars each way */
function enclosing(src, at, max = 8000) {
    let depth = 0;
    for (let i = at - 1; i >= Math.max(0, at - max); i--) {
        const c = src[i];
        if (c === "}" || c === ")" || c === "]")
            depth++;
        else if (c === "{" || c === "(" || c === "[") {
            if (depth === 0) {
                const close = { "{": "}", "(": ")", "[": "]" }[c];
                let d = 0;
                for (let j = i + 1; j < Math.min(src.length, at + max); j++) {
                    if (src[j] === c)
                        d++;
                    else if (src[j] === close) {
                        if (d === 0)
                            return { start: i, end: j + 1, open: c };
                        d--;
                    }
                }
                return { start: i, end: Math.min(src.length, at + max), open: c };
            }
            depth--;
        }
    }
    return undefined;
}
/** Same-or-deeper indented lines around line i (a YAML/Python block), and the keys/headers of the blocks above it */
function indentBlocks(lines, i) {
    const ind = (l) => /^\s*/.exec(l)[0].length;
    const base = ind(lines[i]);
    let a = i, b = i;
    while (a > 0 && (lines[a - 1].trim() === "" || ind(lines[a - 1]) >= base) && i - a < 60)
        a--;
    while (b + 1 < lines.length && (lines[b + 1].trim() === "" || ind(lines[b + 1]) >= base) && b - i < 60)
        b++;
    const heads = [];
    let cur = base;
    for (let j = i - 1; j >= 0 && heads.length < 6 && i - j < 400; j--) {
        const l = lines[j];
        if (!l.trim())
            continue;
        if (ind(l) < cur) {
            heads.push(l.trim());
            cur = ind(l);
            if (cur === 0)
                break;
        }
    }
    return { block: lines.slice(a, b + 1).join("\n"), heads };
}
function fieldPlatform(text) {
    let found;
    for (const m of text.matchAll(FIELD)) {
        const p = byName(m[2]);
        if (!p)
            return undefined; // a provider field naming something else (the provider itself): not a platform entry
        if (found && found !== p)
            return undefined;
        found = p;
    }
    return found;
}
/** A key that names a platform (azure:, "vertex": {, azure_models =), whole or as a word of it */
function keyPlatform(key) {
    return byName(key) ?? words(key).filter((w) => PATH_NAMES.has(w)).map(byName).find(Boolean);
}
/** A header line names a platform: azure:, "vertex": {, elif api_type == "azure":, case 'bedrock':, if (x === "azure") { */
function headPlatform(head) {
    const h = head.replace(/[{(\[]\s*$/, "").trim();
    const key = /^["']?([\w.-]+)["']?\s*[:=]\s*$/.exec(h)?.[1];
    if (key)
        return keyPlatform(key);
    const branch = /^(?:}\s*)?(?:if|elif|else\s+if|case|when)\b(.*)$/.exec(h)?.[1];
    if (branch) {
        const q = [...new Set([...branch.matchAll(/["'`]([\w .\/-]{2,40})["'`]/g)].map((m) => byName(m[1])).filter(Boolean))];
        if (q.length === 1)
            return q[0];
    }
    return undefined;
}
/** The label right before an opening bracket: a key (azure: {), a callee (VertexAIProvider(, new AzureOpenAI(), a branch */
function openerPlatform(src, open) {
    const before = src.slice(Math.max(0, open - 200), open);
    if (src[open] === "(") {
        const callee = /([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1];
        const h = callee ? hostOfClass(callee) : undefined;
        return h ? DATA.platforms.find((p) => p.host === h) : undefined;
    }
    const key = /["']?([\w.-]+)["']?\s*[:=]\s*$/.exec(before)?.[1];
    if (key)
        return keyPlatform(key);
    if (src[open] === "{") {
        const line = before.split("\n").pop().trim();
        if (/^(}\s*)?(if|else\s+if|case|when)\b/.test(line))
            return headPlatform(line);
    }
    return undefined;
}
function pathPlatform(rel) {
    const segs = rel.replace(/\.[^./]+$/, "").split("/");
    const hits = new Set();
    for (const s of segs)
        for (const w of words(s))
            if (PATH_NAMES.has(w)) {
                const p = byName(w);
                if (p)
                    hits.add(p);
            }
    return hits.size === 1 ? [...hits][0] : undefined;
}
/** Hosts that are a platform's, not the provider's own API (aiplatform.googleapis.com is Vertex) */
const PLATFORM_TEXT = DATA.platforms.flatMap((p) => p.markers);
/**
 * Only one platform's endpoints in the file (models.github.ai, chatgpt.com/backend-api) or its decisive switch
 * (genai.Client(vertexai=True)), and never the provider's own API host
 */
function markerPlatform(src, provider, at) {
    const own = (PROVIDERS.find((p) => p.id === provider)?.hosts ?? []).filter((h) => !PLATFORM_TEXT.some((m) => m.includes(h)));
    if (own.some((h) => src.includes(h)))
        return undefined;
    const hits = DATA.platforms.filter((p) => (p.via && p.markers.some((m) => src.includes(m))) || (p.fileMarkers ?? []).some((m) => src.includes(m)));
    if (hits.length !== 1)
        return undefined;
    // An endpoint marker must be near the model (within about 80 lines), not somewhere else in a file about many
    // things; a decisive switch (an import, vertexai=True) counts anywhere in the file
    const near = src.slice(Math.max(0, at - 6000), at + 6000);
    if (!(hits[0].fileMarkers ?? []).some((m) => src.includes(m)) && !hits[0].markers.some((m) => near.includes(m)))
        return undefined;
    // A file that also points at other API endpoints (a config listing many) isn't for this platform alone
    for (const m of src.matchAll(/https?:\/\/([\w.-]+)(\/v\d[\w.]*)?/g)) {
        const host = m[1];
        const apiLike = /^api\./.test(host) || !!m[2];
        if (apiLike && !hits[0].markers.some((k) => k.includes(host) || host.endsWith(k.split("/")[0])))
            return undefined;
    }
    // A file that also switches the platform off (vertexai=False) is both
    if (hits[0].id === "vertex" && /vertexai\s*[=:]\s*(False|false)/.test(src))
        return undefined;
    return hits[0];
}
/** Offset of the usage's model text in its file */
function offsetOf(src, u, lineStarts) {
    if (u.modelSpan)
        return u.modelSpan.start;
    const ls = lineStarts[u.line - 1] ?? 0;
    const k = u.model ? src.indexOf(u.model, ls) : -1;
    return k >= 0 && k < (lineStarts[u.line] ?? src.length) ? k : ls;
}
/** The platform a model-ref is served through, from the code around it (see the top of this file) */
export function platformAt(src, rel, u, lineStarts) {
    const at = offsetOf(src, u, lineStarts);
    const indentLang = /\.(ya?ml|py|toml|ini|cfg|conf|properties|env)$|(^|\/)\.env/.test(rel);
    // YAML, TOML, INI and .env have no bracketed entries to speak of (a "(" in a comment isn't one)
    const bracketLang = !/\.(ya?ml|toml|ini|cfg|conf|properties|env)$|(^|\/)\.env/.test(rel);
    // 1) the entry and the brackets around it, innermost first (up to 4 levels)
    let pos = at;
    for (let level = 0; bracketLang && level < 6; level++) {
        const e = enclosing(src, pos);
        if (!e)
            break;
        const text = src.slice(e.start, e.end);
        if (level === 0 || e.open === "{") {
            const f = fieldPlatform(text);
            if (f)
                return f;
        }
        const o = openerPlatform(src, e.start);
        if (o)
            return o;
        pos = e.start;
    }
    // 2) indentation blocks (YAML, Python): the block's fields, then the keys/branches above it
    if (indentLang) {
        const lines = linesOf(src);
        const { block, heads } = indentBlocks(lines, u.line - 1);
        const f = fieldPlatform(block);
        if (f)
            return f;
        for (const h of heads) {
            const p = headPlatform(h);
            if (p)
                return p;
        }
    }
    // 3) the file: its path, or (code only) the one platform endpoint it talks to
    return pathPlatform(rel) ?? (bracketLang && !/\.json$/.test(rel) ? markerPlatform(src, u.provider, at) : undefined);
}
/**
 * Give model-refs that the code places on a platform that platform: host (own retirement records) or via (not the
 * provider's API). Leaves anything already placed alone.
 */
export function placeOnPlatforms(usages, sourceOf) {
    const starts = new Map();
    for (const u of usages) {
        if (u.kind !== "model-ref" || u.host || u.via)
            continue;
        const src = sourceOf(u.file);
        if (!src)
            continue;
        let ls = starts.get(u.file);
        if (!ls) {
            ls = [0];
            for (let i = 0; i < src.length; i++)
                if (src[i] === "\n")
                    ls.push(i + 1);
            starts.set(u.file, ls);
        }
        const p = platformAt(src, u.file, u, ls);
        // Only a platform that serves this provider's models (Vertex doesn't serve gpt-4o)
        if (!p || !p.providers.includes(u.provider))
            continue;
        if (p.host)
            u.host = p.host;
        else
            u.via = p.via;
    }
}
