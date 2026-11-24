/**
 * Raw HTTP with the API path in a constant and the host configured elsewhere:
 *   private static final String ASSISTANTS_PATH = "/v1/assistants";
 *   @Value("${openai.base-url:https://api.openai.com}") String baseUrl;  …  web.post().uri(ASSISTANTS_PATH)
 * In a file (or its directory) that names a provider's host, a string literal that is a versioned API path names
 * an operation of that provider. The finding is the literal's line (where a fix changes it); the request lines that
 * use the constant are its alsoLines. The method comes from those lines (post(), getForObject, HttpMethod.POST …),
 * else "*". Every language the scanner reads; data-driven by the providers' hosts.
 */
import { matchUrl } from "../providers.js";
const dirOf = (rel) => rel.split("/").slice(0, -1).join("/");
const VERBS = [
    [/\.post\s*\(|post(?:For\w+)?\s*\(|HttpMethod\.POST|["']POST["']|\bHttpPost\b|\.Post\s*\(|requests\.post|PostAsync/i, "POST"],
    [/\.delete\s*\(|HttpMethod\.DELETE|["']DELETE["']|\bHttpDelete\b|DeleteAsync/i, "DELETE"],
    [/\.get\s*\(|get(?:For\w+)?\s*\(|HttpMethod\.GET|["']GET["']|\bHttpGet\b|\.Get\s*\(|requests\.get|GetAsync|GetStringAsync/i, "GET"],
];
export function pathConstantUsages(files, found) {
    const out = [];
    // provider hosts named per directory: in URLs (https://api.openai.com, config defaults) or as bare hosts
    const hostsByDir = new Map();
    for (const f of files) {
        if (f.source.length > 2_000_000)
            continue;
        for (const m of f.source.matchAll(/https?:\/\/((?:[a-z0-9-]+\.)+[a-z]{2,})|["']((?:[a-z0-9-]+\.)+(?:com|ai|net|io))["']/gi)) {
            const h = (m[1] ?? m[2]).toLowerCase();
            if (!matchUrl(`https://${h}/`))
                continue;
            const d = dirOf(f.rel);
            if (!hostsByDir.has(d))
                hostsByDir.set(d, new Set());
            hostsByDir.get(d).add(h);
        }
    }
    const have = new Set(found.map((u) => `${u.file}|${u.line}`));
    // a package that forwards requests (a relay or proxy) rather than serving the API itself (Review of
    // test sets: a gin server's own app.POST("/v1/assistants", h) is a route it serves, not a call)
    const forwards = new Map();
    for (const f of files) {
        const d = dirOf(f.rel);
        if (!forwards.get(d) && /ReverseProxy|\b(?:proxy|relay|upstream|forward)\w*\b/i.test(f.source))
            forwards.set(d, true);
    }
    for (const f of files) {
        const hosts = hostsByDir.get(dirOf(f.rel));
        if (!hosts?.size || f.source.length > 2_000_000)
            continue;
        const relay = !!forwards.get(dirOf(f.rel));
        const lines = f.source.split("\n");
        // a constant (NAME = "/v1/…") or a field / variable holding a versioned path
        for (const m of f.source.matchAll(/\b([A-Za-z_][\w]*)\s*(?::\s*[\w<>]+\s*)?(?::=|=)\s*["'](\/v\d+(?:\/[\w{}%.$:-]+)+)\/?["']/g)) {
            const name = m[1], path = m[2].replace(/%[sd]|\{[^}]*\}|\$\{[^}]*\}|:\w+/g, "{id}");
            const line = f.source.slice(0, m.index).split("\n").length;
            if (have.has(`${f.rel}|${line}`))
                continue;
            for (const h of hosts) {
                const hit = matchUrl(`https://${h}${path}`);
                if (!hit)
                    continue;
                // the lines that use it, and the method they send with
                const use = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`);
                const uses = lines.map((l, i) => i + 1).filter((n) => n !== line && use.test(lines[n - 1]) && !/^\s*(?:\/\/|#|\*)/.test(lines[n - 1]));
                let method = "*";
                for (const n of uses) {
                    const ctx = lines.slice(Math.max(0, n - 3), n).join("\n");
                    const v = VERBS.find(([re]) => re.test(lines[n - 1])) ?? VERBS.find(([re]) => re.test(ctx));
                    if (v) {
                        method = v[1];
                        break;
                    }
                }
                have.add(`${f.rel}|${line}`);
                out.push({
                    provider: hit.provider.id, kind: "http", lang: f.lang, file: f.rel, line, op: `${method} ${hit.path}`, confidence: uses.length ? "likely" : "possible",
                    snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `${name} is the ${hit.path} path, sent to ${h}${uses.length ? ` (line${uses.length > 1 ? "s" : ""} ${uses.slice(0, 6).join(", ")})` : ""}`,
                    ...(uses.length ? { alsoLines: uses.slice(0, 20) } : {}),
                });
                break;
            }
        }
        // route groups (gin / echo / fiber / chi: v1 := r.Group("/v1"); v1.POST("/edits", h)): the group's prefix joins
        // its routes' paths
        const groups = new Map();
        for (const g of f.source.matchAll(/\b(\w+)\s*:?=\s*[\w.]+\.(?:Group|Route|Prefix)\s*\(\s*["'`](\/v\d+(?:\/[\w{}:.-]+)*)\/?["'`]/g))
            groups.set(g[1], g[2]);
        for (const [gname, prefix] of relay ? groups : new Map()) {
            for (const m of f.source.matchAll(new RegExp(`\\b${gname}\\.(GET|POST|PUT|DELETE|PATCH|Any|Handle|HandleFunc|Get|Post|Put|Delete|Patch)\\s*\\(\\s*["'\`](\\/[\\w{}:.\\/-]*)["'\`]`, "g"))) {
                const line = f.source.slice(0, m.index).split("\n").length;
                if (have.has(`${f.rel}|${line}`))
                    continue;
                const path = (prefix + m[2]).replace(/\{[^}]*\}|:\w+|\*\w*/g, "{id}").replace(/\/$/, "");
                const method = /^(GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)$/.test(m[1]) ? m[1].toUpperCase() : "*";
                for (const h of hosts) {
                    const hit = matchUrl(`https://${h}${path}`);
                    if (!hit)
                        continue;
                    have.add(`${f.rel}|${line}`);
                    out.push({
                        provider: hit.provider.id, kind: "http", lang: f.lang, file: f.rel, line, op: `${method} ${hit.path}`, confidence: "possible",
                        snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `a route for ${hit.path} (group ${prefix}), forwarded to ${h}`,
                    });
                    break;
                }
            }
        }
        // a relay or proxy route for a provider path (mux.Handle("/v1/audio/translations", h), r.POST("/v1/…"),
        // app.post("/v1/…")): the provider operation it forwards to, when the package names that provider's host
        for (const m of relay ? f.source.matchAll(/\b(?:Handle|HandleFunc|Handler|GET|POST|PUT|DELETE|PATCH|Any|Add|Route|route|get|post|put|delete|patch|all|use|Map(?:Get|Post|Put|Delete)?)\s*\(\s*["'`](\/v\d+(?:\/[\w{}:.*-]+)+)\/?["'`]/g) : []) {
            const line = f.source.slice(0, m.index).split("\n").length;
            if (have.has(`${f.rel}|${line}`))
                continue;
            const path = m[1].replace(/\{[^}]*\}|:\w+|\*\w*/g, "{id}");
            const verb = /\b(GET|POST|PUT|DELETE|PATCH)\s*\(|\.(get|post|put|delete|patch)\s*\(|Map(Get|Post|Put|Delete)\s*\(/.exec(m[0]);
            const method = (verb?.[1] ?? verb?.[2] ?? verb?.[3] ?? "*").toUpperCase();
            for (const h of hosts) {
                const hit = matchUrl(`https://${h}${path}`);
                if (!hit)
                    continue;
                have.add(`${f.rel}|${line}`);
                out.push({
                    provider: hit.provider.id, kind: "http", lang: f.lang, file: f.rel, line, op: `${method} ${hit.path}`, confidence: "possible",
                    snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `a route for ${hit.path}, forwarded to ${h}`,
                });
                break;
            }
        }
    }
    return out;
}
