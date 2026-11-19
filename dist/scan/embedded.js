const FENCE_LANG = {
    python: "py", py: "py", python3: "py",
    ts: "ts", typescript: "ts", tsx: "ts",
    js: "js", javascript: "js", jsx: "js", mjs: "js", node: "js",
    java: "java", go: "go", golang: "go", ruby: "rb", rb: "rb", php: "php", cs: "cs", csharp: "cs", "c#": "cs",
};
/** The text with only [start, end) ranges kept; everything else becomes spaces (newlines stay) */
function keepOnly(text, ranges) {
    const out = text.replace(/[^\n]/g, " ").split("");
    for (const [a, b] of ranges)
        for (let i = a; i < b; i++)
            out[i] = text[i];
    return out.join("");
}
/** One virtual source per language for the fenced code blocks in a Markdown file */
export function markdownCode(md) {
    const byLang = new Map();
    // ```python … ``` (or ~~~): the block's body, between the opening line and the closing fence
    const re = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([\w#+-]*)[^\n]*\n([\s\S]*?)^\1?\2[ \t]*$/gm;
    for (const m of md.matchAll(re)) {
        const lang = FENCE_LANG[m[3].toLowerCase()];
        if (!lang)
            continue;
        const start = m.index + m[0].indexOf("\n") + 1;
        const end = start + m[4].length;
        byLang.set(lang, [...(byLang.get(lang) ?? []), [start, end]]);
    }
    return [...byLang].map(([lang, ranges]) => ({ lang, source: keepOnly(md, ranges) }));
}
/** Looks like a code sample, not prose or a template: an import or require, and a call */
const CODE_LIKE = /(^|\n)\s*(import\s|from\s+[\w.]+\s+import\s|const\s+\w+\s*=\s*require\(|require\()/;
/**
 * Code samples in a JavaScript/TypeScript file's template strings (`import Anthropic from …; client.messages.create(
 * { model: '…' })`): one virtual source per language they're written in. Interpolations (${…}) are blanked.
 */
export function templateCode(src) {
    if (!src.includes("`"))
        return [];
    const byLang = new Map();
    for (const m of src.matchAll(/`((?:\\[\s\S]|\$\{[^}`]*\}|[^`\\$]|\$(?!\{))*)`/g)) {
        const body = m[1];
        if (body.length < 30 || body.length > 50_000 || !body.includes("\n") || !CODE_LIKE.test(body) || !body.includes("("))
            continue;
        const lang = /(^|\n)\s*(from\s+[\w.]+\s+import\s|import\s+[\w.]+\s*(\n|$)|def\s+\w+\(|\w+\s*=\s*\w+\.\w+\()/.test(body) && !/;\s*(\n|$)/.test(body) ? "py" : "ts";
        const start = m.index + 1;
        const ranges = [];
        // Keep the body, minus ${…} interpolations
        let at = start;
        for (const i of body.matchAll(/\$\{[^}`]*\}/g)) {
            ranges.push([at, start + i.index]);
            at = start + i.index + i[0].length;
        }
        ranges.push([at, start + body.length]);
        byLang.set(lang, [...(byLang.get(lang) ?? []), ...ranges]);
    }
    return [...byLang].map(([lang, ranges]) => ({ lang, source: keepOnly(src, ranges) }));
}
/**
 * Code samples in a Python file's triple-quoted strings (docstrings with ".. code-block:: python", examples): the
 * string's body as a Python source, scanned as documentation
 */
export function pythonStringCode(src) {
    if (!src.includes('"""') && !src.includes("'''"))
        return [];
    const ranges = [];
    for (const m of src.matchAll(/("""|''')([\s\S]*?)\1/g)) {
        const body = m[2];
        if (body.length < 30 || body.length > 50_000 || !CODE_LIKE_PY.test(body) || !body.includes("("))
            continue;
        const start = m.index + m[1].length;
        ranges.push([start, start + body.length]);
    }
    return ranges.length ? [{ lang: "py", source: dedentKeep(keepOnly(src, ranges)), shifted: true }] : [];
}
/** Calls in a docstring example: an Agent("…") or client.x.create(model=…), an import, or a code-block marker */
const CODE_LIKE_PY = /(^|\n)\s*(from\s+[\w.]+\s+import\s|import\s+[\w.]+|\.\.\s+code-block::\s*python|>>>\s)/;
/**
 * Docstring code is indented with its docstring; Python's grammar wants statements at the left edge. Shift every
 * line left by the smallest indent of the kept lines (offsets move, lines don't: usage line numbers stay right)
 */
function dedentKeep(s) {
    const lines = s.split("\n");
    const kept = lines.filter((l) => l.trim());
    const cut = Math.min(...kept.map((l) => /^ */.exec(l)[0].length));
    return lines.map((l) => (l.trim() ? l.slice(cut) : l)).join("\n");
}
