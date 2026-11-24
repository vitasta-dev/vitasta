/**
 * Item 4: versions in constants, enums and defaults that reach a URL in another file, in Java and
 * C# (others to follow). A per-file index of the values a file defines (static string fields, constants, enum constants
 * and their arguments, aliases like DEFAULT = V21), linked by package/namespace and imports; an expression is
 * evaluated across files (string literals, concatenation, Type.FIELD, Enum.CONST.getValue() / .Value, up to 3 levels).
 * A line whose expression references such a value and evaluates to a provider URL with a version is reported there:
 * the version reaches a request in that file. One usage per file and version, its other lines as alsoLines.
 * Text-based; a name that can't be resolved to exactly one definition is left alone (a missed link, not a guess).
 */
import { PROVIDERS, matchUrl, urlVersionOf } from "../providers.js";
const MAX_LINE = 2000;
const STR = /"((?:\\.|[^"\\])*)"/g;
function indexFile(rel, lang, source) {
    if (source.length > 2_000_000)
        return undefined;
    const pkg = (lang === "java" ? /^[ \t]*package\s+([\w.]+)\s*;/m : /^[ \t]*namespace\s+([\w.]+)\s*[;{]?/m).exec(source)?.[1] ?? "";
    const imports = [];
    const starImports = [];
    for (const m of source.matchAll(lang === "java" ? /^[ \t]*import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;/gm : /^[ \t]*using\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
        if (lang === "cs" || m[2])
            starImports.push(m[1]);
        else
            imports.push(m[1]);
    }
    const types = new Map();
    const lines = source.split("\n");
    let current;
    let enumOpen = false;
    lines.forEach((l, i) => {
        if (l.length > MAX_LINE)
            return;
        const t = /\b(?:class|enum|interface|record|struct)\s+([A-Z]\w*)/.exec(l);
        if (t && !/^\s*(?:\/\/|\*)/.test(l)) {
            current = { file: rel, fields: new Map(), enumArgs: new Map() };
            types.set(t[1], current);
            enumOpen = /\benum\b/.test(l);
            return;
        }
        if (!current)
            return;
        // enum constants: V21("v21.0"), or C# enums with attributes are skipped
        if (enumOpen) {
            for (const m of l.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*\(\s*"([^"]*)"/g))
                current.enumArgs.set(m[1], { value: m[2], line: i + 1 });
            if (/;\s*$/.test(l) && !/^\s*[A-Z][A-Z0-9_]*\s*\(/.test(l))
                enumOpen = false;
        }
        // static final String X = …; / const string X = …; / static readonly string X = …; / static final ApiVersion DEFAULT = V21;
        const f = /\b(?:static\s+final|final\s+static|const|static\s+readonly|readonly\s+static)\s+(?:[\w.<>]+\s+)?([A-Za-z_]\w*)\s*=\s*([^;]+);/.exec(l)
            ?? (/\bpublic\s+(?:static\s+)?(?:final\s+)?String\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/.exec(l));
        if (f)
            current.fields.set(f[1], { expr: f[2].trim(), line: i + 1 });
    });
    return { rel, lang, pkg, imports, starImports, types };
}
export function constValueUsages(files, found) {
    const idx = [];
    for (const f of files)
        if (f.lang === "java" || f.lang === "cs") {
            const v = indexFile(f.rel, f.lang, f.source);
            if (v)
                idx.push(v);
        }
    if (!idx.length)
        return [];
    // Types by fully qualified name, and by simple name (for the same package / namespace and wildcard imports)
    const byFqn = new Map();
    for (const v of idx)
        for (const [name, t] of v.types) {
            const fq = v.pkg ? `${v.pkg}.${name}` : name;
            byFqn.set(fq, [...(byFqn.get(fq) ?? []), t]);
        }
    const fileOf = new Map(idx.map((v) => [v.rel, v]));
    /** A type name as file `rel` sees it: its own types, explicit imports, its package, wildcard imports; one, or none */
    const typeFor = (rel, name) => {
        const v = fileOf.get(rel);
        const pkg = v?.pkg ?? "";
        const cands = new Set();
        const add = (fq) => (byFqn.get(fq) ?? []).forEach((t) => cands.add(t));
        if (v?.types.has(name))
            return v.types.get(name);
        for (const im of v?.imports ?? [])
            if (im === name || im.endsWith(`.${name}`))
                add(im);
        if (!cands.size) {
            add(pkg ? `${pkg}.${name}` : name);
            for (const s of v?.starImports ?? [])
                add(`${s}.${name}`);
            // C#: a namespace's parent namespaces are in scope too
            if (v?.lang === "cs")
                for (let p = pkg; p.includes("."); p = p.slice(0, p.lastIndexOf(".")))
                    add(`${p.slice(0, p.lastIndexOf("."))}.${name}`);
        }
        return cands.size === 1 ? [...cands][0] : undefined;
    };
    /** The string an expression evaluates to in a type (or file) context, with the definitions it went through */
    const evalExpr = (expr, rel, self, depth, via) => {
        if (depth > 3)
            return undefined;
        const parts = splitConcat(expr);
        if (!parts)
            return undefined;
        let out = "";
        for (const p of parts) {
            const lit = /^"((?:\\.|[^"\\])*)"$/.exec(p);
            if (lit) {
                out += lit[1];
                continue;
            }
            const v = refValue(p, rel, self, depth, via);
            // The leading parts that resolve: a URL's base and version come first, a runtime path or token after
            if (v === undefined)
                return out || undefined;
            out += v;
        }
        return out;
    };
    const refValue = (ref, rel, self, depth, via) => {
        // Enum.CONST.getValue() / Enum.CONST.Value / Type.FIELD / FIELD (own type)
        const m = /^(?:([A-Z]\w*)\.)?([A-Za-z_]\w*)(?:\.(?:get[A-Z]\w*\(\s*\)|Value|value(?:\(\s*\))?))?$/.exec(ref.replace(/\s+/g, ""));
        if (!m)
            return undefined;
        const t = m[1] ? typeFor(rel, m[1]) : self;
        if (!t)
            return undefined;
        const e = t.enumArgs.get(m[2]);
        if (e) {
            via.push(`${m[1] ?? ""}${m[1] ? "." : ""}${m[2]} (${t.file}:${e.line})`);
            return e.value;
        }
        const f = t.fields.get(m[2]);
        if (!f)
            return undefined;
        via.push(`${m[1] ?? ""}${m[1] ? "." : ""}${m[2]} (${t.file}:${f.line})`);
        // An alias to an enum constant of its own type: DEFAULT = V21
        const alias = /^(?:([A-Z]\w*)\.)?([A-Z][A-Z0-9_]*)$/.exec(f.expr);
        if (alias && !/^"/.test(f.expr)) {
            const at = alias[1] ? typeFor(t.file, alias[1]) : t;
            const ea = at?.enumArgs.get(alias[2]);
            if (ea)
                return ea.value;
        }
        return evalExpr(f.expr, t.file, t, depth + 1, via);
    };
    const out = [];
    const have = new Set(found.filter((u) => u.apiVersion && !u.traceOnly).map((u) => `${u.file}|${u.line}`));
    const perFile = new Map();
    for (const f of files) {
        if (f.lang !== "java" && f.lang !== "cs")
            continue;
        if (f.source.length > 2_000_000)
            continue;
        const lines = f.source.split("\n");
        const v = fileOf.get(f.rel);
        lines.forEach((l, i) => {
            if (l.length > MAX_LINE || /^\s*(?:\/\/|\*|import\b|using\b|package\b)/.test(l))
                return;
            // A reference to a type's value (Type.FIELD, Type.CONST.getValue()) in a string expression
            if (!/\b[A-Z]\w*\.[A-Za-z_]\w*/.test(l) || have.has(`${f.rel}|${i + 1}`))
                return;
            for (const expr of candidateExprs(l)) {
                if (!/\b[A-Z]\w*\.[A-Za-z_]\w*/.test(expr))
                    continue;
                const via = [];
                // The line's own type is the context for bare names
                const self = v ? [...v.types.values()].pop() : undefined;
                const val = evalExpr(expr, f.rel, self, 0, via);
                if (!val || !via.length)
                    continue;
                const hit = matchUrl(val);
                const ver = hit ? urlVersionOf(hit.provider, val) : undefined;
                if (!hit || !ver)
                    continue;
                const key = `${f.rel}|${hit.provider.id}|${ver}`;
                const prev = perFile.get(key);
                if (prev) {
                    if (prev.line !== i + 1)
                        prev.alsoLines = [...new Set([...(prev.alsoLines ?? []), i + 1])].sort((a, b) => a - b);
                    continue;
                }
                const u = {
                    provider: hit.provider.id, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `url: ${ver}`, confidence: "likely",
                    snippet: l.trim().slice(0, 200), reason: `${via.join(" → ")} makes ${val.slice(0, 80)}`,
                };
                perFile.set(key, u);
                out.push(u);
                break;
            }
        });
    }
    return out;
}
/** The concatenated parts of a Java/C# string expression ("a" + X.Y + "b"), or undefined if it isn't one */
function splitConcat(expr) {
    const parts = [];
    let cur = "", q = false, depth = 0;
    for (let j = 0; j < expr.length; j++) {
        const c = expr[j];
        if (q) {
            cur += c;
            if (c === "\\")
                cur += expr[++j] ?? "";
            else if (c === '"')
                q = false;
            continue;
        }
        if (c === '"')
            q = true;
        if (c === "(")
            depth++;
        if (c === ")")
            depth--;
        if (c === "+" && depth === 0) {
            parts.push(cur.trim());
            cur = "";
            continue;
        }
        cur += c;
    }
    parts.push(cur.trim());
    if (parts.some((p) => !p || (!/^"(?:\\.|[^"\\])*"$/.test(p) && !/^(?:[A-Z]\w*\.)?[A-Za-z_]\w*(?:\.(?:get[A-Z]\w*\(\s*\)|Value|value(?:\(\s*\))?))?$/.test(p.replace(/\s+/g, ""))))) {
        // Allow a trailing non-constant part (a path variable, a token): only the leading constant parts are evaluated
        const lead = [];
        for (const p of parts) {
            if (/^"(?:\\.|[^"\\])*"$/.test(p) || /^(?:[A-Z]\w*\.)?[A-Za-z_]\w*(?:\.(?:get[A-Z]\w*\(\s*\)|Value|value(?:\(\s*\))?))?$/.test(p.replace(/\s+/g, "")))
                lead.push(p);
            else
                break;
        }
        return lead.length ? lead : undefined;
    }
    return parts;
}
/** String expressions on a line: an assignment's right-hand side, and every call argument at any depth */
function candidateExprs(raw) {
    // C# interpolated strings: $"a{X.Y}b" is "a" + X.Y + "b"
    const l = raw.replace(/\$@?"((?:\\.|[^"\\])*)"/g, (_m, body) => body.split(/(\{[^{}]+\})/).filter(Boolean).map((p) => (p.startsWith("{") ? p.slice(1, -1).split(":")[0].trim() : `"${p}"`)).join(" + "));
    const out = [];
    const rhs = /=\s*([^;]+);?\s*$/.exec(l)?.[1];
    if (rhs)
        out.push(rhs.trim());
    const stack = [];
    let q = false;
    const args = (from, to) => {
        let depth = 0, start = from, qq = false;
        for (let j = from; j <= to; j++) {
            const c = l[j];
            if (qq) {
                if (c === "\\")
                    j++;
                else if (c === '"')
                    qq = false;
                continue;
            }
            if (c === '"')
                qq = true;
            else if (c === "(")
                depth++;
            else if (c === ")")
                depth--;
            else if ((c === "," && depth === 0) || j === to) {
                const a = l.slice(start, j === to && c !== "," ? j + 1 : j).trim();
                if (a && (/\+/.test(a) || /[A-Z]\w*\.[A-Za-z_]/.test(a)))
                    out.push(a);
                start = j + 1;
            }
        }
    };
    for (let j = 0; j < l.length; j++) {
        const c = l[j];
        if (q) {
            if (c === "\\")
                j++;
            else if (c === '"')
                q = false;
            continue;
        }
        if (c === '"')
            q = true;
        else if (c === "(")
            stack.push(j);
        else if (c === ")" && stack.length) {
            const open = stack.pop();
            if (j > open + 1)
                args(open + 1, j - 1);
        }
    }
    return out;
}
void PROVIDERS;
void STR;
