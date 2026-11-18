/**
 * Basic support for Go, Ruby, PHP and C# (and any future tree-sitter language): string-level analysis.
 *
 * It parses the file properly (so comments never count) and looks at every string literal:
 *  - a URL on a provider's host → an HTTP usage (method guessed from the line, version from the URL)
 *  - a provider version header with its value on the same line → a pinned version
 *  - a model ID in a model-setting position (model: "…", 'model' => '…', Model = "…", GetChatClient("…")) → model usage
 * Deeper analysis (following SDK clients into calls) is language-specific and lives in js.ts / py.ts / java.ts.
 */
import { PROVIDERS, matchUrl, mentionsRouter, modelRef, urlVersionOf } from "../providers.js";
import { alwaysCounts, isFactoryCall, isSettingName } from "./context.js";
import { normalizePath } from "./js.js";
import { lineOf, nodesOfType, snippetOf } from "./parser.js";
const STRING_TYPES = {
    go: ["interpreted_string_literal", "raw_string_literal"],
    rb: ["string"],
    php: ["string", "encapsed_string"],
    cs: ["string_literal", "verbatim_string_literal", "raw_string_literal"],
};
/** Text of a string literal without quotes; undefined if it interpolates variables. */
function literalValue(n, lang) {
    const t = n.text;
    if (lang === "rb" && /#\{/.test(t))
        return undefined;
    if (lang === "php" && n.type === "encapsed_string" && /\$\w|\{\$/.test(t))
        return undefined;
    if (lang === "cs" && /^\$/.test(t))
        return undefined;
    return t.replace(/^@?"""|"""$/g, "").replace(/^[@$]?["'`]|["'`]$/g, "");
}
/** model: "…" / 'model' => '…' / Model = "…" / model := "…" / ->model('…') / GetChatClient("…") right before the string */
const SETTING_BEFORE = /(["']?)([$@]?[\w.\->]*?)\1\s*(?::=|=>|=|:)\s*$/;
const CALL_BEFORE = /([\w.]+|->\w+)\s*\(\s*$/;
/** A list opener plus any earlier elements on the same line: [ / { / ( / array( / new[] { / List.of( / %w( */
const LIST_PREFIX = /(?:\[|\{|\(|array\s*\(|new\s*[\w<>]*\s*\[\]\s*\{|new\s+List<[\w.]+>\s*(?:\(\s*\))?\s*\{|%w[(\[])\s*(?:(?:"[^"]*"|'[^']*'|[\w.:\-]+)\s*,\s*)*$/;
/**
 * Is a string at this position a model setting? Looks at the same line, then (for list items) back to the list
 * opener. List items are "listed" (offered), the rest "setting".
 */
function settingAt(lines, row, before) {
    if (settingOnLine(before))
        return "setting";
    // inline list: MODELS = ["a", "b"]
    const inline = LIST_PREFIX.exec(before);
    if (inline && settingOnLine(before.slice(0, inline.index)))
        return "listed";
    // multi-line list: the item sits alone on its line; find the line that opened the list
    if (/^\s*(?:(?:"[^"]*"|'[^']*')\s*,\s*)*$/.test(before)) {
        for (let r = row - 1; r >= 0 && r >= row - 100; r--) {
            const l = lines[r];
            if (/^\s*(?:"[^"]*"|'[^']*'),?\s*(?:\/\/.*|#.*)?$/.test(l) || /^\s*$/.test(l))
                continue; // another item
            const opener = LIST_PREFIX.exec(l.replace(/\s*(?:\/\/.*|#.*)$/, ""));
            return opener && settingOnLine(l.slice(0, opener.index)) ? "listed" : undefined;
        }
    }
    return undefined;
}
/** A flag or option default: StringVar(&m, "model", "claude-…", "usage") / flag.String("model", "…") / .option("--model <id>", "…") */
const FLAG_BEFORE = /(["'`])-{0,2}([\w.-]+)(?:\s+<[^>]*>)?\1\s*,\s*$/;
function settingOnLine(before) {
    const flag = FLAG_BEFORE.exec(before);
    if (flag && /\(\s*(?:[^()]*,\s*)?$/.test(before.slice(0, flag.index)) && isSettingName(flag[2].replace(/[.-]/g, "_")))
        return true;
    const assign = SETTING_BEFORE.exec(before);
    if (assign && isSettingName(assign[2].replace(/^[$@]|->/g, "").split(/\.|->/).pop() ?? ""))
        return true;
    const call = CALL_BEFORE.exec(before);
    if (call) {
        const name = call[1].replace(/^->/, "");
        return isSettingName(name) || isFactoryCall(name) || /^(GetChatClient|GetEmbeddingClient|GetImageClient|GetAudioClient|GetResponsesClient|NewChatClient)$/.test(name.split(".").pop() ?? "");
    }
    return false;
}
export function analyzeGeneric(file, lang, source, tree) {
    const types = STRING_TYPES[lang];
    if (!types)
        return [];
    const lines = source.split("\n");
    const out = [];
    const strings = nodesOfType(tree.rootNode, types);
    const routed = mentionsRouter(source);
    for (let i = 0; i < strings.length; i++) {
        const s = strings[i];
        const v = literalValue(s, lang);
        if (v === undefined || !v)
            continue;
        const row = s.startPosition.row;
        const lineText = lines[row] ?? "";
        const before = lineText.slice(0, s.startPosition.column);
        // 1. URL on a provider's host
        if (/^https?:\/\//.test(v)) {
            const hit = matchUrl(v);
            if (hit) {
                const method = /\b(POST|Post|post|:post|MethodPost|PostAsync|http\.Post)\b/.test(lineText) ? "POST" : /\b(PUT|Put|put|PutAsync)\b/.test(lineText) ? "PUT" : /\b(DELETE|Delete|delete|DeleteAsync)\b/.test(lineText) ? "DELETE" : "GET";
                const ver = urlVersionOf(hit.provider, v);
                out.push({
                    provider: hit.provider.id, kind: "http", lang, file, line: lineOf(s),
                    op: `${method} ${normalizePath(hit.path)}`, confidence: "likely", snippet: snippetOf(source, s),
                    apiVersion: ver ? `url: ${ver}` : undefined,
                    host: v.includes("aiplatform.googleapis.com") ? "vertex" : undefined,
                });
            }
            continue;
        }
        // 2. "anthropic-version", "2023-06-01" (a header and its value on the same line)
        const header = PROVIDERS.find((p) => p.versionHeaders.includes(v.toLowerCase()));
        if (header) {
            const next = strings[i + 1];
            const value = next && next.startPosition.row === row ? literalValue(next, lang) : undefined;
            if (value)
                out.push({
                    provider: header.id, kind: "version-pin", lang, file, line: lineOf(s),
                    apiVersion: `${v.toLowerCase()}: ${value}`, confidence: "certain", snippet: snippetOf(source, s),
                });
            continue;
        }
        // 3. A model ID in a model-setting position
        const ref = modelRef(v, routed);
        if (!ref)
            continue;
        // A cloud-form ID counts anywhere except as a map key ("claude-…@…": 200000 / "…" => …)
        const isKey = /^\s*(?::(?!=)|=>)/.test(lineText.slice(s.endPosition.column));
        const kind = settingAt(lines, row, before) ?? (alwaysCounts(ref.model) && !isKey ? "setting" : undefined);
        if (!kind)
            continue;
        out.push({
            ...(kind === "listed" ? { listed: true } : {}),
            provider: ref.provider.id, kind: "model-ref", lang, file, line: lineOf(s),
            model: ref.model, confidence: "possible", snippet: snippetOf(source, s), ...(ref.host ? { host: ref.host } : {}),
            modelSpan: ref.prefixed ? undefined : { start: s.startIndex, end: s.endIndex, kind: "string" },
        });
    }
    return out;
}
