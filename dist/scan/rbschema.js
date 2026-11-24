/**
 * Ruby: a client library's own request body built from a declared option group (EndlessInternational/intelligence's
 * Anthropic adapter). Three things in one directory (only that one: a sibling directory is another adapter's):
 *   CHAT_REQUEST_URI = "https://api.anthropic.com/v1/messages"     a provider URL, which names the operation
 *   result = options[ :chat_options ]&.compact                     a *body* method that sends an option group
 *   chat_options do                                                the group's declaration: each entry's name is
 *     temperature Float, in: 0.0..1.0                              a wire key the body sends when it's set
 *   end
 * Each declared entry is reported at its line, and the body line with all of them. Nothing here is a provider or
 * a key list: the operation comes from the URL, the keys from the declaration.
 */
import { matchUrl } from "../providers.js";
const dirOf = (rel) => rel.split("/").slice(0, -1).join("/");
export function rubySchemaBodyUsages(files, found) {
    const rb = files.filter((f) => f.lang === "rb" && f.source.length <= 2_000_000);
    const out = [];
    const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
    const lineAt = (s, at) => s.slice(0, at).split("\n").length;
    for (const f of rb) {
        // a provider URL in a constant or a method's literal; a base URL (https://api.openai.com/v1) joined in the same
        // directory with a path constant (URI.join(base_uri, CHAT_PATH), "#{base_uri}/#{CHAT_PATH}") names the operation too
        const dir0 = dirOf(f.rel);
        const consts = new Map();
        for (const g of rb.filter((x) => dirOf(x.rel) === dir0))
            for (const c of g.source.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)\s*=\s*["']([\w./-]+)["']/gm))
                consts.set(c[1], c[2]);
        const joins = [...new Set(rb.filter((x) => dirOf(x.rel) === dir0).flatMap((g) => [...g.source.matchAll(/URI\.join\(\s*[\w@:.\[\]\s]+,\s*([A-Z][A-Z0-9_]*)\s*\)|#\{[^}]*\}\/?#\{\s*([A-Z][A-Z0-9_]*)\s*\}/g)].map((j) => consts.get(j[1] ?? j[2])).filter((x) => !!x && !/^https?:/.test(x))))];
        for (const m of f.source.matchAll(/["'](https:\/\/[^"'\s#]+)["']/g)) {
            const direct = matchUrl(m[1]);
            const urls = direct && (!direct.path || direct.path === "/" || /^\/v\d+\/?$/.test(direct.path)) ? joins.map((j) => matchUrl(m[1].replace(/\/?$/, "/") + j.replace(/^\//, ""))) : [direct];
            for (const hit of urls) {
                if (!hit || !hit.path || hit.path === "/" || /^\/v\d+\/?$/.test(hit.path))
                    continue;
                const op = `POST ${hit.path}`;
                const dir = dirOf(f.rel);
                // the URL's own directory (an adapter folder): a sibling folder is another adapter's
                const near = rb.filter((g) => dirOf(g.rel) === dir);
                // the body method's option group
                for (const g of near) {
                    for (const b of g.source.matchAll(/^([ \t]*)def\s+\w*body\w*[^\n]*\n([\s\S]*?)^\1end\b/gm)) {
                        const body = b[2];
                        const grp = /\b\w+\s*=\s*(?:options|opts|@options)\s*\[\s*:(\w+)\s*\]/.exec(body);
                        if (!grp)
                            continue;
                        const bodyAt = b.index + b[0].indexOf(grp[0]);
                        // the group's declaration: `name do … end` in a file of the directory, entries one per line
                        const keys = [];
                        for (const h of near) {
                            for (const d of h.source.matchAll(new RegExp(`^(\\s*)${grp[1]}\\s+do\\s*$([\\s\\S]*?)^\\1end\\b`, "gm"))) {
                                const start = d.index + d[0].indexOf(d[2]);
                                const ind = d[1].length;
                                let depth = 0;
                                for (const e of d[2].matchAll(/^([ \t]*)([a-z_]\w*)\b(?!:)([^\n]*)$/gm)) {
                                    // only the group's own entries, not those of a nested block
                                    if (depth === 0 && e[1].length > ind)
                                        keys.push({ name: e[2], file: h.rel, line: lineAt(h.source, start + e.index) });
                                    if (/\bdo\b(\s*\|[^|]*\|)?\s*$/.test(e[3]))
                                        depth++;
                                    else if (e[2] === "end" && depth > 0)
                                        depth--;
                                }
                            }
                        }
                        if (!keys.length)
                            continue;
                        const names = [...new Set(keys.map((k) => k.name).filter((n) => n !== "end"))];
                        for (const k of keys) {
                            if (k.name === "end" || have.has(`${k.file}|${k.line}|${k.name}`))
                                continue;
                            have.add(`${k.file}|${k.line}|${k.name}`);
                            const src = rb.find((x) => x.rel === k.file).source.split("\n");
                            out.push({
                                provider: hit.provider.id, kind: "http", lang: "rb", file: k.file, line: k.line, op, params: [k.name], confidence: "likely",
                                snippet: (src[k.line - 1] ?? "").trim().slice(0, 200),
                                reason: `${k.name} is declared in ${grp[1]}, which ${g.rel}'s body method sends to ${op} (${f.rel}:${lineAt(f.source, m.index)})`,
                            });
                        }
                        const bl = lineAt(g.source, bodyAt);
                        if (!have.has(`${g.rel}|${bl}|${names[0]}`)) {
                            have.add(`${g.rel}|${bl}|${names[0]}`);
                            out.push({
                                provider: hit.provider.id, kind: "http", lang: "rb", file: g.rel, line: bl, op, params: names, confidence: "likely",
                                snippet: (g.source.split("\n")[bl - 1] ?? "").trim().slice(0, 200),
                                reason: `the request body is the ${grp[1]} option group (${names.join(", ")}), sent to ${op} (${f.rel}:${lineAt(f.source, m.index)})`,
                            });
                        }
                    }
                }
            }
        }
    }
    return out;
}
