/**
 * Go: a struct posted raw as the request body:
 *   type ChatRequest struct { Temperature float64 `json:"temperature,omitempty"` … }
 *   func Send(apiType string, req ChatRequest) { body, _ := json.Marshal(req); url := …; if apiType == "anthropic" {
 *     url = "https://api.anthropic.com/v1/messages" }; http.NewRequest("POST", url, bytes.NewReader(body)) }
 * In a function that names a provider's URL, the value it marshals (or encodes) is the body: its struct's fields,
 * by their json tags, are the request's settings. Reported at the field lines ("possible" when the function also
 * sends elsewhere: a branch per API type). The struct is found in the function's package (its directory).
 */
import { PROVIDERS, matchUrl } from "../providers.js";
const dirOf = (rel) => rel.split("/").slice(0, -1).join("/");
/** The brace-balanced body from an opening { (strings and runes skipped) */
function closeOf(src, open) {
    let d = 0;
    for (let i = open; i < Math.min(src.length, open + 200_000); i++) {
        const c = src[i];
        if (c === '"' || c === "`" || c === "'") {
            const q = c;
            for (i++; i < src.length && src[i] !== q; i++)
                if (src[i] === "\\" && q !== "`")
                    i++;
            continue;
        }
        if (c === "{")
            d++;
        else if (c === "}" && --d === 0)
            return i;
    }
    return -1;
}
export function goStructBodyUsages(files, found) {
    const go = files.filter((f) => f.lang === "go" && f.source.length <= 2_000_000);
    const out = [];
    const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
    const lineAt = (s, at) => s.slice(0, at).split("\n").length;
    // each package's provider base URLs (a versioned https literal: "https://api.openai.com/v1"), one per provider
    const baseCache = new Map();
    const baseOf = (dir) => {
        const hit = baseCache.get(dir);
        if (hit)
            return hit;
        const seen = new Map();
        for (const g of go) {
            if (dirOf(g.rel) !== dir)
                continue;
            for (const m of g.source.matchAll(/["`](https:\/\/[^"`\s]+\/v\d+)\/?["`]/g)) {
                const h = matchUrl(m[1] + "/");
                if (h?.path && /^\/v\d+\/?$/.test(h.path) && !seen.has(h.provider.id))
                    seen.set(h.provider.id, { provider: h.provider, path: h.path });
            }
        }
        const b = [...seen.values()];
        baseCache.set(dir, b);
        return b;
    };
    for (const f of go) {
        if (!/json\.(?:Marshal|NewEncoder)/.test(f.source))
            continue;
        for (const fn of f.source.matchAll(/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(([^)]*)\)[^{\n]*\{/gm)) {
            const open = fn.index + fn[0].length - 1;
            const close = closeOf(f.source, open);
            if (close < 0)
                continue;
            const body = f.source.slice(open, close);
            // the provider URLs it names, and the operation each is
            const hits = [...body.matchAll(/["`](https:\/\/[^"`\s]+)["`]/g)].map((m) => matchUrl(m[1])).filter((h) => !!h && !!h.path && h.path !== "/");
            // a versioned path on a configured base (base+"/v1/messages"): the provider whose own operations have exactly it
            if (!hits.length)
                for (const m of body.matchAll(/["`](\/v\d+\/[\w/]+)["`]/g)) {
                    const owners = PROVIDERS.filter((p) => Object.values(p.sdkOps ?? {}).some((op) => op.split(" ")[1] === m[1]));
                    if (owners.length === 1)
                        hits.push({ provider: owners[0], path: m[1] });
                }
            // a path joined to a configured base (c.APIURL + "/responses") where the package sets one provider's versioned
            // base (Default: "https://api.openai.com/v1" in provider.go): that provider's operation
            if (!hits.length)
                for (const m of body.matchAll(/[\w.)\]]\s*\+\s*["`](\/[a-z][\w/]*)["`]/g)) {
                    const bases = baseOf(dirOf(f.rel));
                    if (bases.length !== 1)
                        break;
                    const path = `${bases[0].path.replace(/\/$/, "")}${m[1]}`;
                    if (Object.values(bases[0].provider.sdkOps ?? {}).some((op) => op.split(" ")[1] === path))
                        hits.push({ provider: bases[0].provider, path });
                }
            if (!hits.length)
                continue;
            const others = /["`][^"`]*\/(?:v\d+\/)?(?:chat\/completions|responses|completions)["`]/.test(body);
            // the value it marshals: json.Marshal(req) / json.NewEncoder(w).Encode(req)
            for (const mm of body.matchAll(/json\.(?:Marshal(?:Indent)?|NewEncoder\([^)]*\)\.Encode)\(\s*&?([\w.]+)(\s*\()?/g)) {
                const v = mm[1];
                // a call's result (json.Marshal(ConvertToClaude(req))): the function's return type
                const retOf = (name) => {
                    const n = name.split(".").pop();
                    for (const g of go) {
                        const r = new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${n}\\s*\\([^)]*\\)\\s*\\(?\\s*\\*?([\\w.]+)`, "m").exec(g.source);
                        if (r)
                            return r[1];
                    }
                    return undefined;
                };
                const type = mm[2] ? retOf(v) :
                    new RegExp(`(?:^|[,(\\s])${v}\\s+\\*?([A-Z]\\w*|\\w+\\.[A-Z]\\w*)`).exec(fn[2])?.[1] ??
                        new RegExp(`\\b${v}\\s*:?=\\s*&?([\\w.]*[A-Z]\\w*)\\s*\\{`).exec(body)?.[1] ??
                        new RegExp(`\\bvar\\s+${v}\\s+\\*?([\\w.]*[A-Z]\\w*)`).exec(body)?.[1];
                if (!type)
                    continue;
                // a package-qualified type (dto.ClaudeRequest): the struct of that name in another package
                const tname = type.split(".").pop();
                const scope = type.includes(".") ? go : go.filter((x) => dirOf(x.rel) === dirOf(f.rel));
                for (const g of scope) {
                    const st = new RegExp(`^type\\s+${tname}\\s+struct\\s*\\{`, "m").exec(g.source);
                    if (!st)
                        continue;
                    const so = st.index + st[0].length - 1;
                    const sc = closeOf(g.source, so);
                    if (sc < 0)
                        continue;
                    for (const fl of g.source.slice(so, sc).matchAll(/^[ \t]*(\w+)\s+[^`\n]+`[^`]*json:"(\w+)[^"]*"[^`]*`/gm)) {
                        const fieldName = fl[1];
                        const key = fl[2];
                        const tagLine = lineAt(g.source, so + fl.index + fl[0].indexOf(fl[0].trim()));
                        // where the sending function sets the field (T{…, Temperature: x}, v.Temperature = x): that's the finding's
                        // line, the tag line one of its places
                        const set = new RegExp(String.raw `(?:[{,]\s*|^\s*)${fieldName}\s*:(?!=)|\.\s*${fieldName}\s*=(?!=)`, "m").exec(body);
                        const setLine = set ? lineAt(f.source, open + set.index + set[0].search(/\S/)) : undefined;
                        const marshalLine = lineAt(f.source, open + mm.index);
                        const line = setLine ?? tagLine;
                        const file = setLine ? f.rel : g.rel;
                        for (const h of hits) {
                            if (have.has(`${file}|${line}|${key}`))
                                continue;
                            have.add(`${file}|${line}|${key}`);
                            const also = setLine ? [...(g.rel === f.rel ? [tagLine] : []), marshalLine].filter((x) => x !== line) : g.rel === f.rel ? [marshalLine] : [];
                            out.push({
                                provider: h.provider.id, kind: "http", lang: "go", file, line, op: `POST ${h.path}`, params: [key], confidence: others || hits.length > 1 ? "possible" : "likely",
                                snippet: ((setLine ? f : g).source.split("\n")[line - 1] ?? "").trim().slice(0, 200),
                                reason: `${type}.${key} is ${setLine ? "set here and " : ""}marshalled as the body ${fn[1]}() sends to ${h.path} (${f.rel}:${marshalLine}; field at ${g.rel}:${tagLine})`,
                                ...(also.length ? { alsoLines: [...new Set(also)].sort((a, b) => a - b) } : {}),
                            });
                        }
                    }
                }
            }
        }
    }
    return out;
}
