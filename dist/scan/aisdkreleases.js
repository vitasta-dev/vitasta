/**
 * v17: what @ai-sdk/anthropic does with an AI SDK call's sampling settings (temperature, top_p, top_k) before the
 * request leaves the app. Releases with the drop logic remove them, with a warning, for models that reject them
 * (and, in later releases, for any claude- id they don't know); earlier releases send everything. Data:
 * src/data/ai-sdk-anthropic-sampling.json, a copy of the feed's data/_sdk-sampling.json, read from each release's
 * published source. The installed release comes from the nearest lockfile (or the manifest's minimum).
 *
 * Per usage (manager's ruling, 22 Nov):
 *   sent        the release sends it to the API: a break, as before
 *   dropped     the release drops it for this model: not a finding (removed)
 *   note        the model is picked at runtime on a release with the drop logic, or the release isn't confirmed
 *               (no lockfile or manifest names the package, a version between two read releases that disagree, a
 *               major not read): reported as a note, never fails a check
 * A model picked at runtime with no manifest naming @ai-sdk/anthropic isn't a finding (no Anthropic wiring).
 */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { installedVersion } from "./libdefaults.js";
const DATA = createRequire(import.meta.url)("../data/ai-sdk-anthropic-sampling.json");
const num = (v) => v.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
const cmp = (a, b) => {
    const x = num(a);
    const y = num(b);
    for (let i = 0; i < 3; i++)
        if (x[i] !== y[i])
            return x[i] - y[i];
    return 0;
};
/** What one release range does with the settings for a model (undefined: picked at runtime) */
function outcome(r, model) {
    if (!r.dropsRejected)
        return "sent";
    if (model === undefined)
        return "maybe";
    for (const rule of r.rules) {
        if (rule.includes.some((s) => model.includes(s)) || (rule.regex ?? []).some((x) => new RegExp(x).test(model)))
            return rule.rejects ? "dropped" : "sent";
    }
    return r.unknownClaudeRejects && model.includes("claude-") ? "dropped" : "sent";
}
/**
 * The outcome for a version, or "unconfirmed". `exact`: from a lockfile; otherwise a manifest's minimum, and every
 * read release from it to the end of its major must agree.
 */
export function samplingOutcome(version, exact, model) {
    const major = num(version)[0];
    const rs = DATA.ranges.filter((r) => r.major === major).sort((a, b) => cmp(a.from, b.from));
    if (!rs.length)
        return "unconfirmed";
    const at = (v) => {
        const inside = rs.find((r) => cmp(r.from, v) <= 0 && cmp(v, r.to) <= 0);
        if (inside)
            return outcome(inside, model);
        // Before the first release read: like it only if it has no drop logic yet (the logic was added, not removed)
        if (cmp(v, rs[0].from) < 0)
            return rs[0].dropsRejected ? "unconfirmed" : "sent";
        // After the last release read: like it
        if (cmp(v, rs[rs.length - 1].to) > 0)
            return outcome(rs[rs.length - 1], model);
        // Between two releases read: only if they agree
        const i = rs.findIndex((r) => cmp(r.from, v) > 0);
        const a = outcome(rs[i - 1], model);
        return a === outcome(rs[i], model) ? a : "unconfirmed";
    };
    const first = at(version);
    if (exact)
        return first;
    const later = rs.filter((r) => cmp(r.to, version) >= 0).map((r) => outcome(r, model));
    return later.every((o) => o === first) ? first : "unconfirmed";
}
/** Apply the release's behaviour to AI SDK sampling usages, in place; returns the usages to keep */
export function applyAiSdkSampling(root, usages) {
    const settings = new Set(DATA.settings);
    const cache = new Map();
    const lib = { ecosystem: "npm", package: DATA.package };
    return usages.filter((u) => {
        if (!u.aiSdk || u.provider !== "anthropic" || !u.params?.some((p) => settings.has(p)))
            return true;
        const dir = dirname(u.file) || ".";
        if (!cache.has(dir))
            cache.set(dir, installedVersion(root, dir, lib));
        const inst = cache.get(dir);
        const runtime = u.aiSdk.runtime;
        if (!inst && runtime)
            return false;
        const exact = !!inst && !/package\.json$/.test(inst.from);
        const o = inst ? samplingOutcome(inst.version, exact, u.aiSdk.model) : "unconfirmed";
        const rel = inst ? `@ai-sdk/anthropic ${exact ? "" : "≥"}${inst.version} (${inst.from})` : "@ai-sdk/anthropic (no lockfile or manifest names it)";
        const via = runtime ? `; Anthropic provider via ${runtime}` : "";
        if (o === "dropped")
            return false;
        if (o === "sent") {
            if (u.role === "breaks")
                u.reason = `${u.reason ?? "sent"}; ${rel} sends it to the API${via}`;
            return true;
        }
        if (u.role === "breaks") {
            u.role = "recorded";
            u.reason = o === "maybe"
                ? `note: ${u.params.join(", ")} sent through ${rel}, which drops it for models it knows reject it; breaks if a model it doesn't handle is configured${via}`
                : `note: ${u.params.join(", ")} sent through ${rel}; whether that release drops it for this model isn't confirmed${via}`;
        }
        return true;
    });
}
