import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { mentionsRouter, modelRef } from "../providers.js";
import { alwaysCounts, configKeySetting, isSettingName } from "./context.js";
import { DATA_OWNER, NAME_LIST } from "./shapes.js";
/**
 * Model IDs often live outside code: YAML/JSON/TOML config, .env files, and Jupyter notebook code cells.
 * We don't parse these as code; we only look for tokens that are model IDs. Every hit is "possible".
 */
const CONFIG_EXT = /\.(ya?ml|json|toml|properties|ini|cfg|conf)$/i;
const ENV_FILE = /^\.env(\..+)?$|\.env$/;
const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Pipfile.lock", "composer.lock", "tsconfig.json", "jsconfig.json"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "venv", ".venv", "__pycache__", "target", ".gradle", "vendor", "coverage"]);
const MAX_BYTES = 2_000_000;
const TOKEN = /[A-Za-z0-9][\w.:@\/-]*[\w]/g;
/** Data written by programs, not configuration: results, outputs, recorded responses, logs, test recordings */
const DATA_PATH = /(^|\/|[-_.])(results?|outputs?|responses?|logs?|traces?|predictions?|cassettes?|recordings?|snapshots?|golden|expected|transcripts?|generations?|benchmarks?|leaderboards?|evals?|runs?|corpus|corpora|holdout|datasets?)([-_.\/]|$)/i;
/** Keys only an API response has: a "model" near two of these is a recorded response, not a setting */
const RESPONSE_KEY = /["']?(choices|usage|created|system_fingerprint|finish_reason|stop_reason|prompt_tokens|completion_tokens|input_tokens|output_tokens|usage_metadata|usageMetadata|candidates|modelVersion|logprobs)["']?\s*:/;
export async function scanConfigAndNotebooks(root) {
    const out = [];
    async function walk(dir) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name))
                    await walk(full);
                continue;
            }
            if (!e.isFile() || SKIP_FILES.has(e.name))
                continue;
            const isNotebook = e.name.endsWith(".ipynb");
            if (!isNotebook && !CONFIG_EXT.test(e.name) && !ENV_FILE.test(e.name))
                continue;
            if ((await stat(full)).size > MAX_BYTES)
                continue;
            const text = await readFile(full, "utf8").catch(() => "");
            const rel = relative(root, full);
            // A knowledge base of retirements (dates, replacements) names models as data
            if (!isNotebook && retirementData(text))
                continue;
            // An OpenAPI/Swagger spec documents request shapes; its model values are examples
            if (!isNotebook && /^\s*["']?(openapi|swagger)["']?\s*:\s*["']?\d/m.test(text.slice(0, 2000)))
                continue;
            // JSON/YAML a program wrote (results, recorded responses, logs) holds model names as data
            if (!isNotebook && !ENV_FILE.test(e.name) && DATA_PATH.test(rel.replace(/\.[^./]+$/, "")))
                continue;
            out.push(...(isNotebook ? notebookRefs(rel, text) : textRefs(rel, text, "config")));
        }
    }
    await walk(root);
    return out;
}
function textRefs(file, text, lang, lineOffset = 0, lineMap) {
    const out = [];
    const lines = text.split("\n");
    const routed = mentionsRouter(text);
    let lineStart = 0;
    lines.forEach((line, i) => {
        const offset = lineStart;
        lineStart += line.length + 1;
        // A commented-out line (.env, YAML, TOML, INI, JSONC, notebook code) is not a setting
        if (/^\s*(#|\/\/|;)/.test(line))
            return;
        for (const m of line.matchAll(TOKEN)) {
            const tok = m[0];
            const ref = modelRef(tok, routed);
            if (!ref)
                continue;
            // Only model settings count: model: x, MODEL_ID=x, "model": "x", or an item in a list under a model key. A
            // cloud-form ID counts anywhere except as a key ("claude-…@…": 200000)
            const isKey = /^["']?\s*:/.test(line.slice((m.index ?? 0) + tok.length));
            if (lang === "config" && recordedResponse(lines, i))
                continue;
            const strict = settingAt(lines, i, line.slice(0, m.index ?? 0), lang) ?? (alwaysCounts(ref.model) && !isKey ? "setting" : undefined);
            // Otherwise an item in a list of models, or a value in a map of models, counts if the repo uses the provider
            const kind = strict ?? (lang === "config" && !isKey && (inModelBlock(lines, i, routed) || inEntryTable(lines, i, line.slice(0, m.index ?? 0), routed)) ? "listed" : undefined);
            if (!kind)
                continue;
            out.push({
                ...(kind === "listed" ? { listed: true } : {}),
                ...(strict ? {} : { weak: true }),
                provider: ref.provider.id, kind: "model-ref", lang, file,
                line: lineMap ? lineMap[i] : i + 1 + lineOffset,
                model: ref.model, confidence: "possible", snippet: line.trim().slice(0, 200), ...(ref.host ? { host: ref.host } : {}),
                // Only plain config files can be edited by offset (notebook cells are JSON-escaped inside the file), and a
                // prefixed ID ("anthropic/claude-x") isn't rewritten: the replacement has no prefix
                modelSpan: lang === "config" && !ref.prefixed ? { start: offset + (m.index ?? 0), end: offset + (m.index ?? 0) + tok.length, kind: "bare" } : undefined,
            });
        }
    });
    return out;
}
/** Only code cells; line numbers point at the line inside the .ipynb JSON so editors can jump there. */
function notebookRefs(file, json) {
    let nb;
    try {
        nb = JSON.parse(json);
    }
    catch {
        return [];
    }
    const jsonLines = json.split("\n");
    const out = [];
    let searchFrom = 0;
    for (const cell of nb.cells ?? []) {
        const src = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
        if (cell.cell_type !== "code" || !src)
            continue;
        const cellLines = src.split("\n");
        // Map each cell line to its line in the raw JSON (best effort: first match after the previous one)
        const map = cellLines.map((l) => {
            const needle = JSON.stringify(l).slice(1, -1).slice(0, 60);
            if (!needle.trim())
                return searchFrom + 1;
            // Bounded look-ahead: a miss must not rescan the rest of a large notebook (quadratic on crafted files)
            for (let j = searchFrom; j < Math.min(jsonLines.length, searchFrom + 400); j++) {
                if (jsonLines[j].includes(needle)) {
                    searchFrom = j;
                    return j + 1;
                }
            }
            return searchFrom + 1;
        });
        out.push(...textRefs(file, src, "notebook", 0, map));
    }
    return out;
}
/** Keys a record about a model's retirement has: retired_on, deprecation_date, shutdown, sunset, replacement */
const RETIREMENT_KEY = /^\s*-?\s*["']?(retire\w*|deprecat\w*|shut_?down\w*|sunset\w*|end_of_life|eol(_date)?|replace(ment|d_by)\w*|successor|migrat(e|ion)_to)["']?\s*:/gim;
/** A retirement key with a date: retired_on: 2026-01-05, "shutdown_date": "2026-06-30" */
const DATED_RETIREMENT = /^\s*-?\s*["']?(retire\w*|deprecat\w*|shut_?down\w*|sunset\w*|end_of_life|eol(_date)?)["']?\s*:\s*["']?\d{4}-\d{2}(-\d{2})?/im;
/**
 * At least two different retirement keys, one of them dated: a file of retirement records, not a config. (A
 * settings schema with "deprecated": true on some fields isn't one.)
 */
function retirementData(text) {
    if (!DATED_RETIREMENT.test(text))
        return false;
    const keys = new Set([...text.matchAll(RETIREMENT_KEY)].map((m) => m[1].toLowerCase().replace(/_?(date|on|at)$/, "").slice(0, 7)));
    return keys.size >= 2;
}
/** Two or more response-only keys near this line: a recorded API response */
function recordedResponse(lines, i) {
    let hits = 0;
    for (let j = Math.max(0, i - 12); j < Math.min(lines.length, i + 13); j++)
        if (RESPONSE_KEY.test(lines[j]) && ++hits >= 2)
            return true;
    return false;
}
const isModel = (t, routed) => !!modelRef(t.replace(/^["']|["',]+$/g, ""), routed);
const valueOf = (l) => {
    const m = /^\s*(?:-\s*|["']?[\w.\-]+["']?\s*[:=]\s*)?["']?([A-Za-z0-9][\w.:@\/-]*[\w])["']?\s*,?\s*(#.*)?$/.exec(l);
    return m?.[1];
};
/**
 * A list item or a map value in a block (same indentation) that holds at least two model IDs, under a key that
 * isn't about prices, limits or capabilities: YAML "- gpt-4o" lists, JSON string arrays, "fast: gpt-4o-mini" maps,
 * flow lists "[gpt-4o, o3]".
 */
function inModelBlock(lines, i, routed) {
    const line = lines[i];
    const flow = /\[([^\]]*)\]/.exec(line);
    if (flow && flow[1].split(",").filter((x) => isModel(x.trim(), routed)).length >= 2)
        return !DATA_OWNER.test(line.slice(0, flow.index));
    const indent = /^\s*/.exec(line)[0].length;
    const sameBlock = (l) => l.trim() !== "" && /^\s*/.exec(l)[0].length === indent;
    let n = 0;
    let owner = "";
    let settingKey = false;
    const look = (l) => {
        const v = valueOf(l);
        if (v && isModel(v, routed))
            n++;
        const k = /^\s*["']?([\w.\-]+)["']?\s*[:=]/.exec(l)?.[1];
        if (k && isSettingName(k))
            settingKey = true;
    };
    for (let j = i; j >= 0 && sameBlock(lines[j]); j--)
        look(lines[j]);
    for (let j = i + 1; j < lines.length && sameBlock(lines[j]); j++)
        look(lines[j]);
    // An object with its own model key ({model: x, name: y}) is one settings object, not a map of models
    if (settingKey && !/^\s*-/.test(line))
        return false;
    for (let j = i - 1; j >= 0; j--) {
        const l = lines[j];
        if (l.trim() && /^\s*/.exec(l)[0].length < indent) {
            owner = /["']?([\w.\-]+)["']?\s*[:=[{]/.exec(l)?.[1] ?? "";
            break;
        }
    }
    const listItem = /^\s*-|^\s*["'][^"']*["']\s*,?\s*$/.test(line);
    return n >= 2 && !DATA_OWNER.test(owner) && !(listItem && NAME_LIST.test(owner));
}
/**
 * A registry of entries, one model per entry: the same key ("id", "name", "slug") at the same indentation in
 * neighbouring entries also holds a model ID. registry.json [{ "id": "claude-…", … }, { "id": "gpt-…", … }]
 */
function inEntryTable(lines, i, before, routed) {
    // the key right before this value, wherever it sits on the line ("id": "claude-…" inside { … } too)
    const key = /["']?([\w.\-]+)["']?\s*[:=]\s*["']?$/.exec(before)?.[1];
    if (!key || DATA_OWNER.test(key) || NAME_LIST.test(key))
        return false;
    const indent = /^\s*/.exec(lines[i])[0].length;
    const same = new RegExp(`["']?${key.replace(/[.\-]/g, "\\$&")}["']?\\s*[:=]\\s*["']?([A-Za-z0-9][\\w.:@/-]*[\\w])`);
    for (let j = Math.max(0, i - 80); j < Math.min(lines.length, i + 81); j++) {
        if (j === i || /^\s*/.exec(lines[j])[0].length !== indent)
            continue;
        const m = same.exec(lines[j]);
        if (m && isModel(m[1], routed))
            return true;
    }
    return false;
}
export function isConfigName(name) {
    return CONFIG_EXT.test(basename(name)) || ENV_FILE.test(basename(name));
}
/**
 * Config: the key on this line is model-named, or this is a "- item" in a list under a model-named key.
 * Notebook code cells are Python: model="x", MODEL = "x", model: "x".
 */
/** Is the token a model setting ("setting"), an item in a list under a model-named key ("listed"), or neither? */
function settingAt(lines, i, before, lang) {
    if (lang === "notebook")
        return /(\w*model\w*)\s*[:=]\s*["']$/i.test(before) && isSettingName(/(\w*model\w*)\s*[:=]\s*["']$/i.exec(before)[1]) ? "setting" : undefined;
    if (configKeySetting(before))
        return "setting";
    const item = /^(\s*)-\s*["']?$/.exec(before);
    if (!item)
        return undefined;
    const indent = item[1].length;
    for (let j = i - 1; j >= 0 && j >= i - 200; j--) {
        const m = /^(\s*)["']?([\w.\-]+)["']?\s*:\s*$/.exec(lines[j]);
        if (m && m[1].length < indent + 1)
            return isSettingName(m[2]) ? "listed" : undefined;
        if (/^\S/.test(lines[j]) && !/^\s*-/.test(lines[j]))
            return undefined;
    }
    return undefined;
}
