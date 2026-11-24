/**
 * v18: wrapper libraries and Anthropic's sampling settings (temperature, top_p, top_k; removed in API version
 * 2026-10-21). What the installed release of @langchain/anthropic, langchain-anthropic (also through
 * init_chat_model), ruby_llm or litellm does with them, from src/data/library-sampling.json (built from the feed's
 * library maps, read from each release's published package):
 *
 *   upstream break  the release sends a setting the app never sets (@langchain/anthropic 0.x sends temperature 1,
 *                   top_k -1 and top_p -1 on every request; ruby_llm up to 1.6.2 sends temperature 0.7): reported
 *                   at the place the app makes the client, and at the lockfile / manifest line that pins the
 *                   release (the fix upgrades it)
 *   dropped         the app sets one, and the release sends none of them for this model (a model id prefix it
 *                   knows, or thinking enabled where the release drops them): not a finding (removed)
 *   raises          litellm's check for models without sampling settings: a client-side error, or dropped with
 *                   drop_params=True (removed)
 *   note            the model is picked at runtime and the release drops for some models, or the release isn't
 *                   confirmed (manifest minimum whose later releases disagree): reported as a note
 * Everything else is sent as written: the finding stays a break, with the release named.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { installedVersion } from "./libdefaults.js";
const DATA = createRequire(import.meta.url)("../data/library-sampling.json");
const SETTINGS = { temperature: ["temperature"], top_p: ["top_p", "topP"], top_k: ["top_k", "topK"] };
const num = (v) => v.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
const cmp = (a, b) => {
    const x = num(a), y = num(b);
    for (let i = 0; i < 3; i++)
        if (x[i] !== y[i])
            return x[i] - y[i];
    return 0;
};
const readText = (p) => {
    try {
        return statSync(p).isFile() && statSync(p).size <= 5_000_000 ? readFileSync(p, "utf8") : undefined;
    }
    catch {
        return undefined;
    }
};
/** The range a version falls in; between two read ranges only when they agree on `same` (else undefined) */
function rangeAt(lib, v, same) {
    const rs = lib.ranges;
    const inside = rs.find((r) => cmp(r.from, v) <= 0 && cmp(v, r.to) <= 0);
    if (inside)
        return inside;
    if (!rs.length || cmp(v, rs[0].from) < 0)
        return undefined;
    if (cmp(v, rs[rs.length - 1].to) > 0)
        return rs[rs.length - 1];
    const i = rs.findIndex((r) => cmp(r.from, v) > 0);
    return same(rs[i - 1], rs[i]) ? rs[i - 1] : undefined;
}
/** From a manifest minimum: the range, if every read range from it to the end of its major agrees */
function settled(lib, v, exact, same) {
    const r = rangeAt(lib, v, same);
    if (!r || exact)
        return r;
    const later = lib.ranges.filter((x) => cmp(x.to, v) >= 0 && num(x.from)[0] === num(v)[0]);
    return later.every((x) => same(x, r)) ? r : undefined;
}
/** Blank strings' insides and comments (same length) so brackets in them don't count */
const blank = (t) => t.replace(/\/\/[^\n]*|#(?![{])[^\n]*|(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => (/^["'`]/.test(m) ? m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[m.length - 1] : " ".repeat(m.length)));
/** Each place the app makes a client or call of a listed library, with its argument span and literal model */
function usesIn(files) {
    const out = [];
    for (const lib of DATA.libraries) {
        // (a line start's indent is spaces and tabs: \s* there would run on through every following blank line, quadratic)
        const res = lib.uses.map((u) => new RegExp(u.replace(/\^\\s\*/g, "^[ \\t]*"), "gm"));
        for (const f of files) {
            if (!lib.lang.includes(f.lang) || f.source.length > 2_000_000 || !res.some((r) => (r.lastIndex = 0, r.test(f.source))))
                continue;
            const b = blank(f.source);
            const st = [0];
            for (let i = 0; i < f.source.length; i++)
                if (f.source[i] === "\n")
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
                return lo;
            };
            const seen = new Set();
            for (const r of res) {
                r.lastIndex = 0;
                for (const m of f.source.matchAll(r)) {
                    const at = m.index;
                    // in a comment or string: blanked there
                    if (seen.has(lineOf(at)) || b[at] !== f.source[at])
                        continue;
                    seen.add(lineOf(at));
                    // The argument span: from the first ( at or after the match, balanced, at most 120 lines; a Ruby call
                    // without parentheses (RubyLLM.chat) runs to the end of its statement chain
                    let open = b.indexOf("(", at);
                    if (open < 0 || lineOf(open) > lineOf(at))
                        open = -1;
                    let end = open < 0 ? f.source.indexOf("\n", at) : -1;
                    if (open >= 0) {
                        let depth = 0;
                        const limit = st[Math.min(st.length - 1, lineOf(open) + 120)] ?? b.length;
                        for (let j = open; j < Math.max(limit, open + 1) && j < b.length; j++) {
                            if (b[j] === "(")
                                depth++;
                            else if (b[j] === ")" && --depth === 0) {
                                end = j + 1;
                                break;
                            }
                        }
                    }
                    if (end < 0)
                        end = f.source.length;
                    // Java / Kotlin builders: the chain up to the statement's end (T.builder().model(…).temperature(…).build())
                    if (f.lang === "java") {
                        for (let guard = 0; guard < 200; guard++) {
                            const nx = /^\s*\.\s*[A-Za-z_]\w*\s*\(/.exec(b.slice(end, end + 400));
                            if (!nx)
                                break;
                            let depth = 0, j = end + nx[0].length - 1, close = -1;
                            for (; j < b.length && j < end + 20000; j++) {
                                if (b[j] === "(")
                                    depth++;
                                else if (b[j] === ")" && --depth === 0) {
                                    close = j + 1;
                                    break;
                                }
                            }
                            if (close < 0)
                                break;
                            end = close;
                        }
                    }
                    // Ruby: the chained calls on the same statement (RubyLLM.chat(model: …).with_temperature(0.2))
                    if (f.lang === "rb") {
                        const rest = /^(?:\s*\.\s*\w+[!?]?(?:\([^)]*\))?)*/.exec(f.source.slice(end))?.[0] ?? "";
                        end += rest.length;
                    }
                    const span = f.source.slice(at, end);
                    const mm = /\b(?:model|modelName|model_name)\s*(?::|=>|=)\s*["'`]([^"'`]+)["'`]/.exec(span) ?? /^[\w.:]+\s*\(\s*["'`]([^"'`]+)["'`]/.exec(span);
                    const model = mm?.[1].replace(/^(?:anthropic[:/])/, "");
                    out.push({ lib, file: f.rel, line: lineOf(at) + 1, endLine: lineOf(end - 1) + 1, span, model });
                }
            }
        }
    }
    return out;
}
const isAnthropic = (use) => use.lib.anthropicOnly || (!!use.model && /^claude|^anthropic/.test(use.model)) || /provider:\s*:anthropic|["']anthropic\//.test(use.span);
const setsIn = (span) => Object.keys(SETTINGS).filter((w) => SETTINGS[w].some((s) => new RegExp(`\\b${s}\\b\\s*(?::|=>|=(?!=))|with_${s}\\s*\\(`).test(span)));
const sameSends = (a, b) => JSON.stringify(a.sends) === JSON.stringify(b.sends) && JSON.stringify(a.dropsFor) === JSON.stringify(b.dropsFor) && !!a.dropsAll === !!b.dropsAll;
function versionFor(root, rel, lib, cache) {
    const dir = dirname(rel) || ".";
    const k = `${lib.package}|${dir}`;
    if (!cache.has(k)) {
        const v = installedVersion(root, dir, lib);
        let exact = !!v && !/(?:package\.json|Gemfile|requirements[\w.-]*\.txt|pyproject\.toml)$/.test(v.from);
        if (v && !exact) {
            // A manifest line that pins one release (== 1.7.5, "= 1.5.0", "1.2.0" without ^ ~ >) is exact too
            const line = (readText(join(root, v.from)) ?? "").split("\n").find((l) => l.includes(lib.package)) ?? "";
            exact = /===?\s*\d|["']\s*=\s*\d|["']\d[\d.]*["']/.test(line.slice(line.indexOf(lib.package) + lib.package.length)) && !/[~^>]|>=/.test(line.slice(line.indexOf(lib.package) + lib.package.length));
        }
        cache.set(k, v && { ...v, exact });
    }
    return cache.get(k);
}
/** What one release range does with a setting the app sets, for this use's model */
function applied(r, use, src) {
    const model = use.model;
    if (r.dropsAll)
        return { o: "dropped" };
    if (r.dropsWhenThinking && /\bthinking\b[\s\S]{0,80}enabled/.test(use.span))
        return { o: "dropped" };
    if (r.dropsFor.length && !model)
        return { o: "note", why: `drops it for models it knows reject it (${r.dropsFor.join(", ")}); breaks if another model is configured` };
    if (model && r.dropsFor.some((p) => model.startsWith(p)))
        return { o: "dropped" };
    if (r.gate) {
        const dp = use.lib.dropParams ? new RegExp(use.lib.dropParams).test(use.span) || new RegExp(`litellm\\.${use.lib.dropParams}`).test(src) : false;
        if (!model)
            return { o: "note", why: `${dp ? "drops" : "rejects (client-side)"} it for models without sampling settings; breaks if another model is configured` };
        const m = model.toLowerCase();
        const gated = r.gate.ids.some((id) => m === id || m.startsWith(`${id}-`) || m.startsWith(`${id}@`)) || r.gate.names.some((n) => m.includes(n));
        if (gated)
            return { o: dp ? "dropped" : "raises" };
    }
    return { o: "sent" };
}
/** The outcome at the installed release; from a manifest minimum, every read range from it to the end of its major must agree */
function outcomeAt(lib, inst, use, src) {
    const at = (v) => {
        const rs = lib.ranges;
        const inside = rs.find((r) => cmp(r.from, v) <= 0 && cmp(v, r.to) <= 0);
        if (inside)
            return applied(inside, use, src);
        if (!rs.length || cmp(v, rs[0].from) < 0)
            return undefined;
        if (cmp(v, rs[rs.length - 1].to) > 0)
            return applied(rs[rs.length - 1], use, src);
        const i = rs.findIndex((r) => cmp(r.from, v) > 0);
        const a = applied(rs[i - 1], use, src), b = applied(rs[i], use, src);
        return a.o === b.o ? a : undefined;
    };
    const first = at(inst.version);
    if (!first || inst.exact)
        return first;
    const later = lib.ranges.filter((x) => cmp(x.to, inst.version) >= 0 && num(x.from)[0] === num(inst.version)[0]).map((x) => applied(x, use, src).o);
    return later.every((o) => o === first.o) ? first : undefined;
}
const fileOf = (files) => new Map(files.map((f) => [f.rel, f]));
/**
 * v18, before roles: upstream breaks (settings a release sends that the app never sets), and settings the app sets
 * through a library call the other rules don't read (litellm.completion(temperature=…), chat.with_temperature(…)).
 * Not in tests.
 */
export function librarySentUsages(root, files, isTest, found = []) {
    const out = [];
    const cache = new Map();
    const pinned = new Set();
    const byRel = fileOf(files);
    for (const use of usesIn(files)) {
        if (isTest(use.file) || !isAnthropic(use))
            continue;
        const f = byRel.get(use.file);
        const lines = f.source.split("\n");
        // Settings the app sets in the call that no other rule reported
        const covered = (w) => found.some((u) => u.file === use.file && u.provider === "anthropic" && u.params?.includes(w) && u.line >= use.line && u.line <= use.endLine);
        for (const w of setsIn(use.span)) {
            if (covered(w))
                continue;
            const off = lines.slice(use.line - 1, use.endLine).findIndex((l) => SETTINGS[w].some((s) => new RegExp(`\\b${s}\\b\\s*(?::|=>|=(?!=))|with_${s}\\s*\\(`).test(l)));
            const line = use.line + Math.max(0, off);
            out.push({
                provider: "anthropic", kind: "sdk", lang: f.lang, file: use.file, line, op: "POST /v1/messages", params: [w], confidence: "likely",
                snippet: (lines[line - 1] ?? "").trim().slice(0, 200), reason: `${w} set through ${use.lib.package}${use.model ? ` for ${use.model}` : ""}`,
            });
        }
        if (!use.lib.ranges.some((r) => Object.keys(r.sends).length))
            continue;
        const inst = versionFor(root, use.file, use.lib, cache);
        if (!inst)
            continue;
        const r = settled(use.lib, inst.version, inst.exact, sameSends);
        const sent = r ? Object.keys(r.sends).filter((w) => !setsIn(use.span).includes(w)) : [];
        if (!r || !sent.length)
            continue;
        if (use.model && r.dropsFor.some((p) => use.model.startsWith(p)))
            continue;
        if (r.dropsWhenThinking && /\bthinking\b[\s\S]{0,80}enabled/.test(use.span))
            continue;
        const fixed = use.lib.ranges.find((x) => cmp(x.from, inst.version) > 0 && !Object.keys(x.sends).length);
        const rel = `${use.lib.package} ${inst.exact ? "" : "≥"}${inst.version} (${inst.from})`;
        const why = `${rel} sends ${sent.map((w) => `${w} ${r.sends[w]}`).join(", ")} on every request though the app doesn't set ${sent.length > 1 ? "them" : "it"}${fixed ? `; ${use.lib.package} ${fixed.from} and later don't` : ""}`;
        out.push({
            provider: "anthropic", kind: "sdk", lang: f.lang, file: use.file, line: use.line, op: "POST /v1/messages", params: sent,
            confidence: "likely", snippet: (lines[use.line - 1] ?? "").trim().slice(0, 200), reason: why, libSent: use.lib.package,
        });
        const manifest = inst.from.replace(/^\.\//, "");
        if (!pinned.has(`${use.lib.package}|${manifest}`)) {
            pinned.add(`${use.lib.package}|${manifest}`);
            const ml = (readText(join(root, manifest)) ?? "").split("\n");
            const row = ml.findIndex((l) => l.includes(use.lib.package));
            if (row >= 0) {
                out.push({
                    provider: "anthropic", kind: "sdk", lang: "config", file: manifest, line: row + 1, op: "POST /v1/messages", params: sent,
                    confidence: "likely", snippet: ml[row].trim().slice(0, 200), reason: why, libSent: use.lib.package,
                });
            }
        }
    }
    return out;
}
/** v18: sampling settings the app sets through a listed library, by what the installed release does with them */
export function applyLibrarySampling(root, usages, files) {
    const want = usages.filter((u) => u.provider === "anthropic" && !u.libSent && !u.aiSdk && u.params?.some((p) => p in SETTINGS));
    if (!want.length)
        return usages;
    const byFile = new Map();
    const wantFiles = new Set(want.map((u) => u.file));
    for (const use of usesIn(files.filter((f) => wantFiles.has(f.rel))))
        byFile.set(use.file, [...(byFile.get(use.file) ?? []), use]);
    const byRel = fileOf(files);
    const cache = new Map();
    const drop = new Set();
    // a traced value's own line is elsewhere (a config default): the library call it reaches is at its sink
    for (const u of want)
        if (u.sink && !wantFiles.has(u.sink.file))
            wantFiles.add(u.sink.file);
    for (const use of usesIn(files.filter((f) => wantFiles.has(f.rel) && !byFile.has(f.rel))))
        byFile.set(use.file, [...(byFile.get(use.file) ?? []), use]);
    for (const u of want) {
        const at = (byFile.get(u.file) ?? []).some((x) => x.line <= u.line && u.line <= x.endLine) ? { file: u.file, line: u.line } : u.sink ?? { file: u.file, line: u.line };
        const use = (byFile.get(at.file) ?? []).find((x) => x.line <= at.line && at.line <= x.endLine);
        if (!use || !isAnthropic(use))
            continue;
        const inst = versionFor(root, use.file, use.lib, cache);
        const rel = inst ? `${use.lib.package} ${inst.exact ? "" : "≥"}${inst.version} (${inst.from})` : `${use.lib.package} (no lockfile or manifest names it)`;
        const res = inst ? outcomeAt(use.lib, inst, use, byRel.get(use.file)?.source ?? "") ?? { o: "note", why: "whether it drops it for this model isn't confirmed" } : { o: "sent" };
        if (res.o === "dropped") {
            drop.add(u);
            continue;
        }
        if (res.o === "raises") {
            u.reason = `${u.reason ?? "sent"}; ${rel} already rejects it for ${use.model} before sending (a client-side error unless drop_params=True)`;
            continue;
        }
        if (res.o === "note") {
            if (u.role === "breaks") {
                u.role = "recorded";
                u.reason = `note: ${u.params.join(", ")} set through ${rel}, which ${res.why}`;
            }
            continue;
        }
        if (inst && u.role === "breaks")
            u.reason = `${u.reason ?? "sent"}; ${rel} sends it to the API`;
    }
    return drop.size ? usages.filter((u) => !drop.has(u)) : usages;
}
