/**
 * What a model rejects or does differently, so a fix that moves code to it doesn't open a broken pull request.
 * Data: <feed>/_compat.json, one entry per model family, each fact with its source and the day it was read.
 *
 *   rejects:   request settings the model returns an error for (temperature on a model that only samples at its
 *              default; a thinking budget on a model that sets thinking by effort). `values` narrows it to some
 *              values of the setting; `action` says whether dropping it is a safe fix ("remove") or a person
 *              has to choose what to send instead ("manual").
 *   behaviour: changes that don't error but can break code reading the response (thinking blocks first).
 *              `pattern` finds code that is likely affected, so the pull request can name the line.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export async function loadCompat(feedDir) {
    try {
        const data = JSON.parse(await readFile(join(feedDir, "_compat.json"), "utf8"));
        return Array.isArray(data.models) ? data.models : [];
    }
    catch {
        return [];
    }
}
export function compatFor(list, provider, model) {
    return list.find((c) => c.provider === provider && c.models.some((m) => (m.endsWith("*") ? model.startsWith(m.slice(0, -1)) : m === model)));
}
/** Settings this call passes that the model rejects. `text` is the call's file. */
export function conflictsAt(c, usage, text) {
    const out = [];
    for (const r of c.rejects) {
        if (!usage.params?.includes(r.param))
            continue;
        const span = usage.paramSpans?.[r.param];
        if (r.values?.length) {
            // Without the passed text we can't tell which value it is: say so rather than guess
            if (!span) {
                out.push({ reject: r });
                continue;
            }
            const passed = text.slice(span.start, span.end);
            if (!r.values.some((v) => passed.includes(v)))
                continue;
        }
        out.push({ reject: r, span });
    }
    return out;
}
/** Lines in the file that a behaviour change likely affects: [note, line numbers] */
export function behaviourHits(c, text) {
    const out = [];
    for (const b of c.behaviour ?? []) {
        if (!b.pattern)
            continue;
        let re;
        try {
            re = new RegExp(b.pattern, "g");
        }
        catch {
            continue;
        }
        const lines = new Set();
        for (const m of text.matchAll(re)) {
            lines.add(text.slice(0, m.index).split("\n").length);
            if (lines.size >= 10)
                break;
        }
        if (lines.size)
            out.push({ note: b.note, lines: [...lines] });
    }
    return out;
}
