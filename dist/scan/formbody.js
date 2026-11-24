/**
 * Form-encoded request bodies posted to a provider URL, in every language (Stripe audit, test sets: its SDK shapes
 * were all found, a raw form post never was):
 *   new URLSearchParams({ amount: "1", "payment_method_types[]": "card" })        fetch(url, { body })
 *   requests.post(url, data={"amount": 1, "payment_method_types[]": "card"})
 *   Net::HTTP.post_form(uri, "amount" => 1, "payment_method_types[]" => "card")
 *   form := url.Values{}; form.Add("payment_method_types[]", "card"); http.Post(url, "application/x-www-form-urlencoded", …)
 *   "amount=1000&payment_method_types[]=card"                                       HttpRequest / HttpClient
 *   new FormUrlEncodedContent(new Dictionary<string,string> { {"amount","1000"} })
 * Near a literal provider URL (inside the same function, up to 30 lines either side) the form's keys are the request's
 * params, at their lines; a key's bracket suffix is dropped (payment_method_types[] → payment_method_types, card[number]
 * → card: the top-level field the API names). Text-based and bounded; only what a form constructor or a form-shaped
 * string visibly holds.
 */
import { matchUrl } from "../providers.js";
const WINDOW = 30;
/** A line that starts another function: the window never crosses it */
const FN_START = /^\s*(?:(?:export|public|private|protected|internal|static|async|final|override|virtual)\s+)*(?:function\b|def\b|func\b|fn\b|(?:[\w<>\[\],.?]+\s+)+\w+\s*\([^)]*\)\s*(?:throws [\w, ]+)?\s*\{?\s*$)|^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[\w<>\[\]]+\s*)?=>/;
const FORM_CTOR = /URLSearchParams|FormData\b|url\.Values|FormUrlEncodedContent|FormBody\.Builder|MultipartBody|post_form|set_form_data|urlencode|qs\.stringify|querystring|http_build_query|application\/x-www-form-urlencoded|data\s*=\s*[{(]|Form\(|[A-Za-z_]\w*(?:\[\w*\])?=[^&"'`\s]*&[A-Za-z_]/;
const bare = (k) => k.replace(/(?:\[[^\]]*\])+$/, "");
const KEY = /^[A-Za-z_][\w.-]*(?:\[[\w.-]*\])*$/;
/** Top-level keys of a bracketed literal opening at `open`: "k": / k: / "k" => / {"k", v} / url.Values{"k": {…}} */
function literalKeys(text, open) {
    const o = text[open], c = o === "{" ? "}" : o === "(" ? ")" : "]";
    const out = [];
    let depth = 0, entry = true;
    for (let i = open; i < Math.min(text.length, open + 6000); i++) {
        const ch = text[i];
        if (ch === "#" && o === "(") {
            const j = text.indexOf("\n", i);
            i = j < 0 ? text.length : j;
            continue;
        }
        if (ch === "/" && text[i + 1] === "/") {
            const j = text.indexOf("\n", i);
            i = j < 0 ? text.length : j;
            continue;
        }
        if (ch === o && depth === 0) {
            depth = 1;
            continue;
        }
        if (depth === 1 && entry) {
            // a key: "k" (then : or => or ,) / k: / :k =>   (a pair tuple {"k", v})
            const m = /^(?:\{\s*)?["'`]([^"'`\n]{1,80})["'`]\s*(?::|=>|,)(?!=)|^([A-Za-z_]\w*)\s*:(?!:)|^:(\w+)\s*=>/.exec(text.slice(i, i + 140));
            if (m) {
                const key = m[1] ?? m[2] ?? m[3];
                if (KEY.test(key))
                    out.push({ key, at: i + m[0].indexOf(key) });
                entry = false;
            }
            else if (!/\s/.test(ch) && ch !== c)
                entry = false;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            const q = ch;
            for (i++; i < text.length && text[i] !== q; i++)
                if (text[i] === "\\" && q !== "`")
                    i++;
            continue;
        }
        if (ch === "(" || ch === "[" || ch === "{")
            depth++;
        else if (ch === ")" || ch === "]" || ch === "}") {
            depth--;
            if (depth <= 0)
                break;
        }
        else if (ch === "," && depth === 1)
            entry = true;
    }
    return out;
}
export function formBodyUsages(files, found) {
    const out = [];
    const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
    const seenReq = new Set();
    for (const f of files) {
        if (f.source.length > 1_000_000 || !/https?:\/\//.test(f.source) || !FORM_CTOR.test(f.source))
            continue;
        const lines = f.source.split("\n");
        const offs = [];
        let o = 0;
        for (const l of lines) {
            offs.push(o);
            o += l.length + 1;
        }
        lines.forEach((l, i) => {
            if (l.length > 600 || /^\s*(#|\/\/|\*)/.test(l))
                return;
            for (const um of l.matchAll(/["'`](https:\/\/[^"'`\s{}$]+)["'`]/g)) {
                const hit = matchUrl(um[1]);
                if (!hit || !hit.path || hit.path === "/" || /[{}]/.test(hit.path))
                    continue;
                // the function: back and forward from the URL line to the next function start
                let from = i;
                while (from > Math.max(0, i - WINDOW) && !FN_START.test(lines[from]))
                    from--;
                let to = i + 1;
                while (to < Math.min(lines.length, i + WINDOW) && !FN_START.test(lines[to]))
                    to++;
                const win = lines.slice(from, to).join("\n");
                if (!FORM_CTOR.test(win))
                    continue;
                const base = offs[from];
                const keys = [];
                // form constructors with a literal: URLSearchParams({…}), data={…}, post_form(uri, k => v), FormUrlEncodedContent(new Dictionary { … }), url.Values{…}
                for (const m of win.matchAll(/(?:URLSearchParams|FormUrlEncodedContent|urlencode|qs\.stringify|http_build_query|post_form|set_form_data|url\.Values)\s*[({]|\bdata\s*[=:]\s*[{(]|new\s+Dictionary<[^>]*>\s*[{(]|new\s*\[\]\s*\{/g)) {
                    let open = m.index + m[0].length - 1;
                    // post_form(uri, "k" => v): the keys follow the first argument (a hash without braces)
                    if (/post_form/.test(m[0])) {
                        const comma = win.indexOf(",", open);
                        if (comma < 0)
                            continue;
                        const wrapped = "{" + win.slice(comma + 1, win.indexOf("\n", comma + 1) < 0 ? undefined : undefined);
                        for (const k of literalKeys(wrapped.replace(/\)\s*$/m, "}"), 0))
                            keys.push({ key: k.key, at: comma + k.at });
                        continue;
                    }
                    // data=urlencode({...}) / FormUrlEncodedContent(new Dictionary {...}): go one opener in
                    const inner = /^\(\s*(?:new\s+[\w<>, ]+\s*)?([{[(])/.exec(win.slice(open, open + 80));
                    if (inner && win[open] === "(")
                        open = open + inner[0].length - 1;
                    for (const k of literalKeys(win, open))
                        keys.push({ key: k.key, at: k.at });
                }
                // form.Set("k", v) / params.append("k", v) / body.add("k", v): once the window holds a form constructor
                for (const m of win.matchAll(/\.(?:set|add|append|Set|Add|add_field|addFormDataPart|AddFormDataPart)\s*\(\s*["'`]([A-Za-z_][\w.-]*(?:\[[\w.-]*\])*)["'`]/g))
                    keys.push({ key: m[1], at: m.index + m[0].lastIndexOf(m[1]) });
                // "a=1&b=2&c[]=x": a string that is a query string
                for (const m of win.matchAll(/["'`]((?:[A-Za-z_][\w.-]*(?:\[[\w.-]*\])*=[^&"'`\s]*&)+[A-Za-z_][\w.-]*(?:\[[\w.-]*\])*=[^&"'`\s]*)["'`]/g)) {
                    let at = m.index + 1;
                    for (const pair of m[1].split("&")) {
                        const k = pair.split("=")[0];
                        keys.push({ key: k, at });
                        at += pair.length + 1;
                    }
                }
                if (!keys.length)
                    continue;
                const reqKey = `${f.rel}|${from}|${hit.path}`;
                if (seenReq.has(reqKey))
                    continue;
                seenReq.add(reqKey);
                const done = new Set();
                for (const k of keys) {
                    const key = bare(k.key);
                    if (done.has(key))
                        continue;
                    done.add(key);
                    const line = f.source.slice(0, offs[from] + k.at).split("\n").length;
                    if (have.has(`${f.rel}|${line}|${key}`))
                        continue;
                    have.add(`${f.rel}|${line}|${key}`);
                    out.push({
                        provider: hit.provider.id, kind: "http", lang: f.lang, file: f.rel, line, op: `POST ${hit.path}`, params: [key], confidence: "likely",
                        snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `"${k.key}" is a field of the form posted to ${hit.path} (${f.rel}:${i + 1})`,
                        ...(line !== i + 1 ? { alsoLines: [i + 1] } : {}),
                    });
                }
                void base;
            }
        });
    }
    return out;
}
