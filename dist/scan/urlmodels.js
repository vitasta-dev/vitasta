import { modelRef } from "../providers.js";
import { STRING_NODES } from "./urls.js";
/** The methods of Google's model endpoints (":generateContent"), which make a `/models/<id>` segment a request path */
const GOOGLE_PATH = /\/models\/([A-Za-z0-9][\w.@-]*):(?:generateContent|streamGenerateContent|embedContent|batchEmbedContents|countTokens|predict|predictLongRunning|rawPredict|streamRawPredict|generateAnswer|batchEmbedText|embedText|computeTokens)\b/g;
const BEDROCK_PATH = /\/model\/([A-Za-z0-9][\w.@:-]*)\/(?:invoke(?:-with-response-stream)?|converse(?:-stream)?)(?![\w-])/g;
/** Models named in request paths in a piece of text */
export function urlModelsIn(text) {
    if (!text.includes("/model"))
        return [];
    const out = [];
    const vertex = /aiplatform\.googleapis\.com/.test(text);
    for (const m of text.matchAll(GOOGLE_PATH))
        out.push({ id: m[1], at: m.index + "/models/".length, ...(vertex ? { host: "vertex" } : {}) });
    for (const m of text.matchAll(BEDROCK_PATH))
        out.push({ id: m[1], at: m.index + "/model/".length, host: "bedrock" });
    return out;
}
function usageFor(file, lang, line, snippet, spanStart, hit, found) {
    const ref = modelRef(hit.id);
    if (!ref)
        return undefined;
    if (found.some((u) => u.file === file && u.line === line && u.model === ref.model))
        return undefined;
    const host = hit.host ?? ref.host;
    return {
        provider: ref.provider.id, kind: "model-ref", lang, file, line, model: ref.model, setting: true, confidence: "likely",
        snippet: snippet.trim().slice(0, 200), ...(host ? { host } : {}), reason: "the model is named in the request URL's path",
        modelSpan: { start: spanStart, end: spanStart + hit.id.length, kind: "bare" },
    };
}
export function urlModelUsages(tree, file, lang, source, found) {
    const types = STRING_NODES[lang];
    if (!types || !source.includes("/model"))
        return [];
    const lines = source.split("\n");
    const out = [];
    for (const node of tree.rootNode.descendantsOfType(types)) {
        if (!node || node.text.length > 2000 || !node.text.includes("/model"))
            continue;
        if (lang === "py" && node.parent?.type === "expression_statement")
            continue;
        for (const hit of urlModelsIn(node.text)) {
            if (/[${}%]/.test(hit.id))
                continue;
            const at = node.startIndex + hit.at;
            const line = source.slice(0, at).split("\n").length;
            const u = usageFor(file, lang, line, lines[line - 1] ?? "", at, hit, [...found, ...out]);
            if (u)
                out.push(u);
        }
    }
    return out;
}
/** Config files: the same paths in values (url: https://…/models/gemini-1.5-pro:generateContent) */
export function urlModelConfigUsages(file, text, found) {
    if (!text.includes("/model"))
        return [];
    const out = [];
    let off = 0;
    text.split("\n").forEach((l, i) => {
        const start = off;
        off += l.length + 1;
        if (l.length > 2000 || /^\s*(#|\/\/|;)/.test(l))
            return;
        for (const hit of urlModelsIn(l)) {
            const u = usageFor(file, "config", i + 1, l, start + hit.at, hit, [...found, ...out]);
            if (u)
                out.push(u);
        }
    });
    return out;
}
