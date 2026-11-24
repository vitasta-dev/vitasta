export const GATEWAYS = [
    { name: "openrouter", hosts: ["openrouter.ai"] },
    { name: "vercel-ai-gateway", hosts: ["ai-gateway.vercel.sh"] },
    { name: "requesty", hosts: ["router.requesty.ai"] },
    { name: "github-copilot", hosts: ["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com"] },
];
/** A file that lists or seeds the models an app offers (seeds, defaults, presets, model lists) */
const MODEL_LIST_FILE = /(?:^|\/)(?:seeds?|fixtures?\/(?!test)|defaults?|presets?|catalog)[\w./-]*$|(?:^|\/)[\w.-]*(?:models?|seeds?|defaults?|presets?)[\w.-]*\.(?:json|ya?ml|ts|js|rb|py|sql|toml)$/i;
const CLAUDE_ID = /["'`](?:anthropic\/)?claude-[\w.:-]+["'`]/;
const SAMPLING = new Set(["temperature", "top_p", "top_k"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&");
export function gatewayClaudeUsages(usages, text, resolveImport, files = []) {
    const out = [];
    const have = new Set(usages.filter((u) => u.provider === "anthropic").map((u) => `${u.file}|${u.line}`));
    // Claude ids the repo itself offers: in a seed, default or model-list file, or
    // written the way a gateway names them (anthropic/claude-…), outside tests and docs
    const claudeIds = usages.filter((x) => x.provider === "anthropic" && x.model && !x.inTest && !x.doc);
    const offered = claudeIds.filter((x) => MODEL_LIST_FILE.test(x.file) || /anthropic\/claude/.test(x.snippet ?? ""));
    // Raw requests to a gateway that no other rule read (fetch("https://api.githubcopilot.com/chat/completions", …)):
    // the sampling keys in the request around the URL
    const raw = [];
    for (const rel of files) {
        const src = text(rel);
        if (!src || src.length > 2_000_000 || !src.includes("chat/completions"))
            continue;
        const gw = GATEWAYS.find((g) => g.hosts.some((h) => src.includes(h)));
        if (!gw)
            continue;
        const lines = src.split("\n");
        lines.forEach((l, i) => {
            if (!gw.hosts.some((h) => l.includes(h)) || !/chat\/completions/.test(l))
                return;
            // a request another rule already read (its usage starts at or right above the URL)
            // (one read without its settings, a Go http.Post(url, …, body) with the body built above, is read again here)
            if (usages.some((x) => x.file === rel && x.op && /chat\/completions/.test(x.op) && Math.abs(x.line - (i + 1)) <= 3 && x.params?.some((p) => SAMPLING.has(p))))
                return;
            // the body around the URL: below it (fetch(url, { … })) or above it (body := …; http.Post(url, …, body))
            for (let k = Math.max(0, i - 15); k < Math.min(lines.length, i + 15); k++) {
                // (JS { temperature: … }, PHP 'temperature' => …, Python / Go "temperature": …, Go Temperature: …)
                for (const m of lines[k].matchAll(/(?<![\w$.])["']?(temperature|top_p|top_k|topP|topK|Temperature|TopP|TopK)["']?\s*(?::(?!:)|=>)/g)) {
                    const p = { topP: "top_p", topK: "top_k", Temperature: "temperature", TopP: "top_p", TopK: "top_k" }[m[1]] ?? m[1];
                    if (usages.some((x) => x.file === rel && x.line === k + 1 && x.params?.includes(p)))
                        continue;
                    const lang = /\.php$/.test(rel) ? "php" : /\.go$/.test(rel) ? "go" : /\.py$/.test(rel) ? "py" : /\.jsx?$|\.[cm]js$/.test(rel) ? "js" : "ts";
                    // a value held in a constant of this file (const defaultTemperature = 1.0): that line is where it's set
                    const v = /^\s*(\$?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\s*[,}\])\n]/.exec(`${lines[k].slice(m.index + m[0].length)}\n`)?.[1];
                    const cn = v ? v.split("::").pop().replace(/^\$/, "") : undefined;
                    const cl = cn && !/^(?:true|false|null|nil|None)$/.test(cn) ? lines.findIndex((x) => new RegExp(String.raw `^\s*(?:const\s+|(?:(?:public|private|protected)\s+)?const\s+|define\(\s*["'])${cn}\b["']?\s*(?:[\w.]+\s*)?(?:=|,)\s*-?\d`).test(x)) : -1;
                    raw.push({ provider: gw.name, kind: "http", lang, file: rel, line: k + 1, op: "POST /chat/completions", params: [p], confidence: "possible", snippet: lines[k].trim().slice(0, 200), alsoLines: [...new Set([i + 1, ...(cl >= 0 ? [cl + 1] : []), ...lines.slice(Math.max(0, i - 15), i + 15).map((x, j) => (/\bmodel\b/.test(x) ? Math.max(0, i - 15) + j + 1 : 0)).filter((n) => n && n !== k + 1)])] });
                }
            }
        });
    }
    for (const u of [...usages, ...raw]) {
        if (!u.op || !/(?:^|\s)POST\s+\S*\/chat\/completions$/.test(u.op) || u.doc || u.inTest || !u.params?.some((p) => SAMPLING.has(p)) || have.has(`${u.file}|${u.line}`))
            continue;
        const src = text(u.file);
        if (!src || src.length > 2_000_000)
            continue;
        const gw = GATEWAYS.find((g) => g.hosts.some((h) => src.includes(h)));
        if (!gw)
            continue;
        const lines = src.split("\n");
        // The model the request sends: on its line or the lines it spans (alsoLines)
        // (and the request's next lines, for a body written below its fetch(…, { … }))
        // (and, for a body array built over several lines with the setting below the model, the 6 lines above)
        const rows = [...new Set([u.line, ...(u.alsoLines ?? []), ...Array.from({ length: 12 }, (_, k) => u.line + 1 + k), ...Array.from({ length: 6 }, (_, k) => u.line - 1 - k).filter((r) => r > 0)])];
        let model;
        let literal = false;
        for (const r of rows) {
            const m = /\bmodel\s*:\s*(?:([A-Za-z_$][\w$]*)\s*[,}\n]|(["'`][^"'`\n]+["'`]))/.exec(`${lines[r - 1] ?? ""}\n`)
                // PHP 'model' => $m / Settings::DEFAULT_MODEL, Python / Go "model": m, Go Model: m
                ?? /["']model["']\s*(?:=>|:)\s*(?:(\$?[A-Za-z_]\w*(?:(?:::|->|\.)[A-Za-z_]\w*)*)\s*[,}\])\n]|(["'][^"'\n]+["']))/.exec(`${lines[r - 1] ?? ""}\n`)
                ?? /\bModel\s*:\s*(?:([A-Za-z_][\w.]*)\s*[,}\n]|(["`][^"`\n]+["`]))/.exec(`${lines[r - 1] ?? ""}\n`)
                // shorthand ({ model, messages }) sends the variable named model
                ?? /[{,]\s*(model)\s*(?=[,}])/.exec(lines[r - 1] ?? "");
            if (!m)
                continue;
            if (m[2]) {
                literal = CLAUDE_ID.test(m[2]);
                model = m[2];
            }
            else
                model = m[1];
            break;
        }
        if (!model)
            continue;
        let sign;
        if (literal)
            sign = `the model is ${model}`;
        else if (/^["'`]/.test(model))
            continue;
        // a named constant (Settings::DEFAULT_MODEL, self::MODEL, config.DefaultModel, a Go package const): its value,
        // wherever the repo defines it
        const cname = sign ? undefined : /(?:::|->|\.)([A-Za-z_]\w*)$/.exec(model)?.[1] ?? (/^[A-Za-z_]\w*$/.test(model) && /^[A-Z_]|[a-z][A-Z]/.test(model) ? model : undefined);
        if (cname) {
            const def = new RegExp(String.raw `(?:\bconst\s+(?:[\w\\]+\s+)?|\bdefine\(\s*["'])${esc(cname)}["']?\s*(?::\s*\w+)?\s*(?:=|,)\s*(${CLAUDE_ID.source})|^\s*(?:(?:public|private|protected|internal|static|final|readonly)\s+)*(?:[\w<>?]+\s+)?\$?${esc(cname)}\s*(?::\s*\w+)?\s*:?=\s*(${CLAUDE_ID.source})`, "m");
            for (const rel of [u.file, ...files]) {
                const t = text(rel);
                const d = t && t.length <= 2_000_000 && t.includes(cname) ? def.exec(t) : null;
                if (d) {
                    sign = `${model} is ${(d[1] ?? d[2]).replace(/["'`]/g, "")} (${rel}:${t.slice(0, d.index).split("\n").length})`;
                    break;
                }
            }
        }
        if (!sign) {
            const M = esc(model);
            // A prefix or name test on the model itself
            const test = new RegExp(`\\b${M}\\s*\\.\\s*(?:startsWith|includes)\\(\\s*["'\`](?:anthropic|claude)|/[^/\\n]*claude[^/\\n]*/i?\\.test\\(\\s*${M}\\s*\\)|\\b${M}\\s*===?\\s*${CLAUDE_ID.source}`);
            const t = test.exec(src);
            if (t)
                sign = `${t[0].trim().slice(0, 60)} (line ${src.slice(0, t.index).split("\n").length})`;
            // A set or list of ids it's checked against (X.has(model), X.includes(model)) that holds Claude ids
            for (const m of sign ? [] : src.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:has|includes)\\(\\s*${M}\\s*\\)`, "g"))) {
                const name = m[1];
                const local = new RegExp(`\\b(?:const|let|var)\\s+${esc(name)}\\s*(?::[^=]+)?=`).exec(src);
                let def;
                if (local)
                    def = src.slice(local.index, local.index + 4000);
                else {
                    const r = resolveImport(u.file, name);
                    const other = r ? text(r.file) : undefined;
                    if (other)
                        def = other.split("\n").slice(r.start - 1, Math.min(r.end, r.start + 400)).join("\n");
                }
                if (def && CLAUDE_ID.test(def)) {
                    sign = `${name}.has(${model}) at line ${src.slice(0, m.index).split("\n").length}, and ${name} holds Claude ids`;
                    break;
                }
            }
        }
        // the repo's own Claude ids: in this file, a model list or seed, or in gateway form
        if (!sign) {
            const o = claudeIds.find((x) => x.file === u.file) ?? offered[0];
            if (o)
                sign = `the repo offers ${o.model} (${o.file}:${o.line})`;
        }
        if (!sign)
            continue;
        have.add(`${u.file}|${u.line}`);
        out.push({
            provider: "anthropic", kind: u.kind, lang: u.lang, file: u.file, line: u.line, op: "POST /v1/messages",
            params: u.params.filter((p) => SAMPLING.has(p)), ...(u.alsoLines ? { alsoLines: u.alsoLines } : {}), via: gw.name,
            confidence: "possible", snippet: u.snippet, reason: `sent through ${gw.name} with a model that can be Claude's: ${sign}`,
        });
    }
    return out;
}
