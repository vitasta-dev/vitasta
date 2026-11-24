import { statusOf } from "./dates.js";
import { resolveReplacement } from "./replacement.js";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_POLICY } from "../config.js";
import { normalizeModel, providerById } from "../providers.js";
/**
 * A local change feed, if there is one: --feed / $VITASTA_FEED, else a snapshot bundled with the package
 * (dist/feed-data), else the sibling feed repo when running from source during development. Undefined means
 * "ask the lookup service" (see lookup.ts). A published install never picks up a folder from the user's project.
 */
export function defaultFeedDir() {
    if (process.env.VITASTA_FEED)
        return process.env.VITASTA_FEED;
    const bundled = resolve(import.meta.dirname, "../feed-data");
    if (existsSync(join(bundled, "openai.json")))
        return bundled;
    const dev = resolve(import.meta.dirname, "../../../feed/data");
    if (/[\\/]src[\\/]feed$/.test(import.meta.dirname) && existsSync(join(dev, "openai.json")))
        return dev;
    return undefined;
}
/** Load every *.json change file in a feed directory (each file holds an array of records). */
export async function loadFeed(dir) {
    const out = [];
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("_")).sort()) {
        const records = JSON.parse(await readFile(join(dir, name), "utf8"));
        out.push(...records);
    }
    return out;
}
/** Azure's model catalog names aren't case-sensitive ("DeepSeek-R1" and "deepseek-r1" are one model) */
function matchModel(patterns, model, anyCase = false) {
    const f = (x) => (anyCase ? x.toLowerCase() : x);
    return patterns.some((p) => (p.endsWith("*") ? f(model).startsWith(f(p.slice(0, -1))) : f(model) === f(p)));
}
/**
 * "* /v1/threads" matches /v1/threads and everything under it. A path parameter in the pattern matches any segment,
 * so the spec's /repos/{owner}/{repo} matches code calling /repos/{id}/{id} or /repos/acme/app. A segment the code
 * builds at runtime ({id}) only matches a parameter, never a fixed name: `/repos/${repo}/${path}` can't be said to
 * call /repos/{owner}/{repo}/import.
 */
/**
 * Microsoft Graph's drive has several spellings of one resource: /me/drive, /users/{id}/drive, /groups/{id}/drive and
 * /sites/{id}/drive are each the user's, group's or site's default drive, and /drives/{drive-id} names it by id. A
 * function's call parentheses (recent()) are the same segment as without. Both sides are read the canonical way, so a
 * record on /drives/{drive-id}/recent() matches code calling /me/drive/recent.
 */
