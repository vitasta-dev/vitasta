/**
 * SQL seed rows that configure a provider request:
 *   INSERT INTO llm_providers (name, model, temperature, top_p) VALUES ('openai', 'gpt-4o', 0.7, 1.0);
 * A row's model column (and temperature / top_p / top_k) is configuration only when the repo's code reads that table
 * into a provider request: a non-test source file that names the table (snake, camel or Pascal case, singular or
 * plural: `llm_providers`, `LlmProvider`) and has a call to the same provider. When that link can't be shown the row
 * is a note (recorded: reported, never failing, never edited). Price, limit, alias and capability tables are model
 * lists, not settings, and a statement with many different models is a catalog: both are notes whatever the code does.
 * Text-based: single-quoted strings with '' escapes, tuples split at the top level. Bounded.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { modelRef } from "../providers.js";
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "target", ".next", "coverage"]);
const MAX_FILES = 800;
const MAX_BYTES = 2_000_000;
const MODEL_COL = /^(?:model|model_?(?:name|id|slug)|llm_?model|default_?model|\w+_model)$/i;
const SAMPLING_COL = { temperature: "temperature", topp: "top_p", topk: "top_k" };
const LISTY = /pric|cost|context_?window|max_?(?:input|context)|alias|deprecat|retire|replace|capabilit/i;
const CHAT_OP = { openai: "POST /v1/chat/completions", anthropic: "POST /v1/messages" };
const CATALOG_MODELS = 8;
const TEST_FOLDER = /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?|__fixtures__|testdata|mocks?|__mocks__)\//i;
/** Top-level comma split of a SQL list, with offsets; quoted strings keep their commas */
function splitTop(s, base) {
    const out = [];
    let depth = 0, from = 0, q = false;
    for (let i = 0; i <= s.length; i++) {
        const c = s[i];
        if (q) {
            if (c === "'" && s[i + 1] === "'")
                i++;
            else if (c === "'")
                q = false;
            continue;
        }
        if (c === "'")
            q = true;
        else if (c === "(")
            depth++;
        else if (c === ")")
            depth--;
        if ((c === "," && depth === 0) || i === s.length) {
            out.push({ text: s.slice(from, i), at: base + from });
            from = i + 1;
        }
    }
    return out;
}
/** A pattern for the places code names a table: llm_providers, LlmProvider, llmProviders */
export function tablePattern(table) {
    const name = table.split(".").pop().replace(/["`\[\]]/g, "");
    const tokens = name.split("_").filter(Boolean);
    if (!tokens.length || name.length < 4)
        return undefined;
    const last = tokens[tokens.length - 1].replace(/s$/i, "");
    const body = [...tokens.slice(0, -1), last].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("_?");
    return new RegExp(`(?<![A-Za-z0-9])${body}s?(?![A-Za-z0-9])`, "i");
}
export function sqlSeedUsagesIn(file, text) {
    const out = [];
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++)
        if (text[i] === "\n")
            lineStarts.push(i + 1);
    const lineAt = (at) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= at)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lo + 1;
    };
    // comments out (same length), so offsets hold
    const clean = text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    for (const st of clean.matchAll(/\bINSERT\s+(?:OR\s+\w+\s+|IGNORE\s+)?INTO\s+([\w."`\[\]]+)\s*\(([^)]*)\)\s*VALUES\s*/gi)) {
        const table = st[1];
        const cols = splitTop(st[2], 0).map((c) => c.text.trim().replace(/^["`\[]|["`\]]$/g, "").toLowerCase());
        const mi = cols.findIndex((c) => MODEL_COL.test(c));
        if (mi < 0)
            continue;
        const listy = LISTY.test(table) || cols.some((c) => LISTY.test(c));
        const from = st.index + st[0].length;
        const end = clean.indexOf(";", from);
        const body = clean.slice(from, end < 0 ? undefined : end);
        const rows = [];
        for (const t of splitTop(body, from)) {
            const m = /^\s*\(([\s\S]*)\)\s*$/.exec(t.text);
            if (m)
                rows.push({ text: m[1], at: t.at + t.text.indexOf("(") + 1 });
        }
        const made = [];
        for (const row of rows) {
            const vals = splitTop(row.text, row.at);
            if (vals.length !== cols.length)
                continue;
            const mv = /^\s*'((?:[^']|'')*)'\s*$/.exec(vals[mi].text);
            const ref = mv ? modelRef(mv[1].replace(/''/g, "'")) : undefined;
            if (!mv || !ref)
                continue;
            const q = vals[mi].at + vals[mi].text.indexOf("'") + 1;
            const line = lineAt(q);
            const snippet = text.slice(lineStarts[line - 1], text.indexOf("\n", q) < 0 ? undefined : text.indexOf("\n", q)).trim().slice(0, 200);
            made.push({
                provider: ref.provider.id, kind: "model-ref", lang: "config", file, line, model: ref.model, setting: true, confidence: "likely", snippet,
                ...(ref.host ? { host: ref.host } : {}), reason: `a seed row for table ${table.replace(/["`\[\]]/g, "")}`,
                modelSpan: { start: q, end: q + mv[1].length, kind: "bare" },
            });
            const op = CHAT_OP[ref.provider.id];
            if (op) {
                cols.forEach((c, ci) => {
                    const wire = SAMPLING_COL[c.replace(/_/g, "")];
                    if (!wire || ci === mi || !/^\s*-?\d+(?:\.\d+)?\s*$/.test(vals[ci].text))
                        return;
                    made.push({ provider: ref.provider.id, kind: "http", lang: "config", file, line, op, params: [wire], confidence: "likely", snippet, reason: `a seed row for table ${table.replace(/["`\[\]]/g, "")}` });
                });
            }
        }
        const distinct = new Set(made.map((u) => u.model).filter(Boolean)).size;
        for (const u of made) {
            if (listy || distinct >= CATALOG_MODELS)
                Object.assign(u, { listed: true, setting: false, reason: `${u.reason}; a list of models, not a setting` });
            out.push({ usage: u, table });
        }
    }
    return out;
}
export async function sqlSeedUsages(root, code, found, skip, isTest) {
    const files = [];
    async function walk(dir) {
        if (files.length >= MAX_FILES)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (files.length >= MAX_FILES)
                return;
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP.has(e.name))
                    await walk(full);
            }
            else if (e.isFile() && /\.sql$/i.test(e.name) && !skip(relative(root, full)) && (await stat(full)).size <= MAX_BYTES)
                files.push(full);
        }
    }
    await walk(root);
    const out = [];
    const readers = code.filter((c) => !isTest(c.rel));
    for (const f of files) {
        const rel = relative(root, f);
        const text = await readFile(f, "utf8").catch(() => "");
        if (!/INSERT/i.test(text))
            continue;
        for (const { usage, table } of sqlSeedUsagesIn(rel, text)) {
            // (a file named for seeds is the target here, not a test: only a test folder or a test file name is)
            if (usage.listed || TEST_FOLDER.test(rel)) {
                out.push(usage);
                continue;
            }
            // the link: code that names the table, in a file that calls the same provider
            const re = tablePattern(table);
            const linked = !!re && readers.some((c) => re.test(c.source) && found.some((u) => u.file === c.rel && u.provider === usage.provider));
            if (linked)
                Object.assign(usage, { sqlSeed: "linked" });
            else
                Object.assign(usage, { recorded: true, reason: `${usage.reason}; no code in the repo is shown reading this table into a ${usage.provider} request` });
            out.push(usage);
        }
    }
    return out;
}
