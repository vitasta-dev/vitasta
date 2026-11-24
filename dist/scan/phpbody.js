/** The end of the balanced [ ( { span from `open` (strings skipped), or -1 */
function closeOf(s, open) {
    let d = 0;
    for (let i = open; i < Math.min(s.length, open + 60_000); i++) {
        const c = s[i];
        if (c === "'" || c === '"') {
            for (i++; i < s.length && s[i] !== c; i++)
                if (s[i] === "\\")
                    i++;
            continue;
        }
        if (c === "[" || c === "(" || c === "{")
            d++;
        else if ((c === "]" || c === ")" || c === "}") && --d === 0)
            return i;
    }
    return -1;
}
export function phpPostedArrayUsages(files, found) {
    const out = [];
    const posts = found.filter((u) => u.lang === "php" && u.kind === "http" && /^POST /.test(u.op ?? "") && !u.params?.length);
    if (!posts.length)
        return out;
    const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${u.op}|${p}`)));
    const byFile = new Map(files.filter((f) => f.lang === "php" && f.source.length <= 2_000_000).map((f) => [f.rel, f.source]));
    for (const u of posts) {
        const src = byFile.get(u.file);
        if (!src)
            continue;
        const st = [0];
        for (let i = 0; i < src.length; i++)
            if (src[i] === "\n")
                st.push(i + 1);
        const lineOf = (at) => {
            let lo = 0, hi = st.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (st[mid] <= at)
                    lo = mid;
                else
                    hi = mid - 1;
            }
            return lo + 1;
        };
        const at = st[u.line - 1];
        if (at === undefined)
            continue;
        // the enclosing function: the nearest `function …(…) {` above whose body reaches the line
        let fo = -1, fc = -1;
        const from = Math.max(0, at - 20_000);
        for (const m of src.slice(from, at).matchAll(/\bfunction\s+&?\w*\s*\([^)]*\)[^{;]*\{/g)) {
            const o = from + m.index + m[0].length - 1;
            const c = closeOf(src, o);
            if (c > at) {
                fo = o;
                fc = c;
            }
        }
        if (fo < 0)
            continue;
        const body = src.slice(fo, fc);
        const spans = [];
        const POSTED = /(?:CURLOPT_POSTFIELDS\s*,|["'](?:body|json|form_params)["']\s*=>)\s*(?:(?:http_build_query|json_encode|wp_json_encode)\s*\(\s*)?(?:\$(\w+)|(\[|array\s*\())/g;
        for (const m of body.matchAll(POSTED)) {
            if (m[2]) {
                const o = fo + m.index + m[0].length - 1;
                const c = closeOf(src, o);
                if (c > 0)
                    spans.push([o, c, "posted inline"]);
                continue;
            }
            const v = m[1];
            const useAt = fo + m.index;
            for (const d of body.matchAll(new RegExp(`\\$${v}\\s*=\\s*(\\[|array\\s*\\()`, "g"))) {
                const o = fo + d.index + d[0].length - 1;
                if (o > useAt)
                    continue;
                const c = closeOf(src, o);
                if (c > 0)
                    spans.push([o, c, `$${v}`]);
            }
            for (const d of body.matchAll(new RegExp(`\\$${v}\\s*\\[\\s*["'](\\w+)["']\\s*\\]\\s*=(?!=)`, "g"))) {
                const o = fo + d.index;
                if (o < useAt)
                    spans.push([o, o + d[0].length, `$${v}[…]`]);
            }
        }
        for (const [o, c, why] of spans) {
            const seg = src.slice(o, c + 1);
            // the literal's own keys (depth 1), or an index assignment's key
            const keys = [];
            if (seg.startsWith("$")) {
                const k = /\[\s*["'](\w+)["']/.exec(seg);
                if (k)
                    keys.push([k[1], o]);
            }
            else {
                let d = 0;
                for (let i = 0; i < seg.length; i++) {
                    const ch = seg[i];
                    if (ch === "'" || ch === '"') {
                        let j = i + 1;
                        for (; j < seg.length && seg[j] !== ch; j++)
                            if (seg[j] === "\\")
                                j++;
                        if (d === 1 && /^\s*=>/.test(seg.slice(j + 1, j + 8)) && /^\w+$/.test(seg.slice(i + 1, j)))
                            keys.push([seg.slice(i + 1, j), o + i]);
                        i = j;
                        continue;
                    }
                    if (ch === "[" || ch === "(" || ch === "{")
                        d++;
                    else if (ch === "]" || ch === ")" || ch === "}")
                        d--;
                }
            }
            for (const [k, kat] of keys) {
                const line = lineOf(kat);
                if (have.has(`${u.file}|${line}|${u.op}|${k}`))
                    continue;
                have.add(`${u.file}|${line}|${u.op}|${k}`);
                out.push({
                    provider: u.provider, kind: "http", lang: "php", file: u.file, line, op: u.op, params: [k], confidence: "likely",
                    snippet: (src.split("\n")[line - 1] ?? "").trim().slice(0, 200), alsoLines: [u.line],
                    reason: `${k} is in the body (${why}) posted to ${u.op} at line ${u.line}`,
                });
            }
        }
    }
    return out;
}
