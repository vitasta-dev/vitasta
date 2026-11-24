/**
 * Go templates (text/template, html/template, Sprig, Helm) that write a request body with a literal model or setting:
 *   "model": "{{ .Model | default "gpt-4o" }}"      pipeline default
 *   "model": "{{ default "gpt-4o" .Model }}"        Sprig's function form (also or / coalesce)
 *   "model": "gpt-4o"                               a plain literal in the body
 *   "temperature": {{ .Temp | default 0.7 }}
 * Read from template files (*.tmpl, *.gotmpl, *.gohtml, *.tpl, and chart templates/*.yaml) and from Go sources whose
 * strings hold a template. The default (or the literal) is what the request sends when nothing fills the value in, so
 * it is reported at its own text; a value with no literal in it ({{ .Model }}) is left alone, and so is anything that
 * isn't a known model ID. Text-based and bounded.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { matchUrl, modelRef } from "../providers.js";
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "target", ".next", "coverage"]);
const TEMPLATE_FILE = /\.(?:tmpl|gotmpl|gohtml|tpl|gotxt)$|(?:^|\/)templates\/[^/]+\.(?:ya?ml|json)$/i;
const MAX_FILES = 1500;
const MAX_BYTES = 500_000;
const PARAMS = new Set(["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "max_tokens", "max_completion_tokens", "seed"]);
const FALLBACK_OP = { openai: "POST /v1/chat/completions", anthropic: "POST /v1/messages" };
/** A string literal in an action: "x", \"x\", 'x', `x` (its text, and where it sits inside the action) */
const STR = String.raw `(?:\\?"([^"\\]*)\\?"|'([^']*)'|\x60([^\x60]*)\x60)`;
const NUM = String.raw `(-?\d+(?:\.\d+)?)`;
/** The literal a template action falls back to, or yields: the action text and where it starts in the file */
function actionLiteral(action, base, kind) {
    const V = kind === "str" ? STR : NUM;
    const forms = [
        [new RegExp(String.raw `\|\s*default\s+(${V})`), 1],
        [new RegExp(String.raw `^\s*-?\s*default\s+(${V})\s+\S`), 1],
        [new RegExp(String.raw `^\s*-?\s*(?:or|coalesce)\s+[^"'\x60]*?(${V})\s*-?\s*$`), 1],
        [new RegExp(String.raw `\|\s*(?:or|coalesce)\s+(${V})`), 1],
        [new RegExp(String.raw `^\s*-?\s*(${V})\s*-?\s*$`), 1],
    ];
    for (const [re, g] of forms) {
        const m = re.exec(action);
        if (!m)
            continue;
        const text = m[g];
        const at = m.index + m[0].indexOf(text);
        const value = kind === "str" ? text.replace(/^\\?["'\x60]|\\?["'\x60]$/g, "") : text;
        return { value, start: base + at, end: base + at + text.length };
    }
    return undefined;
}
/** From the key's value position: the value's text with template actions kept whole, to its end */
function valueSpan(text, from) {
    let i = from;
    while (i < text.length && /[ \t]/.test(text[i]))
        i++;
    const start = i;
    const q = text[i] === "\\" && text[i + 1] === '"' ? '\\"' : text[i] === '"' || text[i] === "'" ? text[i] : "";
    if (q) {
        i += q.length;
        while (i < text.length) {
            if (text.startsWith("{{", i)) {
                const e = text.indexOf("}}", i);
                if (e < 0)
                    break;
                i = e + 2;
                continue;
            }
            if (text.startsWith(q, i))
                return { start, end: i + q.length };
            if (text[i] === "\n")
                break;
            i++;
        }
        return { start, end: i };
    }
    while (i < text.length) {
        if (text.startsWith("{{", i)) {
            const e = text.indexOf("}}", i);
            if (e < 0)
                break;
            i = e + 2;
            continue;
        }
        if (text[i] === "\n" || text[i] === "," || text[i] === "}")
            break;
        i++;
    }
    return { start, end: Math.min(i, text.length) };
}
export function templateUsages(file, lang, text, found, fileProvider) {
    if (!text.includes("model") && !/temperature|top_p|top_k|max_tokens/.test(text))
        return [];
    const out = [];
    const have = new Set(found.map((u) => `${u.file}|${u.line}|${u.model ?? (u.params ?? []).join()}`));
    const lines = [0];
    for (let i = 0; i < text.length; i++)
        if (text[i] === "\n")
            lines.push(i + 1);
    const lineAt = (at) => {
        let lo = 0, hi = lines.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lines[mid] <= at)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lo + 1;
    };
    const snippet = (at) => text.slice(lines[lineAt(at) - 1], text.indexOf("\n", at) < 0 ? undefined : text.indexOf("\n", at)).trim().slice(0, 200);
    // The provider's request URL named in the same text, for the operation of a setting
    const url = [...text.matchAll(/https?:\/\/[^\s"'{}`\\]+/g)].map((m) => matchUrl(m[0])).find((h) => h?.path && h.path !== "/");
    // value → its literal: a plain value, or the one template action it is
    const literalOf = (span, kind) => {
        const raw = text.slice(span.start, span.end);
        const action = /^\\?["']?\s*\{\{([\s\S]*?)\}\}\s*\\?["']?$/.exec(raw);
        if (action) {
            const inner = action[1];
            return actionLiteral(inner, span.start + raw.indexOf("{{") + 2, kind);
        }
        if (raw.includes("{{"))
            return undefined;
        if (kind === "str") {
            const m = /^(\\?["'])([^"'\\{}]+)\\?["']$/.exec(raw);
            return m ? { value: m[2], start: span.start, end: span.end } : /^[\w.:@\/-]+$/.test(raw) ? { value: raw, start: span.start, end: span.end } : undefined;
        }
        return /^-?\d+(?:\.\d+)?$/.test(raw) ? { value: raw, start: span.start, end: span.end } : undefined;
    };
    let modelProvider;
    for (const m of text.matchAll(/(?:\\?["']model\\?["']|^[ \t]*model)[ \t]*:[ \t]*/gm)) {
        const span = valueSpan(text, m.index + m[0].length);
        const lit = literalOf(span, "str");
        const ref = lit ? modelRef(lit.value) : undefined;
        if (!lit || !ref)
            continue;
        const line = lineAt(lit.start);
        if (have.has(`${file}|${line}|${ref.model}`))
            continue;
        modelProvider ??= { id: ref.provider.id };
        out.push({
            provider: ref.provider.id, kind: "model-ref", lang, file, line, model: ref.model, setting: true, confidence: "likely",
            snippet: snippet(lit.start), ...(ref.host ? { host: ref.host } : {}), reason: "the model a request template sends",
            modelSpan: { start: lit.start, end: lit.end, kind: /["'\\\x60]/.test(text[lit.start]) ? "string" : "bare" },
        });
    }
    // a setting needs a provider signal: a provider URL or model in the template, or (a Go source) a call to the provider in
    // the file that renders it. temperature: 0.7 with none of these could be any provider, a local model or other config
    const provider = url?.provider.id ?? modelProvider?.id ?? out[0]?.provider ?? fileProvider;
    const op = url ? `POST ${url.path}` : provider ? FALLBACK_OP[provider] : undefined;
    if (provider && op) {
        for (const m of text.matchAll(/\\?["']([a-z_]+)\\?["'][ \t]*:[ \t]*/g)) {
            if (!PARAMS.has(m[1]))
                continue;
            const span = valueSpan(text, m.index + m[0].length);
            const lit = literalOf(span, "num");
            if (!lit)
                continue;
            const line = lineAt(m.index);
            if (have.has(`${file}|${line}|${m[1]}`))
                continue;
            out.push({ provider, kind: "http", lang, file, line, op, params: [m[1]], confidence: "likely", snippet: snippet(m.index), reason: "a setting a request template sends" });
        }
    }
    return out;
}
export async function goTemplateUsages(root, goSources, found, skip) {
    const out = [];
    for (const g of goSources)
        if (g.source.includes("{{") && !skip(g.rel))
            out.push(...templateUsages(g.rel, "go", g.source, found, found.find((u) => u.file === g.rel && (u.kind === "sdk" || u.kind === "http") && FALLBACK_OP[u.provider])?.provider));
    let seen = 0;
    async function walk(dir) {
        if (seen >= MAX_FILES)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (seen >= MAX_FILES)
                return;
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP.has(e.name))
                    await walk(full);
                continue;
            }
            const rel = relative(root, full);
            if (!e.isFile() || !TEMPLATE_FILE.test(rel) || skip(rel))
                continue;
            seen++;
            if ((await stat(full)).size > MAX_BYTES)
                continue;
            const text = await readFile(full, "utf8").catch(() => "");
            if (!text.includes("{{") && !/\.(?:tmpl|gotmpl|gohtml|tpl|gotxt)$/i.test(rel))
                continue;
            out.push(...templateUsages(rel, "config", text, found));
        }
    }
    await walk(root);
    return out;
}
