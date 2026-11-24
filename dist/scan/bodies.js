const SAMPLING = { temperature: ["temperature", "Temperature"], top_p: ["top_p", "topP", "TopP"], top_k: ["top_k", "topK", "TopK"] };
export const BODY_SHAPES = [
    {
        provider: "anthropic",
        op: "POST /v1/messages",
        needs: /anthropic|claude/i,
        anchors: [
            /["'`]\/v1\/messages["'`?]/,
            /\bMessageNewParams\s*\{/,
            /\bnew\s+ChatAnthropic(?:Messages)?\s*\(/,
            /\bChatAnthropic(?:Messages)?\s*\(/,
        ],
        // The SDK call itself is read by the analyzers; only what it takes from elsewhere (a name, a spread) is followed here
        followOnly: [/\bmessages\.(?:create|stream)\s*\(/],
        keys: SAMPLING,
    },
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_SPAN_LINES = 120;
/** Offsets of each line's start */
function starts(text) {
    const out = [0];
    for (let i = 0; i < text.length; i++)
        if (text[i] === "\n")
            out.push(i + 1);
    return out;
}
const lineAt = (st, at) => {
    let lo = 0, hi = st.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (st[mid] <= at)
            lo = mid;
        else
            hi = mid - 1;
    }
    return lo;
};
/** Text with strings and comments blanked (same length), so brackets inside them don't count */
function blank(text) {
    return text.replace(/\/\/[^\n]*|#(?![{])[^\n]*|(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => (m[0] === '"' || m[0] === "'" || m[0] === "`" ? m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[m.length - 1] : " ".repeat(m.length)));
}
/** The end of the balanced span that opens at `open` (a ( or { in `b`), or -1 */
function closeOf(b, open, st) {
    let depth = 0;
    const lastLine = lineAt(st, open) + MAX_SPAN_LINES;
    const limit = lastLine < st.length ? st[lastLine] : b.length;
    for (let i = open; i < limit; i++) {
        const c = b[i];
        if (c === "(" || c === "{" || c === "[")
            depth++;
        else if ((c === ")" || c === "}" || c === "]") && --depth === 0)
            return i;
    }
    return -1;
}
/** The ( that opens the call around `at`, or -1 */
function enclosingOpen(b, at) {
    let depth = 0;
    for (let i = at; i >= Math.max(0, at - 4000); i--) {
        const c = b[i];
        if (c === ")" || c === "}" || c === "]")
            depth++;
        else if (c === "(" || c === "{" || c === "[") {
            if (depth === 0 && c === "(")
                return i;
            if (depth > 0)
                depth--;
        }
    }
    return -1;
}
export function requestBodyUsages(path, lang, text, found) {
    if (text.length > 2_000_000)
        return [];
    const out = [];
    const have = new Set(found.filter((u) => u.params?.length).flatMap((u) => u.params.map((p) => `${u.line}|${u.op}|${p}`)));
    let b;
    let st;
    const lines = text.split("\n");
    for (const shape of BODY_SHAPES) {
        if (!shape.needs.test(text) || shape.notIf?.test(text))
            continue;
        b ??= blank(text);
        st ??= starts(text);
        const spellings = Object.entries(shape.keys).flatMap(([wire, alts]) => alts.map((a) => [a, wire]));
        const wireOf = new Map(spellings);
        const alt = spellings.map(([a]) => esc(a)).join("|");
        // A key written as a key: k: / "k": / :k => / k= / "k" => ; or JS shorthand { k, … }
        const KEY = new RegExp(`(?:^|[\\s{,(])(?:["':]?)(${alt})["']?\\s*(?::(?!:)|=>|=(?!=))|[{,]\\s*(${alt})\\s*(?=[,}])`, "g");
        const report = (from, to, why) => {
            const seg = text.slice(from, to);
            for (const m of seg.matchAll(KEY)) {
                const k = m[1] ?? m[2];
                const wire = wireOf.get(k);
                const at = from + m.index + m[0].indexOf(k);
                const line = lineAt(st, at) + 1;
                const id = `${line}|${shape.op}|${wire}`;
                if (have.has(id))
                    continue;
                have.add(id);
                out.push({
                    provider: shape.provider, kind: /^["'`]\//.test(why) ? "http" : "sdk", lang, file: path, line, op: shape.op, params: [wire], confidence: "possible",
                    snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `sent in the ${shape.op} request body (${why})`,
                    paramSpans: { [wire]: { start: at, end: at + k.length } },
                });
            }
        };
        /** Names in a span that hold the body: a sole argument, a spread, a variable posted */
        const follow = (from, to, anchorLine, why, depth = 0, direct = true) => {
            if (direct)
                report(from, to, why);
            if (depth > 1)
                return;
            const seg = b.slice(from, to + 1);
            // ...helper(…): the object the helper returns, from its definition in this file
            for (const m of seg.matchAll(/\.\.\.\s*(?:this\.)?([A-Za-z_$][\w$]*)\s*\(/g)) {
                const def = new RegExp(`(?:\\bfunction\\s+${esc(m[1])}\\s*\\(|\\b${esc(m[1])}\\s*(?:=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>|\\([^)]*\\)\\s*(?::[^{]+)?\\{))`).exec(b);
                if (!def)
                    continue;
                const open = b.indexOf("{", def.index + def[0].length - 1);
                const close = open >= 0 ? closeOf(b, open, st) : -1;
                if (close > 0)
                    follow(open, close, anchorLine, `${why}, from ${m[1]}()`, depth + 1);
            }
            // A name as an argument or spread (llmConfig, ...opts, payload.to_json): its object literal, and keys merged into it
            for (const m of seg.matchAll(/(?:\.\.\.|[(,]\s*|\bbody\s*[:=]\s*)([A-Za-z_$][\w$]*)(?:\.to_json|\.to_h)?\s*(?=[,)}\n])/g)) {
                const name = esc(m[1]);
                if (/^(true|false|null|nil|None|undefined|this|self)$/.test(m[1]))
                    continue;
                // The nearest definition before the use (another function's object of the same name doesn't count), and
                // what's merged into it after that
                const defRe = new RegExp(`^\\s*(?:(?:const|let|var|final)\\s+)?[@$]?${name}\\s*(?::[^=]+)?=(?!=)`);
                const addRe = new RegExp(`^\\s*[@$]?${name}\\s*(?:=\\s*[@$]?${name}\\s*)?(?:\\.merge!?\\(|\\.update\\(|\\[)`);
                let first = -1;
                for (let r = anchorLine; r >= Math.max(0, anchorLine - MAX_SPAN_LINES) && first < 0; r--)
                    if (defRe.test(lines[r]) && !addRe.test(lines[r]))
                        first = r;
                if (first < 0)
                    continue;
                for (let r = first; r <= anchorLine; r++) {
                    const l = lines[r];
                    const add = addRe.test(l);
                    if (r !== first && !add)
                        continue;
                    const open = b.slice(st[r], st[r + 1] ?? text.length).search(/[({]/);
                    const at = open >= 0 ? st[r] + open : -1;
                    const close = at >= 0 ? closeOf(b, at, st) : -1;
                    // An object, dict or merge opens a span; a one-line key assignment (payload[:top_p] = 0.9) is the line itself.
                    // A plain value (a parameter's default, temperature = 0.7) isn't a body
                    if (close > 0)
                        report(st[r], close, `${why}, ${m[1]}`);
                    else if (/\[/.test(l) && add)
                        report(st[r], st[r] + l.length, `${why}, ${m[1]}`);
                }
            }
        };
        for (const [a, direct] of [...shape.anchors.map((x) => [x, true]), ...(shape.followOnly ?? []).map((x) => [x, false])]) {
            const re = new RegExp(a.source, "g");
            for (const m of text.matchAll(re)) {
                const isPath = /^["'`]/.test(m[0]);
                const open = isPath ? enclosingOpen(b, m.index) : m.index + Math.max(m[0].lastIndexOf("("), m[0].lastIndexOf("{"));
                if (open < 0)
                    continue;
                const close = closeOf(b, open, st);
                if (close < 0)
                    continue;
                follow(open, close, lineAt(st, m.index), isPath ? m[0].replace(/[?]$/, "") : m[0].replace(/\s*[({]$/, ""), 0, direct);
            }
        }
    }
    return out;
}
/** A line declaring, returning or casting a value as one of the SDK's request types (not a parameter annotated so) */
function typedRequest(types, line) {
    if (!types.test(line))
        return false;
    const T = `(?:[\\w$]+\\.)*(?:${types.source.replace(/^\\b|\\b$/g, "")})`;
    return [
        // const params: T = …, params: T = {…} (Python), let p: T;
        new RegExp(String.raw `(?:^|[\s;{])(?:(?:const|let|var|val|final|readonly|private|public|protected)\s+)*[A-Za-z_$][\w$]*\s*:\s*${T}\s*(?:=(?![=>])|;|$)`),
        // a function returning one: (omit): T => {…}, function build(): T {, def build(...) -> T:
        new RegExp(String.raw `\)\s*(?::|->)\s*(?:Promise\s*<\s*)?${T}\s*>?\s*(?:=>|\{|:)`),
        // a cast or check: {…} as T, satisfies T
        new RegExp(String.raw `\b(?:as|satisfies)\s+${T}\b`),
        // a TypedDict / params constructor: MessageCreateParams(model=…, …), new MessageCreateParams(…)
        new RegExp(String.raw `(?<![\w$.:]\s*:\s*)(?:\bnew\s+)?${T}\s*\(`),
    ].some((r) => r.test(line));
}
const anyOf = (...rs) => ({ test: (s) => rs.some((r) => r.test(s)) });
export const REGION_SHAPES = [
    {
        provider: "anthropic",
        op: "POST /v1/messages",
        needs: /anthropic|claude/i,
        urlAnchors: [/api\.anthropic\.com/i, /["'`][^"'`\s]*\/v1\/messages\b/, /anthropic-version/i],
        anchors: [
            /\bMessages\.New(?:Streaming)?\s*\(/, /\bMessageNewParams\b/, /\b(?:Beta)?Message(?:Create|Stream)Params\w*/, /\bmessages\.(?:create|stream)\s*\(/,
            /\banthropic\.New\s*\(/, /\bChatAnthropic\b/, /\bcreateAnthropic\b|@ai-sdk\/anthropic/, /\banthropic\s*\(\s*["'`]claude/,
            /\b(?:providers::)?anthropic::(?:Client|ClientBuilder|completion|CLAUDE)/, /\bAnthropicClient\b|\bAnthropic\.SDK\b|\bnew\s+Anthropic\s*\(/,
            /["'`](?:anthropic\/)?claude-[\w.:@-]+["'`]/,
        ],
        // Whole words: "coherence" in a prompt isn't Cohere
        // (also an OpenAI-format destination: a converter that builds chat/completions or Responses requests from Anthropic
        // input sends them there, Review:, 24 Nov; and a destination built by a helper named for
        // one, resolveOpenAiEndpoint(…) / openAiCompatibleUrl / open_ai_base_url, test sets)
        // (identifier-shaped names match only as written: ChatCompletionCreateParams is OpenAI's type, a chatCompletion()
        // method is anyone's; test sets)
        others: anyOf(/api\.openai\.com|\bOpenAI\b|\bopen_?ai_?compat|\bopenai\.|\.chat\.completions\.create\b|\.responses\.create\b|\/(?:v\d+\/)?(?:chat\/)?completions\b|\/(?:v\d+\/)?responses\b|generativelanguage|\bgemini\b|\bmistral(?:ai)?\b|\bgroq\b|\bollama\b|\bdeepseek\b|\bcohere\b|\bbedrock\b|\bvertex(?:ai)?\b|\bazure\b|together\.ai|\bfireworks\b|\bopenrouter\b|\bxai\b|\bgrok\b/i, /[a-z_](?:open_?ai|Open_?[Aa][Ii]|OPEN_?AI)(?=[A-Z_]|[Cc]ompat)|[a-z]Compatible(?:Endpoint|Url|URL|Uri|Base|Api|API|Client|Path)\b|\bChatCompletion\w*|\bResponseCreateParams\b/),
        pathOnly: /anthropic|claude/i,
        keys: SAMPLING,
        // the SDK's own request types: a value declared, annotated, returned or cast as one is that request's body
        requestTypes: /\b(?:Anthropic\.)?(?:Beta\.)?(?:Messages\.)?(?:Beta)?(?:Message(?:Create|Stream)Params(?:NonStreaming|Streaming|Base)?|MessageNewParams)\b/,
    },
];
const FN_HEADER = /^\s*(?:(?:export|default|public|private|protected|internal|static|async|override|virtual|final|pub(?:\([\w]+\))?|suspend)\s+)*(?:func\b|function\b|def\b|fn\b|fun\b|sub\b|[\w$]+\s*:\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*=>)|(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|[\w$<>\[\],.?]+\s+[\w$]+\s*\([^;]*$|[\w$]+\s*\([^;]*\)\s*(?::[^{]*)?\{)/;
/** Rows [start, end] of the function a row is in, and the row its body starts on (after the signature) */
function enclosingFunction(lines, b, row, indentLang) {
    if (indentLang) {
        const ind = (l) => /^\s*/.exec(l)[0].length;
        // Lines inside a triple-quoted string (a prompt that runs at column 0) don't end the function. Read on the blanked
        // text (v17), so '"""' inside an ordinary string doesn't open one
        const inStr = new Set();
        let open;
        for (let k = Math.max(0, row - 400); k < Math.min(lines.length, row + 600); k++) {
            if (open)
                inStr.add(k);
            for (const m of b[k].matchAll(/"""|'''/g))
                open = open ? (open === m[0] ? undefined : open) : m[0];
        }
        for (let r = row; r >= Math.max(0, row - 400); r--) {
            const m = /^(\s*)(?:async\s+)?def\s+\w+/.exec(lines[r]);
            if (!m || (r !== row && m[1].length >= ind(lines[row]) && lines[row].trim()))
                continue;
            let body = r;
            // The signature ends at the line ending with ":" (Python) or the def line (Ruby)
            while (body < Math.min(lines.length - 1, r + 15) && !/[:)]\s*(?:->\s*[^:]+)?:\s*(#.*)?$|^\s*def\s+[\w.?!]+(?:\([^)]*\))?\s*$/.test(lines[body]))
                body++;
            let end = body;
            for (let k = body + 1; k < Math.min(lines.length, r + 600); k++) {
                const l = lines[k];
                if (!l.trim() || /^\s*#/.test(l) || inStr.has(k))
                    continue;
                if (ind(l) <= m[1].length)
                    break;
                end = k;
            }
            if (end >= row)
                return { start: r, body: body + 1, end };
            return undefined;
        }
        return undefined;
    }
    // Brackets: the nearest header above whose { … } holds the row
    for (let r = row; r >= Math.max(0, row - 400); r--) {
        if (!FN_HEADER.test(lines[r]) || /^\s*(if|for|while|switch|catch|return|else)\b/.test(lines[r]))
            continue;
        let depth = 0;
        let opened = -1;
        // Braces inside the signature's parentheses (a destructured parameter: callAnthropic({ prompt, … })) aren't the body
        let paren = 0;
        for (let k = r; k < Math.min(lines.length, r + 800); k++) {
            for (const ch of b[k]) {
                if (opened < 0 && (ch === "(" || ch === ")")) {
                    paren += ch === "(" ? 1 : -1;
                    continue;
                }
                if (opened < 0 && paren > 0)
                    continue;
                if (ch === "{") {
                    if (opened < 0)
                        opened = k;
                    depth++;
                }
                else if (ch === "}") {
                    depth--;
                    if (opened >= 0 && depth === 0) {
                        if (k >= row && opened <= row)
                            return { start: r, body: opened + (b[opened].trim().endsWith("{") ? 1 : 0), end: k };
                        if (k >= row)
                            return undefined;
                        k = lines.length;
                        break;
                    }
                }
            }
            if (opened < 0 && k > r + 12)
                break;
        }
    }
    return undefined;
}
/** Rows of the innermost { … } block around a row */
function innermostBlock(b, row) {
    let depth = 0;
    for (let r = row; r >= Math.max(0, row - 200); r--) {
        const l = b[r];
        for (let c = (r === row ? l.length : l.length) - 1; c >= 0; c--) {
            if (l[c] === "}")
                depth++;
            else if (l[c] === "{") {
                if (depth === 0) {
                    let d = 0;
                    for (let k = r; k < Math.min(b.length, r + 400); k++)
                        for (let cc = k === r ? c : 0; cc < b[k].length; cc++) {
                            if (b[k][cc] === "{")
                                d++;
                            else if (b[k][cc] === "}" && --d === 0)
                                return [r, k];
                        }
                    return undefined;
                }
                depth--;
            }
        }
    }
    return undefined;
}
/**
 * v17: rows of the innermost statement block around a row (an if / else branch, a function body), passing object
 * literals and call arguments on the way out: fetch(url, { … }) sits in the branch that builds its body
 */
function statementBlock(b, row) {
    let depth = 0;
    for (let r = row; r >= Math.max(0, row - 200); r--) {
        const l = b[r];
        for (let c = l.length - 1; c >= 0; c--) {
            const ch = l[c];
            if (ch === "}" || ch === ")" || ch === "]")
                depth++;
            else if (ch === "{" || ch === "(" || ch === "[") {
                if (depth > 0) {
                    depth--;
                    continue;
                }
                if (ch !== "{")
                    continue;
                let before = l.slice(0, c).trimEnd();
                if (!before)
                    for (let p = r - 1; p >= 0 && !before; p--)
                        before = b[p].trimEnd();
                if (!/(?:\)|\belse|=>|\btry|\bdo|\bfinally)$/.test(before))
                    continue;
                let d = 0;
                for (let k = r; k < Math.min(b.length, r + 400); k++)
                    for (let cc = k === r ? c : 0; cc < b[k].length; cc++) {
                        if (b[k][cc] === "{")
                            d++;
                        else if (b[k][cc] === "}" && --d === 0)
                            return [r, k];
                    }
                return undefined;
            }
        }
    }
    return undefined;
}
/** The innermost bracket still open at (row, col), and the name called just before it when it's a ( */
function openerAt(bl, row, col) {
    let depth = 0;
    for (let r = row; r >= Math.max(0, row - 40); r--) {
        const l = bl[r];
        for (let c = (r === row ? col : l.length) - 1; c >= 0; c--) {
            const ch = l[c];
            if (ch === ")" || ch === "]" || ch === "}")
                depth++;
            else if (ch === "(" || ch === "[" || ch === "{") {
                if (depth === 0)
                    return { ch, callee: ch === "(" ? (/([\w$.:]+)\s*$/.exec(l.slice(0, c))?.[1] ?? "") : "", row: r, col: c };
                depth--;
            }
        }
    }
    return undefined;
}
/** Calls whose options aren't a request body: search and retrieval (top_k), formatting, logging, telemetry */
const NOT_BODY_CALLEE = /search|query|retriev|find|similar|rerank|format|log|print|render|track|emit|metric|span|setAttribute|setTag|histogram/i;
const BODY_CALLEE = /param|option|config|request|payload|body|kwargs|settings|generat|^dict$|\.?update$|\.merge!?$|\.put$|\.set$/i;
// Signs that a file sends an HTTP request or calls a client's messages API
const SENDS = /\.messages\.(?:create|stream|batches)\b|\.Messages\.(?:New|NewStreaming|Create|Stream)\w*\s*\(|\bmessages\(\)\.(?:create|createStreaming)\b|\bhttp\.(?:Post|NewRequest|Do)|\.Do\(|\bfetch\s*\(|\baxios\b|\brequests\.|\bhttpx\.|\baiohttp\b|\burlopen\b|Faraday|Net::HTTP|HTTParty|\bHttpClient\b|PostAsync|SendAsync|RestTemplate|WebClient|OkHttp|HttpRequest|curl_|\bGuzzle|wp_remote_post|\.post\s*\(|\.Post\s*\(|api\.anthropic\.com\/|\bllms\.With|\bCreateMessage\w*\s*\(|\bGenerateContent\s*\(|\.(?:invoke|ainvoke|chat|complete|completion|generate|stream)\s*\(/;
export function regionUsages(path, lang, text, found) {
    if (text.length > 2_000_000 || lang === "config" || lang === "notebook")
        return [];
    const out = [];
    const lines = text.split("\n");
    const indentLang = lang === "py" || lang === "rb";
    const bl = blank(text).split("\n");
    for (const shape of REGION_SHAPES) {
        if (!shape.needs.test(text))
            continue;
        // Constants holding the endpoint (const anthropicURL = "https://api.anthropic.com/v1/messages") anchor their uses
        const urlNames = new Set();
        lines.forEach((l) => {
            if (!shape.urlAnchors.some((a) => a.test(l)))
                return;
            const n = /(?:^|[\s(,{;])(?:(?:export|const|let|var|static|readonly|private|public|protected|internal|final|val)\s+)*(?:[\w<>]+\s+)?[$@]?([A-Za-z_][\w]*)\s*(?::\s*[\w<>\[\]|. ]+)?\s*(?:=|:=|:)\s*f?["'`]/.exec(l)?.[1];
            // v17: a generic name (url, endpoint, base_url) holds other values elsewhere in the file; only a specific one
            // (ANTHROPIC_URL, anthropicEndpoint) anchors its uses
            if (n && n.length > 2 && !/^(?:url|uri|endpoint|path|href|link|host|base|(?:base|api|request|target|full)_?(?:url|uri|endpoint))$/i.test(n))
                urlNames.add(n);
        });
        const nameRe = urlNames.size ? new RegExp(`(?<![\\w$])(?:${[...urlNames].map(esc).join("|")})(?![\\w$])`) : undefined;
        const isAnchor = (l) => shape.urlAnchors.some((a) => a.test(l)) || shape.anchors.some((a) => a.test(l)) || (!!nameRe && nameRe.test(l));
        const isUrl = (l) => shape.urlAnchors.some((a) => a.test(l)) || (!!nameRe && nameRe.test(l));
        const spellings = Object.entries(shape.keys).flatMap(([wire, alts]) => alts.map((a) => [a, wire]));
        const wireOf = new Map(spellings);
        const alt = spellings.map(([a]) => esc(a)).join("|");
        // A quoted key ("temperature": …) on the line as written; the other forms on the line with strings and comments
        // blanked, so a key name inside a log message or a comment doesn't count; `temperature := x` is a local copy
        // (Ruby: params[:temperature] = … and :temperature => …)
        const QKEY = new RegExp(`["'\`](${alt})["'\`]\\s*(?::|=>|,)|\\[\\s*["'](${alt})["']\\s*\\]\\s*=(?!=)|\\[\\s*:(${alt})\\s*\\]\\s*(?:\\|\\|)?=(?!=)`, "g");
        const KEY = new RegExp(`(?<![\\w.$])(${alt})\\s*(?::(?![:=])|=(?![=>]))|:(${alt})\\s*=>|\\.(${alt})\\s*(?:\\(|=(?!=))|\\bWith(${alt})\\s*\\(|[{,]\\s*(${alt})\\s*(?=[,}])|^\\s*(${alt})\\s*(?=,?\\s*$)`, "g");
        const regions = [];
        // Top-level pieces of a parameter or argument list
        const splitTop = (t) => {
            const out = [];
            let d = 0, cur = "";
            for (const ch of t) {
                if ("([{<".includes(ch))
                    d++;
                else if (")]}>".includes(ch) && !(ch === ">" && cur.endsWith("=")))
                    d = Math.max(0, d - 1);
                if (ch === "," && d === 0) {
                    out.push(cur.trim());
                    cur = "";
                }
                else
                    cur += ch;
            }
            if (cur.trim())
                out.push(cur.trim());
            return out;
        };
        // The text between the ( at `open` and its matching ), in the blanked lines, from a row (bounded)
        const parenText = (row, open) => {
            let d = 0, t = "";
            for (let r = row; r < Math.min(bl.length, row + 12); r++)
                for (let c = r === row ? open : 0; c <= bl[r].length; c++) {
                    const ch = c === bl[r].length ? " " : bl[r][c];
                    if (ch === "(") {
                        if (d++ === 0)
                            continue;
                    }
                    else if (ch === ")" && --d === 0)
                        return t;
                    if (d > 0)
                        t += ch;
                }
            return t;
        };
        const callbackRegions = (fn, row) => {
            // the function's name and its parameter list, from its header line
            const hl = bl[fn.start] ?? "";
            const h = /([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*\(/.exec(hl.replace(/^(\s*)((?:(?:export|public|private|protected|static|async|override|def|func|function|fn)\s+)*)/, (_m, a, b) => a + " ".repeat(b.length)));
            if (!h || /^(?:if|for|while|switch|catch|function)$/.test(h[1]))
                return [];
            const params = splitTop(parenText(fn.start, h.index + h[0].length - 1)).map((p) => /^\s*(?:\.\.\.)?\*{0,2}([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? "");
            // a parameter called inside the send's arguments: create(build(omit)), create(**build(x))
            const called = [...bl[row].matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]).filter((n) => params.includes(n));
            const out = [];
            for (const cb of new Set(called)) {
                const k = params.indexOf(cb);
                const callRe = new RegExp(`(?<![\\w$])${esc(h[1])}\\s*(?:<[^()]*>)?\\s*\\(`, "g");
                for (let r = 0; r < bl.length; r++) {
                    if (r >= fn.start && r <= fn.end)
                        continue;
                    for (const m of bl[r].matchAll(callRe)) {
                        const arg = splitTop(parenText(r, m.index + m[0].length - 1))[k] ?? "";
                        const x = /^([A-Za-z_$][\w$]*)$/.exec(arg.trim())?.[1];
                        if (!x)
                            continue;
                        // its definition in this file: const x = (…) => {…}, function x(…), def x(…)
                        const def = bl.findIndex((l) => new RegExp(`(?:\\b(?:const|let|var)\\s+${esc(x)}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\(|function\\b|[A-Za-z_$][\\w$]*\\s*=>)|\\b(?:function|def|func)\\s+${esc(x)}\\s*\\()`).test(l));
                        if (def < 0)
                            continue;
                        const bf = enclosingFunction(lines, bl, Math.min(lines.length - 1, def + 1), indentLang);
                        if (bf && bf.end - bf.body <= 200 && bf.start <= def + 1)
                            out.push({ from: bf.body, to: bf.end, http: false, sends: true });
                    }
                }
            }
            return out;
        };
        // Where a function's request goes: its own signature (a return type), and the lines that call it
        // (openai.responses.create(toResponsesRequest(body))). A request built for another provider isn't this one's
        const elsewhere = (fn) => {
            // the signature only: up to the body, not the body's first line (a branch to another provider there is handled
            // by narrowing to the statement block)
            const header = lines.slice(Math.max(0, fn.start), Math.max(fn.body, fn.start + 1)).join("\n").replace(/\{[^{}]*$/, "{");
            if (shape.others.test(header.replace(/(?<=[a-z0-9])(?=[A-Z][a-z])|(?<=[A-Z])(?=[A-Z][a-z])/g, " ").replace(/_/g, " ")) || shape.others.test(header))
                return true;
            const name = /(?:def|func|function|fn|fun)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|([A-Za-z_$][\w$]*)\s*\([^)]*$|([A-Za-z_$][\w$]*)\s*\(/.exec(header);
            const n = name?.slice(1).find(Boolean);
            if (!n || n.length < 4 || /^(?:if|for|while|switch|catch|function|return)$/.test(n))
                return false;
            const call = new RegExp(`(?<![\\w$.])${esc(n)}\\s*\\(`);
            return lines.some((l, i) => (i < fn.start || i > fn.body) && call.test(l) && shape.others.test(l));
        };
        // A file named for the provider counts whole only if it sends something itself: a mapper or recorder that only
        // reads requests (telemetry, translators) doesn't
        const fileOnly = shape.pathOnly.test(path) && !shape.others.test(text.replace(/\/\/[^\n]*|#[^\n]*/g, "")) && SENDS.test(text);
        if (fileOnly)
            regions.push({ from: 0, to: lines.length - 1, http: lines.some(isUrl), pathOnly: true });
        else {
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].length > 2000 || !isAnchor(lines[i]) || /^\s*(\/\/|#|\*|\/\*)/.test(lines[i]))
                    continue;
                // A value declared, annotated, returned or cast as the SDK's own request type (const params:
                // Anthropic.MessageCreateParams = {…}; a builder `(omit): Anthropic.MessageCreateParams => {…}`) is that
                // request's body, whatever function it's in: the region is the function it's in, or the one it heads
                // (not a parameter typed so, toResponsesBody(req: Anthropic.MessageCreateParams): that's a converter's input)
                const typed = typedRequest(shape.requestTypes, lines[i]);
                const heads = typed && /(?:=>|\{|:)\s*$/.test(bl[i]) && /\(/.test(bl[i]);
                const fn = enclosingFunction(lines, bl, heads ? Math.min(lines.length - 1, i + 1) : i, indentLang);
                if (!fn)
                    continue;
                // A function that itself sends to this provider (this.client.messages.create(params), fetch(ANTHROPIC_URL, …))
                // sends what it sets, whatever its signature names: an adapter taking and returning OpenAI-format types
                // (chat(req: ChatCompletionCreateParams): Promise<ChatCompletion>) still sends POST /v1/messages
                const sendsHere = (SENDS.test(lines[i]) && !shape.others.test(lines[i])) || typed;
                if (!sendsHere && elsewhere(fn))
                    continue;
                // A builder passed in and called inside the send (messages.create(buildParams(omit))): the function the callers
                // pass as that argument builds this request too
                if (SENDS.test(lines[i]))
                    for (const r of callbackRegions(fn, i))
                        regions.push(r);
                let [from, to] = [fn.body, fn.end];
                const regionText = lines.slice(from, to + 1).join("\n");
                if (shape.others.test(regionText)) {
                    if (indentLang)
                        continue;
                    const blk = statementBlock(bl, i) ?? innermostBlock(bl, i);
                    if (!blk)
                        continue;
                    [from, to] = blk;
                    if (shape.others.test(lines.slice(from, to + 1).join("\n")))
                        continue;
                }
                regions.push({ from, to, http: isUrl(lines[i]), sends: sendsHere });
                // One hop: helpers this region calls that are defined in this file (buildParams, _anthropic_payload)
                const called = new Set();
                for (const m of lines.slice(from, to + 1).join("\n").matchAll(/(?:\.|\b)([A-Za-z_][\w]*)\s*\(/g))
                    if (m[1].length > 3)
                        called.add(m[1]);
                for (const name of called) {
                    const def = lines.findIndex((l) => new RegExp(`^\\s*(?:(?:export|public|private|protected|internal|static|async|override|pub)\\s+)*(?:func\\s+(?:\\([^)]*\\)\\s*)?|function\\s+|def\\s+|fn\\s+|[\\w<>\\[\\],.?]+\\s+)${esc(name)}\\s*\\(`).test(l));
                    if (def < 0 || (def >= from && def <= to))
                        continue;
                    const hf = enclosingFunction(lines, bl, Math.min(lines.length - 1, def + 1), indentLang);
                    if (!hf || hf.end - hf.body > 150)
                        continue;
                    if (shape.others.test(lines.slice(hf.body, hf.end + 1).join("\n")))
                        continue;
                    regions.push({ from: hf.body, to: hf.end, http: isUrl(lines[i]) });
                }
            }
        }
        // A function named for the provider (_anthropic_payload, buildAnthropicBody, callClaude) builds or sends its requests
        if (!fileOnly) {
            lines.forEach((l, i) => {
                // v17: a signature over several lines (buildAnthropicBody(String model,\n  String system) {): read up to the {
                let h = l;
                for (let k = i + 1; k < Math.min(lines.length, i + 5) && !/[{;]|=>/.test(bl[k - 1]); k++)
                    h += "\n" + lines[k];
                if (!FN_HEADER.test(l) || !/(?:def|func|function|fn)\s+(?:\([^)]*\)\s*)?\w*(?:anthropic|claude)\w*\s*\(|\b\w*(?:Anthropic|Claude|anthropic|claude)\w*\s*(?:=\s*(?:async\s*)?\(|\()[^;]*(?:\{|:|=>)\s*$/.test(h))
                    return;
                // A name that also names another provider (AnthropicRequestToOpenAI) converts between them
                if (shape.others.test(l.replace(/(?<=[a-z0-9])(?=[A-Z][a-z])|(?<=[A-Z])(?=[A-Z][a-z])/g, " ").replace(/_/g, " ")))
                    return;
                const fn = enclosingFunction(lines, bl, Math.min(lines.length - 1, i + 1), indentLang);
                if (!fn || fn.start > i + 1 || fn.end - fn.body > 200)
                    return;
                if (elsewhere(fn))
                    return;
                if (shape.others.test(lines.slice(fn.body, fn.end + 1).join("\n")))
                    return;
                regions.push({ from: fn.body, to: fn.end, http: lines.slice(fn.body, fn.end + 1).some(isUrl) });
            });
        }
        // A table of the provider's setting names the sending code copies into the request by name (test sets:
        // _PARAM_NAMES = {"temperature": …, "top_p": …} and `for ours, wire in _PARAM_NAMES.items(): body[wire] = …`):
        // the table's entries are what's sent. Only a table defined at the top of this file, looped over in a region that
        // sends or builds the request, with the loop's variable used as the key a value is written under
        const tables = [];
        for (const r of regions) {
            for (let k = r.from; k <= r.to && k < lines.length; k++) {
                const loop = /^\s*for\s+([\w\s,()]+?)\s+in\s+([A-Za-z_]\w*)(?:\.(?:items|keys|values)\(\))?\s*:/.exec(bl[k]) ??
                    /\bfor\s*\(\s*(?:const|let|var)\s+([\w\s,[\]{}$]+?)\s+(?:of|in)\s+(?:Object\.(?:entries|keys|values)\(\s*)?([A-Za-z_$][\w$]*)\s*\)?\s*\)/.exec(bl[k]) ??
                    /^\s*for\s+([\w\s,]+?)\s*:=\s*range\s+([A-Za-z_]\w*)\s*\{/.exec(bl[k]);
                if (!loop)
                    continue;
                const [vars, name] = [loop[1], loop[2]];
                const vs = (vars.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((v) => !/^(?:const|let|var|_)$/.test(v));
                if (!vs.length || name.length < 3)
                    continue;
                // the loop writes a value under one of its variables: body[wire] = …, out.set(wire, …), body[wire] ||= …
                const vAlt = vs.map(esc).join("|");
                const writes = new RegExp(String.raw `\[\s*(?:${vAlt})\s*\]\s*(?:\|\||\?\?)?=(?!=)|\.(?:set|put|setdefault)\(\s*(?:${vAlt})\s*,`);
                if (!bl.slice(k, Math.min(r.to + 1, k + 15)).some((l) => writes.test(l)))
                    continue;
                const defRe = new RegExp(String.raw `^(?:export\s+)?(?:(?:const|let|var|val|final|static|readonly)\s+)*${esc(name)}\s*(?::[^=]+)?=\s*(?:map\[[^\]]+\][\w.*]*\s*|[\w.]*(?:frozenset|dict|set|tuple|Map|Set|Object\.freeze)\(\s*)?[{[(]`);
                const def = bl.findIndex((l) => defRe.test(l));
                if (def < 0)
                    continue;
                // the literal's extent, by brackets in the blanked text, from its opening bracket (not a type's: map[string]…)
                let depth = 0, end = -1;
                const open = defRe.exec(bl[def])[0].length - 1;
                scan: for (let r2 = def; r2 < Math.min(bl.length, def + 200); r2++)
                    for (const ch of bl[r2].slice(r2 === def ? open : 0)) {
                        if ("{[(".includes(ch))
                            depth++;
                        else if ("}])".includes(ch) && --depth === 0) {
                            end = r2;
                            break scan;
                        }
                    }
                if (end >= 0 && !tables.some((t) => t.from === def))
                    tables.push({ from: def, to: end });
            }
        }
        const have = new Set();
        if (tables.length) {
            const QSTR = new RegExp(`["'\`](${alt})["'\`]`, "g");
            for (const t of tables)
                for (let k = t.from; k <= t.to; k++) {
                    const l = lines[k];
                    if (/^\s*(\/\/|#)/.test(l))
                        continue;
                    for (const m of l.matchAll(QSTR)) {
                        const wire = wireOf.get(m[1]);
                        const line = k + 1;
                        if (have.has(`${line}|${wire}`))
                            continue;
                        have.add(`${line}|${wire}`);
                        out.push({
                            provider: shape.provider, kind: regions.some((r) => r.http) ? "http" : "sdk", lang, file: path, line, op: shape.op, params: [wire], confidence: "possible",
                            snippet: l.trim().slice(0, 200), reason: `named in a table the code that sends ${shape.op} copies into the request`,
                        });
                    }
                }
        }
        // Already reported by the analyzers on the call (a builder's .temperature(0.2) a few lines above create(params))
        const covered = (line, wire) => found.some((u) => u.op === shape.op && u.params?.includes(wire) && Math.abs(line - u.line) <= 12) || have.has(`${line}|${wire}`);
        // The lines that send the object a key sits in, when it's a named local (const body = { temperature, … } posted
        // once, then again in a tool loop): the finding is where the key is set, and also where each send passes it
        const sendLines = (op, from, to) => {
            if (!op || op.ch !== "{")
                return [];
            const name = /(?:^|[\s(,;])(?:(?:const|let|var|val|final)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/.exec(bl[op.row].slice(0, op.col))?.[1];
            if (!name || name.length < 3)
                return [];
            const use = new RegExp(`(?<![\\w$.])${esc(name)}(?![\\w$])\\s*(?:[,)}]|$)`);
            const out = [];
            for (let j = op.row + 1; j <= to && j < lines.length; j++) {
                if (!use.test(bl[j]))
                    continue;
                if ([0, 1, 2, 3].some((d) => j - d >= from && isAnchor(lines[j - d])))
                    out.push(j + 1);
            }
            return out.length > 1 ? out : [];
        };
        for (const r of regions) {
            for (let k = r.from; k <= r.to; k++) {
                const l = lines[k];
                if (l.length > 2000 || /^\s*(\/\/|#|\*|\/\*)/.test(l) || FN_HEADER.test(l) && /\)\s*(?:[:{]|->|$)/.test(l) && /\bdef\b|\bfunc\b|\bfunction\b|\bfn\b/.test(l))
                    continue;
                for (const m of [...l.matchAll(QKEY), ...bl[k].matchAll(KEY)]) {
                    const k2 = m.slice(1).find(Boolean);
                    const wire = wireOf.get(k2);
                    // Reading a value back (resp.Temperature, config.temperature) isn't writing one
                    if (m[0].startsWith(".") && !/[=(]/.test(m[0]))
                        continue;
                    const col = m.index + m[0].indexOf(k2);
                    // an option setter copies its caller's value (func WithTemperature(t float64) Option { … c.Temperature = t }):
                    // the setter's header, and a field set to one of the enclosing function's parameters, aren't defaults
                    //
                    if (/^\s*(?:func|def|function|fn|fun|public|private|protected|static)\b[^=]*\(/.test(l) && /\)\s*[\w*.\[\]]*\s*\{?\s*$/.test(l))
                        continue;
                    {
                        // (a field assignment only, c.Temperature = t: a body's key given a parameter, {"temperature": v} in a
                        // request helper, still sends it)
                        const v = l[col - 1] === "." ? /^\s*=(?!=)\s*([A-Za-z_$][\w$]*)\s*;?\s*\}?\s*$/.exec(l.slice(col + k2.length)) : null;
                        if (v) {
                            // (the parameters of every enclosing header nearby: a closure's c, and the setter's own t around it)
                            let params;
                            for (let r = k; r >= Math.max(0, k - 12); r--) {
                                const h = /\b(?:func|def|function|fn|fun)\b[^(]*\(([^)]*)\)/.exec(lines[r]) ?? /^\s*(?:(?:public|private|protected|static|final)\s+)+[\w<>\[\]?]+\s+\w+\s*\(([^)]*)\)/.exec(lines[r]);
                                if (h)
                                    params = `${params ?? ""},${h[1]}`;
                                // a top-level function header ends the search
                                if (h && /^(?:func|def|function|fn|fun)\b/.test(lines[r]))
                                    break;
                            }
                            // (only where the function sends nothing itself: one that sends the request it builds sends the value too,
                            // whatever its source; test sets)
                            if (!r.sends && params !== undefined && new RegExp(String.raw `(?:^|[\s,(*&])${v[1].replace(/\$/g, "\\$")}\b`).test(params))
                                continue;
                        }
                    }
                    // a key written inside another string (JSON shown to a user): a UI attribute's text (placeholder='{"temperature":
                    // 0.7}', label, title, hint, helperText, description, example, tooltip, aria-*) isn't a request
                    if (bl[k][col] === " " && l[col] !== " ") {
                        const q = Math.max(bl[k].lastIndexOf('"', col), bl[k].lastIndexOf("'", col), bl[k].lastIndexOf("`", col));
                        if (q >= 0 && /(?:placeholder|label|title|hint|helperText|helper_text|description|example|tooltip|aria-[\w-]+|alt|caption)\s*(?:=|:|=>)\s*\{?\s*$/i.test(l.slice(0, q)))
                            continue;
                    }
                    // a setting's name as a widget's or field's name (gr.Slider(name="temperature", default=0.7), label="top_p"),
                    // and anything given to a UI widget (Slider, NumberInput, Range …) isn't a request
                    if (/(?:\b(?:name|label|id|title|field|key)\s*=\s*)["']$/.test(l.slice(0, Math.max(0, col))))
                        continue;
                    if (/^\s*["']?\s*(?:=|:)\s*(?:[\w$]+\.)*(?:Slider|RangeSlider|NumberInput|InputNumber|Range|Knob|Textbox|TextInput|Dropdown|Select|Number|Spinner|SpinBox|Stepper|FormField|Input)\s*\(/.test(l.slice(col + k2.length)))
                        continue;
                    const op = openerAt(bl, k, col);
                    if (op?.ch === "(" && /(?:^|\.)(?:Slider|RangeSlider|NumberInput|InputNumber|Range|Knob|Textbox|TextInput|Dropdown|Select|Number|Spinner|SpinBox|Stepper|Field|FormField|Input)$/.test(op.callee))
                        continue;
                    const anchorCall = (c) => shape.anchors.some((a) => a.test(`${c}(`)) || /messages|anthropic|claude/i.test(c);
                    // A keyword argument (top_k=5) counts in an Anthropic call or a body / options builder, not in .format() or a search
                    if (/^[\w]+\s*=/.test(m[0].trim()) && op?.ch === "(" && !anchorCall(op.callee) && !BODY_CALLEE.test(op.callee))
                        continue;
                    // An object handed to a search, a formatter or a logger ({ top_k: 5 }) isn't a request body; nor one handed to
                    // UI state (setConfig({ …, temperature }), this.setState, dispatch) or a value read from a form event
                    // (e.target.value)
                    if (op?.ch === "{") {
                        const outer = openerAt(bl, op.row, op.col);
                        if (outer?.ch === "(" && NOT_BODY_CALLEE.test(outer.callee))
                            continue;
                        if (outer?.ch === "(" && /(?:^|\.)(?:set[A-Z]\w*|setState|dispatch|update\w*State|patchState)$/.test(outer.callee))
                            continue;
                    }
                    if (/^\s*(?:Number|parseFloat|parseInt|String)?\(?\s*(?:e|ev|evt|event)\.(?:target|currentTarget)\b/.test(l.slice(m.index + m[0].length)))
                        continue;
                    // Shorthand ({ temperature, … }) only directly inside an object, not in a call's arguments; on a line of its
                    // own (v17), only in an object literal: not a destructuring pattern (const { temperature } = opts) or a
                    // function's parameters
                    if (m[0].trim().startsWith(",") || m[0].trim().startsWith("{")) {
                        if (/=|:/.test(m[0])) { /* not shorthand */ }
                        else if (op?.ch !== "{")
                            continue;
                    }
                    else if (/^\s*[\w$]+\s*$/.test(m[0])) {
                        if (op?.ch !== "{")
                            continue;
                        const before = bl[op.row].slice(0, op.col);
                        if (!/(?:[=(,:?\[]|=>|\breturn)\s*$/.test(before) || /\b(?:const|let|var)\s*$/.test(before) || FN_HEADER.test(bl[op.row]))
                            continue;
                        // A destructuring assignment closes with } = …
                        let d = 0, after = "";
                        walk: for (let r2 = op.row; r2 < Math.min(bl.length, op.row + 200); r2++)
                            for (let c2 = r2 === op.row ? op.col : 0; c2 < bl[r2].length; c2++) {
                                const ch = bl[r2][c2];
                                if (ch === "{" || ch === "(" || ch === "[")
                                    d++;
                                else if ((ch === "}" || ch === ")" || ch === "]") && --d === 0) {
                                    after = bl[r2].slice(c2 + 1);
                                    break walk;
                                }
                            }
                        if (/^\s*=(?![=>])/.test(after))
                            continue;
                    }
                    // A field copying a parameter of the same name (this.temperature = temperature) isn't a value being sent
                    // (in a function that sends the request, only a field on the object itself, this.temperature = temperature:
                    // params.temperature = temperature there puts it in the body)
                    if (/^\.\w+\s*=$/.test(m[0].trim()) && (!r.sends || /^\s*(?:this|self)\s*\./.test(bl[k])) && new RegExp(`=\\s*${esc(k2)}\\s*;?\\s*$`, "i").test(bl[k]))
                        continue;
                    // A getter (params.temperature()) reads the value back
                    if (m[0].startsWith(".") && /^\s*\)/.test(l.slice(m.index + m[0].length)))
                        continue;
                    // Several names assigned or returned at once (a, temperature, b := f(req); return a, temperature) are locals
                    if (/^\s*return\s+[\w$.]+(?:\s*,\s*[\w$.]+)+\s*;?\s*$/.test(bl[k]) || /^\s*[\w$]+(?:\s*,\s*[\w$]+)+\s*:?=(?!=)/.test(bl[k]))
                        continue;
                    const rest = l.slice(m.index + m[0].length);
                    // A local declared from somewhere else (var temperature = _config.Temperature; double topP = opts.TopP) is a
                    // value read; the key it's put under in the request is what's sent
                    if (/=\s*$/.test(m[0]) && !/^\s*[\w$]+\s*=\s*-?[\d.]+\s*[;,]?\s*$/.test(l) && new RegExp(`^\\s*(?:(?:var|let|const|val|auto|final|readonly)\\s+|(?:double|float|decimal|Double|Float|float32|float64|int|Integer|Optional<\\w+>|number)\\??\\s+)${esc(k2)}\\s*=`).test(bl[k]))
                        continue;
                    // A schema for the setting (temperature: z.number().min(0)) validates input; it isn't a value
                    if (/^\s*(?:z|zod|Joi|yup|t|v|s)\.(?:number|string|optional|union|nullable|coerce|float|int)\b/.test(rest))
                        continue;
                    // A local filled from a getter of the same setting (Double temperature = request.temperature()) reads it back
                    if (/=\s*$/.test(m[0]) && new RegExp(`\\.(?:get)?${esc(k2)}\\s*\\(\\s*\\)`, "i").test(rest))
                        continue;
                    const line = k + 1;
                    if (covered(line, wire))
                        continue;
                    have.add(`${line}|${wire}`);
                    const sends = sendLines(op, r.from, r.to);
                    out.push({
                        provider: shape.provider, kind: r.http ? "http" : "sdk", lang, file: path, line, op: shape.op, params: [wire], confidence: "possible",
                        snippet: l.trim().slice(0, 200), reason: `set in code that sends ${shape.op}`,
                        ...(sends.length ? { alsoLines: sends.filter((x) => x !== line) } : {}),
                    });
                }
            }
        }
    }
    return out;
}