function canonGraph(path) {
    if (!/^\/(?:v1\.0|beta)\//.test(path))
        return path;
    return path
        .replace(/\(\)(?=\/|$)/g, "")
        .replace(/^(\/(?:v1\.0|beta))\/(?:me|(?:users|groups|sites)\/[^/]+)\/drive(?=\/|$)/, "$1/drives/{id}");
}
function matchOp(patterns, op) {
    const [method, rawPath] = op.split(" ");
    const path = rawPath && canonGraph(rawPath);
    if (!path)
        return false; // malformed (e.g. a custom sdkOps value without a method): matches nothing
    const segs = path.split("/");
    const param = (s) => /^\{.*\}$/.test(s);
    return patterns.some((p) => {
        const [pm, rawPp] = p.split(" ");
        if (!rawPp)
            return false;
        const pp = canonGraph(rawPp);
        if (pm !== "*" && method !== "*" && pm !== method)
            return false;
        const ps = pp.split("/");
        // the pattern must match the whole path when it has parameters (an exact operation), or a prefix otherwise
        const exact = ps.some(param) || pm !== "*";
        if (exact ? segs.length !== ps.length : segs.length < ps.length)
            return false;
        // "{}" is a segment the lookup client masked (the service answers with a superset), so it matches anything
        return ps.every((s, i) => s === segs[i] || param(s) || segs[i] === "{}");
    });
}
/** "2025-07" from "url: 2025-07", "apiVersion: 2025-07" or "anthropic-version: 2023-06-01" */
function matchHeader(patterns, pin) {
    const h = pin?.toLowerCase().replace(/\s+/g, " ").trim();
    if (!h || !/^[a-z0-9-]+: /.test(h))
        return false;
    return patterns.some((p) => (p.endsWith("*") ? h.startsWith(p.slice(0, -1)) : h === p));
}
function versionOf(u) {
    return u.apiVersion?.split(": ").pop()?.trim();
}
/** Does this change apply to this usage? Every selector field that is set must match. */
export function matches(change, u) {
    if (change.provider !== u.provider)
        return false;
    const s = change.selector;
    // A header that means "uses this API" (OpenAI-Beta: assistants=v2) matches the record wherever it's sent
    if (u.kind === "version-pin" && s.headers && change.type !== "version_sunset") {
        // a request whose URL was traced to operations the record doesn't cover isn't that API's call (
        // the header on a /v1/files or /v1/models request isn't an Assistants call)
        // (a path traced without its base keeps no /vN: compared with the version segment taken off both sides)
        const unver = (x) => x.replace(/ \/v\d+(?=\/)/, " ");
        if (u.requestOps?.length && s.ops && !u.requestOps.some((op) => matchOp(s.ops, op) || matchOp(s.ops.map(unver), unver(op))))
            return false;
        if (u.headerOnly && s.ops?.length)
            return false;
        return matchHeader(s.headers, u.apiVersion);
    }
    // API version cut-offs match any usage that pins that version (a header, an SDK option or the URL)
    if (change.type === "version_sunset") {
        const v = versionOf(u);
        return !!v && !!s.versions?.includes(v);
    }
    if (s.models) {
        if (!u.model || !matchModel(s.models, normalizeModel(u.model), !!s.hosts?.includes("azure") && u.host === "azure"))
            return false;
    }
    if (s.ops) {
        if (!u.op || !matchOp(s.ops, u.op))
            return false;
    }
    if (s.sdkCalls) {
        if (!u.sdkCall || !s.sdkCalls.some((c) => u.sdkCall === c || u.sdkCall.startsWith(c + ".")))
            return false;
    }
    if (s.params) {
        if (!u.params || !s.params.some((p) => u.params.includes(p)))
            return false;
    }
    // A model-ref only proves the model string exists, so it can only match model selectors
    if (u.kind === "model-ref" && (s.ops || s.params || s.sdkCalls))
        return false;
    if (u.kind === "version-pin")
        return false;
    // Azure / Bedrock / Vertex retire models on their own schedules: a hosted model only matches that host's
    // records, and a model on the provider's own API only matches the provider's records.
    if (change.type === "model_retirement" || change.type === "model_deprecation") {
        if (u.via)
            return false;
        if (s.hosts ? !u.host || !s.hosts.includes(u.host) : !!u.host)
            return false;
    }
    else if (s.hosts && (!u.host || !s.hosts.includes(u.host))) {
        return false;
    }
    return true;
}
export function daysBetween(fromISO, toISO) {
    const ms = Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z");
    return Math.round(ms / 86_400_000);
}
export function findImpacts(map, feedIn, today) {
    const findings = [];
    const seen = new Set();
    const policy = map.config?.policy ?? DEFAULT_POLICY;
    // The repo's own change records (internal APIs) count like feed records; accepted ones are skipped
    const feed = [...feedIn, ...(map.config?.changes ?? [])].filter((c) => !policy.accept.includes(c.id));
    for (const change of feed) {
        for (const u of map.usages) {
            if (u.traceOnly || !matches(change, u))
                continue;
            if (!policy.includeTests && u.inTest)
                continue;
            if (u.model && policy.ignoreModels.includes(normalizeModel(u.model)))
                continue;
            // one finding per change, place and model (a call and a loose string on the same line are the same thing)
            const key = `${change.id}|${u.file}|${u.line}|${u.model ? normalizeModel(u.model) : u.op ?? u.apiVersion ?? ""}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            // Past an "earliest" date it can stop any day; past an auto-route date it works on another model; some versions
            // gone and others not means "check your version", not broken (src/feed/dates.ts)
            const { status, daysLeft } = statusOf(change, today, policy.urgentDays);
            const moveTo = resolveReplacement(change, feed, today);
            findings.push({ change, usage: u, daysLeft, status, ...(moveTo ? { moveTo } : {}) });
        }
    }
    // A version of a provider whose versions never outlive another's (Meta Marketing → Graph), with no sunset record of
    // its own: the other provider's record for the same version is the latest it can end
    const sunsetFor = new Set(findings.filter((f) => f.change.type === "version_sunset").map((f) => `${f.usage.file}|${f.usage.line}`));
    for (const u of map.usages) {
        const fb = providerById(u.provider)?.versionFallback;
        const v = fb ? versionOf(u) : undefined;
        if (!fb || !v || u.traceOnly || sunsetFor.has(`${u.file}|${u.line}`) || (!policy.includeTests && u.inTest))
            continue;
        if (feed.some((c) => c.type === "version_sunset" && c.provider === u.provider && c.selector.versions?.includes(v)))
            continue;
        const change = feed.find((c) => c.type === "version_sunset" && c.provider === fb && c.selector.versions?.includes(v));
        if (!change)
            continue;
        sunsetFor.add(`${u.file}|${u.line}`);
        const { status, daysLeft } = statusOf(change, today, policy.urgentDays);
        const note = `no ${u.provider} record for ${v}: ${u.provider} versions end no later than ${fb}'s, so this is the latest date (${change.effective}), and ${u.provider} ${v} may stop sooner`;
        findings.push({ change, usage: { ...u, reason: u.reason ? `${u.reason}; ${note}` : note, datedBy: { provider: fb, version: v } }, daysLeft, status });
    }
    // One finding per endpoint class: a call of Class.Method, where the repo defines Class itself and
    // Class's file already has a finding for the same change, is that class's own break (a library wrapping its own
    // endpoint), not another one
    const byChangeFile = new Set(findings.map((f) => `${f.change.id}|${f.usage.file.split("/").pop().replace(/\.\w+$/, "")}`));
    const kept = findings.filter((f) => {
        const cls = /^([A-Z]\w*)\.\w+$/.exec(f.usage.sdkCall ?? "")?.[1] ?? /\b([A-Z]\w*(?:Endpoint|Client|Service|Api|API))\.\w+Async\b/.exec(f.usage.reason ?? "")?.[1];
        if (!cls || f.usage.file.split("/").pop().replace(/\.\w+$/, "") === cls)
            return true;
        return !byChangeFile.has(`${f.change.id}|${cls}`);
    });
    // An SDK endpoint class whose path property's line already has a finding for a change: its URL calls with the
    // same change are that finding's other lines, not findings of their own
    const roots = new Map();
    for (const f of kept)
        if (f.usage.endpointRoot)
            roots.set(`${f.change.id}|${f.usage.file}|${f.usage.endpointRoot}`, f);
    const folded = kept.filter((f) => {
        const r = f.usage.endpointCall ? roots.get(`${f.change.id}|${f.usage.file}|${f.usage.endpointCall}`) : undefined;
        if (!r)
            return true;
        r.usage.alsoLines = [...new Set([...(r.usage.alsoLines ?? []), f.usage.line])].sort((a, b) => a - b);
        return false;
    });
    // Callers of a repo's wrapper that fixes a version inside it: the wrapper's
    // finding for the same change covers them; they're its other places, not findings of their own
    const at = new Map();
    for (const f of folded)
        if (!f.usage.wrapperOrigin)
            at.set(`${f.change.id}|${f.usage.file}:${f.usage.line}`, f);
    const unwrapped = folded.filter((f) => {
        const o = f.usage.wrapperOrigin ? at.get(`${f.change.id}|${f.usage.wrapperOrigin}`) : undefined;
        if (!o)
            return true;
        if (f.usage.file === o.usage.file)
            o.usage.alsoLines = [...new Set([...(o.usage.alsoLines ?? []), f.usage.line])].sort((a, b) => a - b);
        else
            o.usage.alsoAt = [...new Set([...(o.usage.alsoAt ?? []), `${f.usage.file}:${f.usage.line}`])];
        return false;
    });
    // A request line that uses a name defined on another finding's line, same change and file (const GRAPH_BASE =
    // "https://graph.facebook.com/v12.0" … fetch(`${GRAPH_BASE}/me`)): the defining line is the finding, the request
    // line one of its alsoLines
    const declName = (snip) => /^(?:(?:export|const|let|var|val|final|static|private|public|protected|readonly|internal)\s+)*(?:[\w<>\[\]?]+\s+)?([A-Za-z_$][\w$]{2,})\s*(?::[^=]*)?=(?![=>])/.exec(snip.trim())?.[1];
    const byGroup = new Map();
    for (const f of unwrapped)
        byGroup.set(`${f.change.id}|${f.usage.file}`, [...(byGroup.get(`${f.change.id}|${f.usage.file}`) ?? []), f]);
    const usedBy = new Set();
    for (const g of byGroup.values()) {
        if (g.length < 2)
            continue;
        for (const d of g) {
            const ns = d.usage.declares ?? (d.usage.snippet && declName(d.usage.snippet) ? [declName(d.usage.snippet)] : []);
            if (!ns.length)
                continue;
            const re = new RegExp(`(?<![\\w$.])(?:${ns.map((n) => n.replace(/\$/g, "\\$")).join("|")})(?![\\w$])`);
            for (const r of g) {
                if (r === d || usedBy.has(d) || usedBy.has(r) || !r.usage.snippet || ns.includes(declName(r.usage.snippet) ?? "") || !re.test(r.usage.snippet))
                    continue;
                if (r.usage.kind !== "http" && r.usage.kind !== "sdk" && r.usage.kind !== "version-pin")
                    continue;
                d.usage.alsoLines = [...new Set([...(d.usage.alsoLines ?? []), r.usage.line, ...(r.usage.alsoLines ?? [])])].filter((l) => l !== d.usage.line).sort((a, b) => a - b);
                usedBy.add(r);
            }
        }
    }
    // Findings of the same change, file and settings a few lines apart (more calls of one SDK in the same function, a
    // default and the call that passes it): one finding, the others its alsoLines
    const rest = unwrapped.filter((f) => !usedBy.has(f));
    const near = new Set();
    const groups = new Map();
    for (const f of rest) {
        // (an endpoint-wide change with no settings: its request and header lines in one place, e.g. a URL and the
        // OpenAI-Beta header two lines below it)
        const k = f.usage.params?.length && (f.usage.kind === "sdk" || f.usage.kind === "http")
            ? `${f.change.id}|${f.usage.file}|${[...f.usage.params].sort().join(",")}`
            : !f.usage.params?.length && !f.usage.model && f.change.type !== "model_retirement" && f.change.type !== "version_sunset" ? `${f.change.id}|${f.usage.file}|-` : undefined;
        if (!k)
            continue;
        groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    for (const g of groups.values()) {
        if (g.length < 2)
            continue;
        g.sort((a, b) => a.usage.line - b.usage.line);
        let anchor = g[0];
        for (const f of g.slice(1)) {
            const last = Math.max(anchor.usage.line, ...(anchor.usage.alsoLines ?? []).filter((l) => l <= f.usage.line));
            if (f.usage.line - last <= 5) {
                anchor.usage.alsoLines = [...new Set([...(anchor.usage.alsoLines ?? []), f.usage.line, ...(f.usage.alsoLines ?? [])])].filter((l) => l !== anchor.usage.line).sort((a, b) => a - b);
                near.add(f);
            }
            else
                anchor = f;
        }
    }
    findings.length = 0;
    findings.push(...rest.filter((f) => !near.has(f)));
    // A large catalog (a generated model list, a table of hundreds of ids): shown as one entry per file in the reports,
    // listing the retired ids. Every finding stays (each keeps its own change record, for the App's
    // fixes and the JSON); each member carries the group, and the renderers collapse it
    const CATALOG_GROUP = 10;
    const perCatalog = new Map();
    for (const f of findings)
        if (f.usage.context === "catalog")
            perCatalog.set(f.usage.file, [...(perCatalog.get(f.usage.file) ?? []), f]);
    for (const [, group] of perCatalog) {
        if (group.length <= CATALOG_GROUP)
            continue;
        const ids = [...new Set([...group].sort((a, b) => a.daysLeft - b.daysLeft || a.usage.line - b.usage.line).map((g) => g.usage.model ?? g.usage.op ?? g.usage.apiVersion ?? "").filter(Boolean))];
        for (const g of group)
            g.usage = { ...g.usage, grouped: { count: group.length, ids } };
    }
    const rank = { broken: 0, urgent: 1, upcoming: 2, "on-upgrade": 3 };
    return findings.sort((a, b) => rank[a.status] - rank[b.status] ||
        Number(!!a.usage.inTest) - Number(!!b.usage.inTest) ||
        Number(!!a.usage.listed) - Number(!!b.usage.listed) ||
        a.daysLeft - b.daysLeft ||
        a.usage.file.localeCompare(b.usage.file) ||
        a.usage.line - b.usage.line);
}
