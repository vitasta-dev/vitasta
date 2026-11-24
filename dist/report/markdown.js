import { checkedOf, dateKindOf, partlyRetired, todayOf, todayUtc, verbOf, whenOf } from "../feed/dates.js";
import { fixRoleFor, roleFor } from "../scan/roles.js";
import { code, fence, text, url } from "./escape.js";
const STATUS = {
    broken: "🔴 Broken now",
    urgent: "🟠 Due within 30 days",
    upcoming: "🟡 Upcoming",
    "on-upgrade": "🔵 Breaks when you upgrade",
};
/** The heading's status: "due within 30 days" isn't true of a date that has passed but didn't break anything */
function label(f) {
    const today = todayOf(f);
    if (f.status !== "urgent" || f.daysLeft > 0)
        return STATUS[f.status];
    if (partlyRetired(f.change, today))
        return "🟠 Some versions retired";
    const kind = dateKindOf(f.change);
    if (kind === "earliest")
        return "🟠 Can stop any day";
    if (kind === "auto-route")
        return "🟠 Now runs on another model";
    if (f.daysLeft === 0)
        return "🟠 Retires today";
    return STATUS[f.status];
}
function when(f) {
    return whenOf(f.change, todayOf(f));
}
const RANK = { certain: 0, likely: 1, possible: 2 };
/** One entry per (change, model or operation, file): recorded data can repeat the same model hundreds of times. */
export function groupFindings(findings) {
    const byKey = new Map();
    for (const f of findings) {
        const u = f.usage;
        const key = `${f.change.id}|${u.model ?? u.op ?? ""}|${u.file}|${u.listed ? "listed" : ""}`;
        const g = byKey.get(key);
        if (!g) {
            byKey.set(key, { first: f, lines: [u.line], confidence: u.confidence });
        }
        else {
            if (!g.lines.includes(u.line))
                g.lines.push(u.line);
            if (RANK[u.confidence] < RANK[g.confidence])
                g.confidence = u.confidence;
        }
    }
    for (const g of byKey.values())
        g.lines.sort((a, b) => a - b);
    return [...byKey.values()];
}
function titleOf(f, where) {
    const u = f.usage;
    return f.change.type === "model_retirement" && u.model
        ? `${code(u.model)}${where} ${verbOf(f.change, todayOf(f))}`
        : text(f.change.title);
}
/** `after` adds a line under each finding (the App uses it for a "not an issue" checkbox). */
export function renderMarkdown(map, findings, repoLabel, opts) {
    const lines = [];
    lines.push(`# Vitasta impact report: ${repoLabel}`, "");
    lines.push(`Scanned ${map.filesScanned} source files on ${todayUtc(new Date(map.scannedAt))}.`, "");
    // By role (src/scan/roles.ts): live code in detail; code people copy in detail too (the fix swaps it); tests,
    // catalogs and recorded data listed apart. Only live code fails a check
    const of = (...rs) => findings.filter((f) => rs.includes(roleFor(f.usage)));
    // two tiers. Action needed: live request sites and defaults (the only findings that can fail a
    // check). Also in your code: catalogs, dead or unused code, a provider the request site doesn't show, docs and copies
    const tierOf = (f) => f.usage.tier ?? (roleFor(f.usage) === "breaks" ? "action" : "also");
    const isNote = (f) => ["note", "test-asserts", "test-data"].includes(roleFor(f.usage));
    const groups = groupFindings(findings.filter((f) => tierOf(f) === "action" && !isNote(f)));
    const alsoFindings = findings.filter((f) => tierOf(f) === "also" && !isNote(f));
    const copyGroups = [];
    // places in test files are notes, listed apart; never a break
    const notes = findings.filter((f) => ["note", "test-asserts", "test-data"].includes(roleFor(f.usage)));
    const testAsserts = groupFindings(notes.filter((f) => fixRoleFor(f.usage) === "test-asserts"));
    const testData = groupFindings(notes.filter((f) => fixRoleFor(f.usage) !== "test-asserts"));
    const catalogGroups = [];
    const recordedGroups = [];
    const testGroups = [...testAsserts, ...testData];
    const count = (s) => groups.filter((g) => g.first.status === s);
    lines.push("| Status | Issues | Places in code |", "|---|---|---|");
    for (const s of Object.keys(STATUS)) {
        const gs = count(s);
        lines.push(`| ${STATUS[s]} | ${gs.length} | ${gs.reduce((n, g) => n + g.lines.length, 0)} |`);
    }
    lines.push("");
    const alsoFiles = new Set(alsoFindings.map((f) => f.usage.file));
    const also = [
        alsoFindings.length ? `${alsoFindings.length} ${alsoFindings.length === 1 ? "place" : "places"} in ${alsoFiles.size} ${alsoFiles.size === 1 ? "file" : "files"} also in your code` : "",
        testGroups.length ? `${testGroups.length} ${testGroups.length === 1 ? "note" : "notes"} in tests` : "",
    ].filter(Boolean);
    if (also.length)
        lines.push(`Also: ${also.join(", ")}, listed below. Only "Action needed" can fail a check.`, "");
    const detailed = (gs) => {
        for (const g of gs) {
            const f = g.first;
            const u = f.usage;
            const where = u.host ? ` on ${{ bedrock: "Amazon Bedrock", vertex: "Vertex AI", azure: "Azure" }[u.host]}` : "";
            const title = titleOf(f, where);
            lines.push(`### ${label(f)}: ${title}`);
            const shown = g.lines.slice(0, 8).join(", ");
            const more = g.lines.length > 8 ? ` and ${g.lines.length - 8} more` : "";
            const times = g.lines.length > 1 ? ` (${g.lines.length} places)` : "";
            lines.push(`- **Where:** ${code(u.file)} line${g.lines.length > 1 ? "s" : ""} ${shown}${more}${times}${u.op ? ` → ${code(u.op)}` : ""}`);
            // callers of a repo wrapper that fixes the version inside it (the same fix covers them)
            if (u.alsoAt?.length)
                lines.push(`- **Called from:** ${u.alsoAt.slice(0, 8).map((x) => code(x)).join(", ")}${u.alsoAt.length > 8 ? ` and ${u.alsoAt.length - 8} more` : ""}`);
            lines.push(`- **When:** ${when(f)}`);
            if (u.datedBy)
                lines.push(`- **Note:** this is ${u.provider === "meta-marketing" ? "a Marketing API" : `a ${u.provider}`} call, and the feed has no date for its ${u.datedBy.version} yet. Its versions end no later than ${u.datedBy.provider === "meta" ? "the Graph API" : u.datedBy.provider}'s, so this date is the latest it can stop: it may stop sooner.`);
            if (u.proxy)
                lines.push(`- **Note:** this client talks to ${code(u.proxy)}, not ${u.provider} directly. The date applies if that server forwards to ${u.provider}.`);
            if (f.change.pending)
                lines.push("- **Source:** newly announced and not yet double-checked by a person at Vitasta. Check the guide before acting.");
            if (f.change.unconfirmed)
                lines.push("- **Source:** found by comparing the provider's published API spec over time; not yet announced in a changelog. Worth checking before acting.");
            if (f.moveTo)
                lines.push(`- **Move to:** ${text(f.moveTo.text)}`);
            if (f.change.guide)
                lines.push(`- **Guide:** ${url(f.change.guide)}`);
            const checked = checkedOf(f.change);
            if (checked && f.change.sources[0])
                lines.push(`- **Checked:** ${checked}, against ${url(f.change.sources[0].url)}`);
            lines.push(`- **Confidence:** ${g.confidence}`);
            if (u.listed)
                lines.push("- **Note:** offered in a model list, picker or type, not called here. It breaks for whoever picks it.");
            lines.push("", fence(u.snippet), "");
            const extra = opts?.after?.(f);
            if (extra)
                lines.push(extra, "");
        }
    };
    /** One line per place: tests, catalogs, recorded data */
    const brief = (gs) => {
        for (const g of gs) {
            const f = g.first;
            const shown = g.lines.slice(0, 5).join(", ") + (g.lines.length > 5 ? ` and ${g.lines.length - 5} more` : "");
            lines.push(`- ${STATUS[f.status]}: ${titleOf(f, "")} in ${code(f.usage.file)} line${g.lines.length > 1 ? "s" : ""} ${shown}${f.usage.reason ? ` (${text(f.usage.reason)})` : ""}`);
        }
    };
    if (groups.length) {
        lines.push("## Action needed", "");
        detailed(groups);
    }
    else {
        lines.push(also.length ? "Nothing needs action in live code." : "No known upcoming breaking changes affect this repo.", "");
    }
    if (alsoFindings.length) {
        const ctxName = { catalog: "catalogs and model lists", dead: "code nothing reaches", unused: "set but not read", "provider-unresolved": "provider not shown at the request", docs: "docs and examples", other: "other" };
        const ctxOf = (f) => f.usage.context ?? (roleFor(f.usage) === "users-copy" ? "docs" : roleFor(f.usage) === "catalog" ? "catalog" : "other");
        const byCtx = new Map();
        for (const f of alsoFindings)
            byCtx.set(ctxOf(f), (byCtx.get(ctxOf(f)) ?? 0) + 1);
        const summary = [...byCtx].map(([k, n]) => `${ctxName[k] ?? k} ${n}`).join(", ");
        lines.push(`<details><summary>Also in your code (${alsoFindings.length} in ${alsoFiles.size} ${alsoFiles.size === 1 ? "file" : "files"}: ${summary})</summary>`, "");
        lines.push("", "The retired thing is here too, but not at a live request or default: update it when you can. These never fail a check.", "");
        const byFile = new Map();
        for (const f of alsoFindings)
            byFile.set(f.usage.file, [...(byFile.get(f.usage.file) ?? []), f]);
        for (const [file, fs] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
            lines.push(`**${code(file)}**`, "");
            // a large catalog's entries: one line listing the retired ids
            const grouped = fs.filter((f) => f.usage.grouped);
            if (grouped.length) {
                const g0 = grouped[0];
                const ls = [...new Set(grouped.map((f) => f.usage.line))].sort((a, b) => a - b);
                const ids = g0.usage.grouped.ids;
                lines.push(`- ${STATUS[grouped.reduce((w, f) => (["broken", "urgent", "upcoming", "on-upgrade"].indexOf(f.status) < ["broken", "urgent", "upcoming", "on-upgrade"].indexOf(w) ? f.status : w), g0.status)]}: ${g0.usage.grouped.count} entries: ${ids.slice(0, 12).map((x) => code(x)).join(", ")}${ids.length > 12 ? ", …" : ""}, lines ${ls.slice(0, 5).join(", ")}${ls.length > 5 ? ` and ${ls.length - 5} more` : ""} (${ctxName.catalog})`);
            }
            for (const g of groupFindings(fs.filter((f) => !f.usage.grouped))) {
                const f = g.first;
                const shown = g.lines.slice(0, 5).join(", ") + (g.lines.length > 5 ? ` and ${g.lines.length - 5} more` : "");
                lines.push(`- ${STATUS[f.status]}: ${titleOf(f, "")}, line${g.lines.length > 1 ? "s" : ""} ${shown} (${ctxName[ctxOf(f)] ?? ctxOf(f)}${f.usage.contextReason ? `: ${text(f.usage.contextReason)}` : ""})`);
            }
            lines.push("");
        }
        lines.push("</details>", "");
    }
    if (copyGroups.length) {
        lines.push("## In examples and docs", "", "Code people copy: a complete fix updates these too.", "");
        detailed(copyGroups);
    }
    if (testGroups.length) {
        lines.push(`<details><summary>Also in tests: notes (${testGroups.length})</summary>`, "", "Notes only: places in test files never fail a check and aren't counted above.", "");
        if (testAsserts.length) {
            lines.push("", "Tests that set or check the old model: a fix updates them in the same pull request, so your CI keeps passing.", "");
            brief(testAsserts);
        }
        if (testData.length) {
            lines.push("", "Tests that only store, display or look the model up: cleanup, not changed automatically.", "");
            brief(testData);
        }
        lines.push("", "</details>", "");
    }
    if (catalogGroups.length) {
        lines.push(`<details><summary>In model lists, catalogs and price tables (${catalogGroups.length})</summary>`, "");
        lines.push("", "Never renamed: the new model has its own prices and limits. Retire or remove the old entry, and add the new model where it belongs.", "");
        brief(catalogGroups);
        lines.push("", "</details>", "");
    }
    if (recordedGroups.length) {
        lines.push(`<details><summary>In recorded data (${recordedGroups.length})</summary>`, "");
        lines.push("", "Telemetry, recorded responses and seed data describe calls that already happened. For information; never changed.", "");
        brief(recordedGroups);
        lines.push("", "</details>", "");
    }
    if (findings.some((f) => f.usage.host === "azure")) {
        lines.push("> **Azure note:** on Azure the `model` value is your deployment's name. Azure findings assume the deployment is named after the model it runs; check the model behind each deployment in the Azure portal.", "");
    }
    const geminiUnknown = map.usages.filter((u) => u.provider === "google" && u.model && !u.host);
    if (geminiUnknown.length && map.usages.some((u) => u.provider === "google" && u.host === "vertex")) {
        lines.push(`> **Check:** this repo uses both Vertex AI and the Gemini API. ${geminiUnknown.length} Gemini model references were checked against the Gemini API schedule; if they run on Vertex, Vertex's dates apply instead.`, "");
    }
    lines.push("## API map", "");
    if (map.sdks.length) {
        lines.push("SDKs in manifests:", "");
        for (const s of map.sdks)
            lines.push(`- ${s.provider}: ${code(s.name)}${s.version ? ` ${code(s.version)}` : ""} (${code(s.manifest)})`);
        lines.push("");
    }
    const counts = new Map();
    for (const u of map.usages)
        counts.set(`${u.provider} ${u.kind}`, (counts.get(`${u.provider} ${u.kind}`) ?? 0) + 1);
    lines.push("| Provider / kind | Count |", "|---|---|");
    for (const [k, v] of [...counts].sort())
        lines.push(`| ${k} | ${v} |`);
    lines.push("");
    return lines.join("\n");
}
