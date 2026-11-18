import { daysFrom } from "./dates.js";
/** A plain model ID (no spaces, not prose like "Responses API") */
const plainId = (s) => {
    const t = s?.trim().replace(/`/g, "");
    return t && /^[\w.:@/+-]{1,200}$/.test(t) ? t : undefined;
};
const MODEL_TYPES = new Set(["model_retirement", "model_deprecation"]);
const samePlatform = (a, b) => a.provider === b.provider && JSON.stringify(a.selector.hosts ?? []) === JSON.stringify(b.selector.hosts ?? []);
const covers = (r, model) => (r.selector.models ?? []).some((m) => (m.endsWith("*") ? model.startsWith(m.slice(0, -1)) : m === model));
export function resolveReplacement(change, feed, today, horizonDays = 90) {
    const named = change.replacement?.trim();
    if (!named)
        return undefined;
    const first = plainId(named);
    if (!first)
        return { named, skipped: [], text: named }; // prose: shown as the provider wrote it
    const skipped = [];
    const seen = new Set();
    let cur = first;
    let good;
    while (cur && !seen.has(cur) && skipped.length < 6) {
        seen.add(cur);
        const model = cur;
        const rec = feed
            .filter((r) => MODEL_TYPES.has(r.type) && r.trigger === "date" && samePlatform(r, change) && covers(r, model))
            .sort((a, b) => a.effective.localeCompare(b.effective))[0];
        if (!rec || daysFrom(today, rec.effective) > horizonDays) {
            good = model; // not retired, and not retiring soon
            break;
        }
        skipped.push({ model, effective: rec.effective, retired: rec.effective <= today && !rec.earliest });
        cur = plainId(rec.replacement);
    }
    if (!skipped.length)
        return { model: first, named, skipped, text: first };
    const why = skipped.map((s, i) => `${i ? "its replacement " : ""}${s.model}, ${s.retired ? `retired since ${s.effective}` : `itself retiring on ${s.effective}`}`).join("; then ");
    if (good)
        return { model: good, named, skipped, text: `${good} (the provider names ${why})` };
    return { named, skipped, text: `no replacement that isn't itself retiring yet: the provider names ${why}, and nothing after it is announced` };
}
