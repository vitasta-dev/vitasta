/**
 * Spring configuration values (application*.properties / .yml / .yaml, bootstrap*): key → value, file and line.
 * The value tracer (src/scan/flow.ts) resolves @Value("${spring.facebook.app.version}") and
 * env.getProperty("spring.facebook.app.version") to the value written here. Only plain literal values; a placeholder
 * value (${OTHER}) is left out. Bounded.
 */
import { readFile } from "node:fs/promises";
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { textFiles } from "./envdefaults.js";
const NAME = /(?:^|\/)(?:application|bootstrap)(?:-[\w.-]+)?\.(?:properties|ya?ml)$/i;
export async function springConfigValues(root) {
    const out = new Map();
    for (const f of (await textFiles(root)).filter((x) => NAME.test(x.rel)).slice(0, 60)) {
        const text = await readFile(f.path, "utf8").catch(() => "");
        if (!text || text.length > 500_000)
            continue;
        if (/\.properties$/i.test(f.rel)) {
            text.split("\n").forEach((l, i) => {
                const m = /^\s*([\w.\-\[\]]+)\s*[=:]\s*(.*?)\s*$/.exec(l);
                if (m && !/^\s*[#!]/.test(l) && m[2] && !m[2].includes("${") && !out.has(m[1]))
                    out.set(m[1], { value: m[2], file: f.rel, line: i + 1 });
            });
            continue;
        }
        try {
            const lc = new LineCounter();
            const doc = parseDocument(text, { lineCounter: lc });
            const walk = (n, path) => {
                if (isMap(n))
                    for (const p of n.items)
                        walk(p.value, path ? `${path}.${isScalar(p.key) ? String(p.key.value) : "?"}` : isScalar(p.key) ? String(p.key.value) : "?");
                else if (isSeq(n))
                    n.items.forEach((x, i) => walk(x, `${path}[${i}]`));
                else if (isScalar(n) && typeof n.value === "string" && n.value && !n.value.includes("${") && !out.has(path))
                    out.set(path, { value: n.value, file: f.rel, line: lc.linePos(n.range[0]).line });
            };
            walk(doc.contents, "");
        }
        catch { /* not yaml */ }
    }
    return out;
}
