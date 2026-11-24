/**
 * Roles v4: the blocks a model place sits in. A value inside a record that is only written out (a log entry, run
 * metadata, a summary, telemetry), inside a logging call, or inside a React context's default value is recorded:
 * reported, never failing a check. Any other call between the place and that block (a provider call included) means
 * the value is used, so the place keeps its role.
 *
 * Text-based and bounded: strings and comments are blanked first, then brackets are matched backwards from the place,
 * through at most MAX_LINES lines.
 */
const MAX_LINES = 400;
const MAX_OPENERS = 5;
/** A record that is only written out: its key or variable name */
const RECORD_NAME = /^(run[-_]?)?(metadata|meta|log|logs|logging|log[-_]?entry|log[-_]?data|summary|report|stats|statistics|telemetry|audit|tags|labels|run[-_]?info|output[-_]?info|event[-_]?data|analytics)$/i;
/**
 * A call that only logs its arguments (json.dumps and file writes aren't: the text may be configuration). v5: span
 * and trace attributes too (span.set_attribute, setAttributes, add_event, set_tag): telemetry, never sent
 */
const WRITE_CALL = /^(print|pprint|console\.\w+|(self\.|this\.)?_?(log|logger|logging|LOG|LOGGER)\.\w+|wandb\.log|mlflow\.log_\w+|[\w.$]*\.(set_attributes?|setAttributes?|add_event|addEvent|set_tags?|setTags?|record_event))$/;
/** Containers that keep a record a record: dict(...), json.dumps({...}) */
const RECORD_WRAPPER = /^(dict|OrderedDict|json\.dumps?|JSON\.stringify|Object\.freeze)$/;
/** Calls that only pick the value (an environment default, a lookup with a default): transparent */
const VALUE_CALL = /^(os\.getenv|os\.environ\.get|getenv|[\w.]+\.get|str|String)$/;
const CONTEXT_DEFAULT = /(^|\.)createContext$/;
/** Strings and comments as spaces, so brackets inside them don't count; lengths stay, so columns line up */
export function blankLine(line) {
    return line
        .replace(/(["'`])(?:\\.|(?!\1)[^\\])*?\1/g, (m) => " ".repeat(m.length))
        .replace(/(^|\s)(#|\/\/).*$/, (m) => " ".repeat(m.length));
}
/** Why the place at (line, col) (0-based) is only recorded, or undefined if it isn't */
export function recordedBy(lines, blanked, line, col) {
    let depth = 0;
    let openers = 0;
    for (let i = line, stop = Math.max(0, line - MAX_LINES); i >= stop; i--) {
        const b = blanked[i];
        for (let j = (i === line ? Math.min(col, b.length) : b.length) - 1; j >= 0; j--) {
            const c = b[j];
            if (c === ")" || c === "]" || c === "}")
                depth++;
            else if (c === "(" || c === "[" || c === "{") {
                if (depth > 0) {
                    depth--;
                    continue;
                }
                if (++openers > MAX_OPENERS)
                    return undefined;
                const before = lines[i].slice(0, j);
                if (c === "(") {
                    const callee = /([\w.$]+)\s*(<[^()]*>)?\s*$/.exec(before)?.[1] ?? "";
                    if (CONTEXT_DEFAULT.test(callee))
                        return "context-default";
                    if (WRITE_CALL.test(callee))
                        return "write-call";
                    // A call that does something with the value: the place is used, whatever holds the call
                    if (callee && !RECORD_WRAPPER.test(callee) && !VALUE_CALL.test(callee))
                        return undefined;
                }
                else {
                    const name = /["']?([\w$-]+)["']?\s*[:=]\s*$/.exec(before)?.[1];
                    if (name && RECORD_NAME.test(name))
                        return "record";
                }
            }
        }
    }
    return undefined;
}
/**
 * v5: the model is only compared against (modelId === "x", model == 'x', case "x":, startsWith("x")): code that picks a
 * request shape or a branch for that model. Nothing sends the literal, so it's a catalog entry, not a setting. Only the
 * operand next to the comparison counts: in `a === b ? "gpt-4o" : "x"` the results are values.
 */
export function comparedAt(line, col) {
    // The string literal around col: its opening and closing quotes
    let q = col;
    while (q >= 0 && !"\"'`".includes(line[q]))
        q--;
    if (q < 0)
        return false;
    const end = line.indexOf(line[q], Math.max(q + 1, col));
    if (end < 0)
        return false;
    const before = line.slice(0, q + 1);
    const after = line.slice(end);
    if (/(===?|!==?)\s*["'`]$/.test(before) || /^["'`]\s*(===?|!==?)(?!=?>)/.test(after))
        return true;
    if (/\bcase\s+["'`]$/.test(before))
        return true;
    return /\.(startsWith|startswith|endsWith|endswith|includes|indexOf)\(\s*["'`]$/.test(before);
}
/** Response, output and result types: a field default there describes what came back */
const RESPONSE_CLASS = /^\s*class\s+\w*(Response|Output|Result|Reply|Chunk|Delta|Completion)s?\b/;
/**
 * v5: a field default inside a response schema (class VideoResponse(BaseModel): model: str = "sora-2"). Python
 * classes only: the enclosing block is the nearest line above with less indentation, through MAX_LINES lines
 */
export function inResponseSchema(lines, line) {
    const own = /^\s*/.exec(lines[line] ?? "")[0].length;
    if (own === 0)
        return false;
    for (let i = line - 1, stop = Math.max(0, line - MAX_LINES); i >= stop; i--) {
        const l = lines[i];
        if (!l.trim() || /^\s*(#|@)/.test(l))
            continue;
        const ind = /^\s*/.exec(l)[0].length;
        if (ind < own)
            return RESPONSE_CLASS.test(l) && /^\s*\w+\s*:/.test(lines[line]);
    }
    return false;
}
/**
 * v6: fields that describe a model in a catalog: price, context and output limits, capabilities. Their presence in the
 * object around a model ID (or one level down: pricing: { … }, limits: { … }) makes it an entry in a list of models
 * the app offers, not a value it sends. Generic: names, not repositories.
 */
const CATALOG_FIELD = /^(pricing|prices?|costs?|(input|output|prompt|completion|cache\w*)_?(cost|price)\w*|\w*_cost_per_\w+|\w*per_?million\w*|context_?(window|length|size|tokens)|max_?context\w*|max_?output\w*|max_?input_?tokens|max_?completion_?tokens|capabilit(y|ies)|(input_?|output_?)?modalit(y|ies)|supports?_?\w+|supported_?\w+|vision|image_?input|knowledge_?cutoff|training_?cutoff|release_?date|tokenizer|limits)$/i;
/** Request settings: an object with these is a preset or a request (it's sent), never a catalog entry */
const REQUEST_FIELD = /^(temperature|top_?p|top_?k|presence_?penalty|frequency_?penalty|messages|contents|input|inputs|prompt|instructions|stream|stop|seed|reasoning_?effort|tool_?choice|response_?format|generation_?config)$/i;
/** Connection settings: an object with these is a provider or app configuration (it's loaded and used) */
const CONNECTION_FIELD = /^(api_?key|api_?base|base_?url|endpoint|enabled?|deployment|api_?version|organization|proxy)$/i;
/** Keys that hold a model's ID in an entry */
const ID_KEY = /^(id|model|model_?id|model_?name|api_?model_?id|provider_?model_?id|upstream_?model\w*|hosted_?id|slug|name|value)$/i;
/** In a registry list, "model" is usually a setting (a preset or route), so it doesn't count as a registry ID */
const REGISTRY_ID_KEY = /^(id|model_?id|api_?model_?id|provider_?model_?id|hosted_?id|slug)$/i;
const MIN_REGISTRY_ENTRIES = 3;
const KEY_AT = /["']?([A-Za-z_$][\w$-]*)["']?\s*:(?!:)/g;
/** Shorthand properties: { model, messages } */
const SHORTHAND_AT = /(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=,|}|$)/g;
/** The innermost unmatched opener before (line, col): its line, column and character */
function openerBefore(blanked, line, col) {
    let depth = 0;
    for (let i = line, stop = Math.max(0, line - MAX_LINES); i >= stop; i--) {
        const b = blanked[i];
        for (let j = (i === line ? Math.min(col, b.length) : b.length) - 1; j >= 0; j--) {
            const c = b[j];
            if (c === ")" || c === "]" || c === "}")
                depth++;
            else if (c === "(" || c === "[" || c === "{") {
                if (depth > 0)
                    depth--;
                else
                    return { line: i, col: j, c };
            }
        }
    }
    return undefined;
}
/** Keys of the block opened at (line, col), by depth (1 = its own, 2 = one level down), and where it closes */
function blockKeys(lines, blanked, at) {
    const own = [];
    const nested = [];
    let depth = 0;
    for (let i = at.line, stop = Math.min(lines.length - 1, at.line + MAX_LINES); i <= stop; i++) {
        const b = blanked[i];
        const raw = lines[i];
        const depthAt = [];
        for (let j = i === at.line ? at.col : 0; j < b.length; j++) {
            depthAt[j] = depth;
            const c = b[j];
            if (c === "(" || c === "[" || c === "{")
                depth++;
            else if (c === ")" || c === "]" || c === "}") {
                depth--;
                if (depth === 0) {
                    collect(raw, depthAt, i === at.line ? at.col : 0, j);
                    return { own, nested, end: { line: i, col: j } };
                }
            }
        }
        collect(raw, depthAt, i === at.line ? at.col : 0, b.length);
    }
    return { own, nested };
    function collect(raw, depthAt, from, to) {
        for (const re of [KEY_AT, SHORTHAND_AT]) {
            re.lastIndex = 0;
            for (let m; (m = re.exec(raw));) {
                const k = m.index + m[0].indexOf(m[1]);
                if (k < from || k >= to)
                    continue;
                const d = depthAt[k];
                if (d === 1)
                    own.push(m[1]);
                else if (d === 2)
                    nested.push(m[1]);
            }
        }
    }
}
/**
 * v6: is the model at (line, col) an entry in a catalog: a list of models the app offers, a model registry, or a
 * provider registry's mapping? "catalog-entry": the object holding the
 * ID describes the model (price, context, capabilities). "registry": the object is one of several entries in a list,
 * each with a model ID under an ID key. Presets and requests (temperature, messages …) and provider configurations
 * (api key, base URL …) are never catalogs: they're sent or loaded.
 */
export function catalogAt(lines, blanked, line, col) {
    // The ID must be the value of a key: { modelId: "…" }, "model": "…"
    const key = /["']?([A-Za-z_$][\w$-]*)["']?\s*:\s*["'`]?$/.exec(lines[line].slice(0, col))?.[1];
    if (!key || !ID_KEY.test(key))
        return undefined;
    const open = openerBefore(blanked, line, col);
    if (!open || open.c !== "{")
        return undefined;
    // An object passed straight into a call (create({ model, … }), generateContent({ … })) is a request, not a list entry
    if (/[\w$\])]\s*\(\s*$/.test(blanked[open.line].slice(0, open.col)))
        return undefined;
    const { own, nested } = blockKeys(lines, blanked, open);
    if (own.some((k) => REQUEST_FIELD.test(k) || CONNECTION_FIELD.test(k)))
        return undefined;
    if ([...own, ...nested].some((k) => CATALOG_FIELD.test(k)))
        return "catalog-entry";
    // A registry: this entry sits in a list of at least MIN_REGISTRY_ENTRIES entries that each name a model by an ID key
    if (!REGISTRY_ID_KEY.test(key))
        return undefined;
    const list = openerBefore(blanked, open.line, open.col);
    if (!list || list.c !== "[")
        return undefined;
    const entries = blockKeys(lines, blanked, list).nested.filter((k) => REGISTRY_ID_KEY.test(k)).length;
    return entries >= MIN_REGISTRY_ENTRIES ? "registry" : undefined;
}
/**
 * v7: the name holding the list a catalog entry sits in (`export const defaultQAModels: LLMModelItemType[] = [`,
 * `models: [`, `MODELS = [`), if any
 */
export function listHolderAt(lines, blanked, line, col) {
    for (let p = openerBefore(blanked, line, col), n = 0; p && n < 4; p = openerBefore(blanked, p.line, p.col), n++) {
        if (p.c !== "[")
            continue;
        // Only a list declared under its own name (const X = [ …): a key (models: [) is too common a name to follow
        return /(?:^|\b(?:const|let|var|export)\s+|^\s*)([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*=\s*$/.exec(lines[p.line].slice(0, p.col))?.[1];
    }
    return undefined;
}
/**
 * v7: names whose first or chosen element code uses: `list[0]`, `list.at(0)`, `list.find(…)`, `next(iter(list))`, on
 * the bare name (not `x.list[0]`), in a file that imports or declares that name
 */
// v10: also Java .get(0) / .getFirst(), C# .First() / .FirstOrDefault(), Ruby .first, Kotlin-style .first()
const SELECTED = /(?<![\w$.?])([A-Za-z_$][\w$]*)\s*(?:\[\s*0\s*\]|\.at\(\s*0\s*\)|\.find\(|\.shift\(\s*\)|\.first\b|\.get\(\s*0\s*\)|\.getFirst\(\s*\)|\.First(?:OrDefault)?\(\s*\)|\.first\(\s*\))|\bnext\(\s*iter\(\s*([A-Za-z_][\w]*)\s*\)/g;
const PHP_FIRST = /(?:\bcurrent|\breset|\bhead|Arr::first|\barray_shift)\(\s*(?:(?:self|static|[\w\\]+)::(\w+)\(\s*\)|\$(\w+)\s*\))|(?:self|static|[\w\\]+)::(\w+)\(\s*\)\s*\[\s*0\s*\]/g;
export function collectSelectedNames(source, into) {
    if (!/\[\s*0\s*\]|\.at\(|\.find\(|\.shift\(|\.first\b|next\(\s*iter\(|current\(|reset\(|head\(|Arr::first|array_shift|\.get\(\s*0|\.getFirst\(|\.First(?:OrDefault)?\(/.test(source))
        return;
    const hits = new Set();
    for (const l of source.split("\n")) {
        if (l.length > 2000)
            continue;
        for (const m of l.matchAll(SELECTED))
            hits.add(m[1] ?? m[2]);
    }
    // v9, PHP: current(self::versions()), reset($list), head(…), Arr::first(…), Cls::versions()[0], and a local that
    // holds a method's list ($versions = Service::versions(); current($versions)). A method name is specific enough
    for (const m of source.matchAll(PHP_FIRST)) {
        if (m[1] || m[3])
            into.add(m[1] ?? m[3]);
        else if (m[2]) {
            const alias = new RegExp(`\\$${m[2]}\\s*=\\s*(?:self|static|[\\w\\\\]+)::(\\w+)\\(\\s*\\)`).exec(source);
            if (alias)
                into.add(alias[1]);
            else if (new RegExp(`\\$${m[2]}\\s*=\\s*\\[`).test(source))
                into.add(m[2]);
        }
    }
    // (each name costs two whole-file searches: a file with hundreds of [0] / .First() reads is a data table, not a
    // place that picks a version; the first 200 names are enough)
    for (const name of [...hits].slice(0, 200)) {
        const n = name.replace(/[$]/g, "\\$");
        const imported = new RegExp(`\\bimport\\b[^;\\n]*\\b${n}\\b|\\bfrom\\s+\\S+\\s+import\\b[^\\n]*\\b${n}\\b|\\b${n}\\b[^\\n]*=\\s*require\\(`).test(source);
        // JS/TS/Python/Ruby (NAME = …), Go (NAME := …, var NAME = …), Java/C# (static final List<String> NAME = …)
        const declared = new RegExp(`(^|\\n)[ \\t]*(export\\s+)?(const|let|var)\\s+${n}\\b|(^|\\n)[ \\t]*${n}\\s*(:[^=\\n]+)?:?=|(^|\\n)[ \\t]*(?:(?:public|private|protected|internal|static|final|readonly|const)\\s+)*[\\w<>\\[\\],.? ]+\\s+${n}\\s*=`).test(source);
        if (imported || declared)
            into.add(name);
    }
}
