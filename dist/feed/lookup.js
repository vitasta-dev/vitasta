import { readFileSync } from "node:fs";
/**
 * Where change records come from: a local feed folder, or the Vitasta lookup service.
 *
 * The lookup service gets as little as possible, and the client does the exact matching itself:
 * - only built-in providers (a repo's own providers and changes from .vitasta.yml never leave the machine);
 * - a model ID only if it has the shape of a public model ID of a built-in provider (fine-tuned IDs are reduced to
 *   their base model; Bedrock ARNs lose the account); Azure deployment names and the like are not sent;
 * - an HTTP operation as its method and an API version prefix only: every other path segment becomes "{}", so
 *   owner/repo names, account IDs and internal paths are never sent;
 * - no SDK call names and no parameter names;
 * - a pinned API version only if it looks like one.
 * The service answers with every record that could apply (a superset); the scanner then matches them against the
 * full usages locally. Never sent: code, snippets, file names, line numbers, the repo name, .vitasta.yml.
 */
import { daysBetween, findImpacts, loadFeed, matches } from "./match.js";
import { createRequire } from "node:module";
import { azureFamily, bedrockModel, normalizeModel, PROVIDERS } from "../providers.js";
import { redactSecrets } from "../redact.js";
export const LOOKUP_URL = process.env.VITASTA_API ?? "https://app.vitasta.dev/v1/lookup";
// Captured at load, before any repo's .vitasta.yml can register providers of its own
const BUILT_IN = new Map(PROVIDERS.map((p) => [p.id, p]));
const MODEL_WORDS = new Set(createRequire(import.meta.url)("../data/model-words.json").words);
/**
 * Every word in the ID (a run of three or more letters) is one public model IDs use: a name made up by a
 * customer (a deployment called gpt-4o-contoso-prod) has words that aren't (review F5)
 */
export function catalogLike(model) {
    // Every run of three or more letters (llama in llama3, instruct, contoso) must be a public model word
    return (model.toLowerCase().match(/[a-z]{3,}/g) ?? []).every((w) => MODEL_WORDS.has(w));
}
/** Looks like a key or token (sk-…, a long random run): never sent, whatever pattern it matched */
const secretLike = (m) => redactSecrets(m) !== m || /(^|[^a-z])sk-/i.test(m) || /[A-Za-z0-9]{24,}/.test(m.replace(/[-._:@/]/g, " ").replace(/\b\d+\b/g, ""));
/**
 * A public model ID of some built-in provider, or undefined: only IDs made of public model words and version tokens,
 * never anything that looks like a secret (review F5: Azure deployment names and codenames were sent).
 */
export function publicModel(raw, host) {
    const m = publicModelId(raw);
    if (!m || secretLike(m))
        return undefined;
    // Every ID the feed has records for is made of these words (a test checks), so this drops only names a customer made
    // up: deployment names on Azure, internal codenames. host is kept for callers; the rule is the same everywhere
    void host;
    if (!catalogLike(m))
        return undefined;
    return m;
}
function publicModelId(raw) {
    let m = normalizeModel(raw);
    const ft = /^ft:([^:]+):/.exec(m); // OpenAI fine-tunes: ft:<base>:<org>:<name>:<id>
    if (ft)
        m = ft[1];
    if (m.length > LIMITS.field)
        return undefined;
    for (const p of BUILT_IN.values())
        if (p.modelPattern.test(m) || p.publicModelPattern?.test(m.toLowerCase()))
            return m;
    // Partner vendors' catalog IDs on Azure and Bedrock (src/data/partner-models.json) are public names too
    if (bedrockModel(m) || azureFamily(m))
        return m;
    return undefined;
}
/** "GET /repos/acme/app/issues?x=1" → "GET /{}/{}/{}/{}"; a leading version segment (v1, v1beta, v2.0) is kept. */
export function maskOp(op) {
    const [method, path] = op.split(" ");
    if (!method || !path || !/^[A-Z*]{1,7}$/.test(method))
        return undefined;
    const segs = path.split(/[?#]/)[0].split("/").filter(Boolean);
    const masked = segs.map((s, i) => (i === 0 && /^v\d+(\.\d+)?([a-z]+\d*)?$/.test(s) ? s : "{}"));
    return `${method} /${masked.join("/")}`.slice(0, LIMITS.field);
}
export const LIMITS = { usages: 2000, models: 50, field: 200, params: 30, upcomingDays: 365, upcomingRecords: 100 };
/** Distinct query usages for a scan: the minimum the service needs, deduplicated. */
export function queryOf(usages) {
    const out = new Map();
    for (const u of usages) {
        if (!BUILT_IN.has(u.provider))
            continue;
        // Reached through something that isn't the provider's API: no retirement of the provider's applies
        if (u.via)
            continue;
        const q = { provider: u.provider, kind: u.kind };
        const model = u.model ? publicModel(u.model, u.host) : undefined;
        if (model)
            q.model = model;
        const op = u.op ? maskOp(u.op) : undefined;
        if (op)
            q.op = op;
        if (u.apiVersion && /\d/.test(u.apiVersion) && /^[\w.:@ -]{1,60}$/.test(u.apiVersion))
            q.apiVersion = u.apiVersion;
        if (u.host)
            q.host = u.host;
        // A usage that says nothing matchable once private details are dropped isn't worth sending
        if (!q.model && !q.op && !q.apiVersion && u.kind !== "sdk")
            continue;
        out.set(JSON.stringify(q), q);
        // (a version of a provider that falls back to another's dates, Meta Marketing → Graph: the same version under that
        // provider too, so its record comes back; nothing more than the version is sent)
        const fb = PROVIDERS.find((p) => p.id === u.provider)?.versionFallback;
        if (fb && q.apiVersion) {
            const f = { provider: fb, kind: u.kind, apiVersion: q.apiVersion };
            out.set(JSON.stringify(f), f);
        }
    }
    return [...out.values()];
}
// ---- Pure lookups over a feed (used locally, and by the service) ----
/**
 * Records that could apply to a query (a superset: the client matches exactly afterwards). SDK call and parameter
 * selectors are treated as wildcards because the client doesn't send those; masked path segments ("{}") match any
 * segment.
 */
export function recordsForUsages(feed, query) {
    return feed.filter((c) => query.some((q) => {
        const u = { ...q, lang: "ts", file: "", line: 0, confidence: "certain", snippet: "" };
        if (c.selector.params && q.kind !== "model-ref")
            u.params = c.selector.params;
        if (c.selector.sdkCalls && q.kind === "sdk")
            u.sdkCall = c.selector.sdkCalls[0];
        return matches(c, u);
    }));
}
export function recordsForModel(feed, model) {
    const m = normalizeModel(model);
    return feed.filter((c) => (c.selector.models ?? []).some((s) => (s.endsWith("*") ? m.startsWith(s.slice(0, -1)) : s === m)));
}
export function upcomingRecords(feed, provider, withinDays, today) {
    const horizon = Math.min(Math.max(1, withinDays), LIMITS.upcomingDays);
    return feed
        .filter((c) => (!provider || c.provider === provider) && !c.unconfirmed)
        .map((c) => ({ c, d: daysBetween(today, c.effective) }))
        .filter(({ d }) => d >= 0 && d <= horizon)
        .sort((a, b) => a.d - b.d)
        .slice(0, LIMITS.upcomingRecords)
        .map(({ c }) => c);
}
export function localSource(dir) {
    let cache;
    const feed = async () => {
        if (!cache || Date.now() - cache.at > 10 * 60_000)
            cache = { at: Date.now(), feed: await loadFeed(dir) };
        return cache.feed;
    };
    return {
        describe: `local feed at ${dir}`,
        remote: false,
        forUsages: async () => feed(),
        forModel: async (m) => recordsForModel(await feed(), m),
        forModels: async (ms) => {
            const f = await feed();
            return [...new Map(ms.flatMap((m) => recordsForModel(f, m)).map((r) => [r.id, r])).values()];
        },
        upcoming: async (p, d, t) => upcomingRecords(await feed(), p, d, t),
    };
}
export class LookupError extends Error {
}
/** https anywhere, or http only to this machine (for testing). */
function checkUrl(url) {
    let u;
    try {
        u = new URL(url);
    }
    catch {
        throw new LookupError(`not a valid lookup URL: ${url}`);
    }
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && local)))
        throw new LookupError(`lookup URL must be https: ${url}`);
    return u;
}
export function remoteSource(url = LOOKUP_URL, fetchImpl = fetch) {
    const host = checkUrl(url).host;
    const post = async (body) => {
        let res;
        try {
            // No redirects: the query must only ever go to the host the user can see in the notice
            res = await fetchImpl(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", "user-agent": "vitasta-scanner" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        }
        catch {
            throw new LookupError(`couldn't reach ${host}. Check your connection, or use --feed <dir> with a local feed.`);
        }
        if (res.status === 429)
            throw new LookupError("too many lookups from this address; try again in a few minutes.");
        if (!res.ok)
            throw new LookupError(`the lookup service answered ${res.status}.`);
        let data;
        try {
            // At most 5 MB: an answer is a few hundred records
            const buf = await res.arrayBuffer();
            if (buf.byteLength > 5 * 1024 * 1024)
                throw new LookupError("the lookup service sent more than 5 MB; not read.");
            data = JSON.parse(Buffer.from(buf).toString("utf8"));
        }
        catch (e) {
            if (e instanceof LookupError)
                throw e;
            throw new LookupError(`the lookup service sent something that isn't JSON (a captive portal or proxy?).`);
        }
        return { records: validRecords(data.records), upcoming: validRecords(data.upcoming) };
    };
    return {
        describe: `Vitasta lookup service (${host})`,
        remote: true,
        async forUsages(usages) {
            const q = queryOf(usages);
            if (!q.length)
                return [];
            const out = [];
            for (let i = 0; i < q.length; i += LIMITS.usages)
                out.push(...((await post({ usages: q.slice(i, i + LIMITS.usages) })).records ?? []));
            return [...new Map(out.map((c) => [c.id, c])).values()];
        },
        forModels: async (models) => {
            const ids = [...new Set(models.map((m) => publicModel(m)).filter((m) => !!m))];
            const out = [];
            for (let i = 0; i < ids.length; i += LIMITS.models)
                out.push(...((await post({ models: ids.slice(i, i + LIMITS.models) })).records ?? []));
            return [...new Map(out.map((c) => [c.id, c])).values()];
        },
        forModel: async (model) => {
            const id = publicModel(model);
            return id ? ((await post({ models: [id.slice(0, LIMITS.field)] })).records ?? []) : [];
        },
        upcoming: async (provider, withinDays) => (await post({ upcoming: { provider, withinDays } })).upcoming ?? [],
    };
}
/**
 * Records from the network are data from another machine: every field is checked, capped and cleaned before it is
 * matched or printed, so a hostile or broken lookup host (or a VITASTA_API override) can't put instructions, odd
 * characters or links to other sites into a report or a coding agent's context (review A5). A record without a
 * valid id, provider, type, date or selector is dropped; a bad optional field is dropped from the record.
 */
export function validRecords(v) {
    if (!Array.isArray(v))
        return [];
    return v.slice(0, 2000).map(cleanRecord).filter((r) => !!r);
}
const TYPES = new Set(["model_retirement", "model_deprecation", "endpoint_shutdown", "param_removed", "sdk_api_removed", "version_sunset"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODEL = /^[\w.:@/*+-]{1,200}$/;
const OP = /^[A-Z*]{1,7} \/[\w{}.\/:*~-]{0,300}$/;
const WORD = /^[\w.:@/*+-]{1,120}$/;
/** No control characters or bidirectional overrides, trimmed and capped */
function cleanText(v, max) {
    if (typeof v !== "string")
        return undefined;
    // Control, format (zero-width, bidi, tag characters), private-use and unassigned characters: they can hide text
    const s = v.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, " ").replace(/\s+/g, " ").trim();
    return s ? s.slice(0, max) : undefined;
}
const SOURCE_DOMAINS = JSON.parse(readFileSync(new URL("../data/source-hosts.json", import.meta.url), "utf8")).domains;
/** An https link on a provider's docs domain, or nothing */
export function cleanUrl(v) {
    if (typeof v !== "string" || v.length > 500)
        return undefined;
    try {
        const u = new URL(v);
        if (u.protocol !== "https:" || u.username || u.password)
            return undefined;
        const host = u.hostname.toLowerCase();
        return SOURCE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) ? u.toString() : undefined;
    }
    catch {
        return undefined;
    }
}
const list = (v, re) => {
    if (!Array.isArray(v))
        return undefined;
    const out = v.filter((x) => typeof x === "string" && re.test(x)).slice(0, 200);
    return out.length ? out : undefined;
};
function cleanRecord(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const r = raw;
    const s = (r.selector ?? {});
    const id = typeof r.id === "string" && /^[\w.:@/+-]{1,200}$/.test(r.id) ? r.id : undefined;
    const provider = typeof r.provider === "string" && /^[a-z0-9-]{1,40}$/.test(r.provider) ? r.provider : undefined;
    const type = typeof r.type === "string" && TYPES.has(r.type) ? r.type : undefined;
    const effective = typeof r.effective === "string" && DATE.test(r.effective) ? r.effective : undefined;
    const title = cleanText(r.title, 300);
    const selector = {
        models: list(s.models, MODEL),
        ops: list(s.ops, OP),
        params: list(s.params, WORD),
        sdkCalls: list(s.sdkCalls, WORD),
        hosts: list(s.hosts, /^(bedrock|vertex|azure)$/),
        versions: list(s.versions, /^[\w.-]{1,40}$/),
        headers: list(s.headers, /^[a-z0-9-]{1,60}: [\w.=-]{0,80}\*?$/),
    };
    for (const k of Object.keys(selector))
        if (!selector[k])
            delete selector[k];
    if (!id || !provider || !type || !effective || !title || !Object.keys(selector).length)
        return undefined;
    const sources = (Array.isArray(r.sources) ? r.sources : []).slice(0, 10).flatMap((x) => {
        const src = (x ?? {});
        const url = cleanUrl(src.url);
        return url ? [{ url, ...(cleanText(src.note, 300) ? { note: cleanText(src.note, 300) } : {}), ...(typeof src.checked === "string" && DATE.test(src.checked) ? { checked: src.checked } : {}) }] : [];
    });
    const kinds = ["shutdown", "earliest", "auto-route", "read-only"];
    const versions = Array.isArray(r.modelVersions)
        ? r.modelVersions.slice(0, 50).flatMap((x) => {
            const v = (x ?? {});
            return typeof v.version === "string" && /^[\w.-]{0,40}$/.test(v.version) && typeof v.effective === "string" && DATE.test(v.effective) ? [{ version: v.version, effective: v.effective, ...(v.earliest === true ? { earliest: true } : {}) }] : [];
        })
        : [];
    return {
        id, provider, type, title, selector, effective, sources,
        trigger: r.trigger === "upgrade" ? "upgrade" : "date",
        ...(typeof r.announced === "string" && DATE.test(r.announced) ? { announced: r.announced } : {}),
        ...(r.earliest === true ? { earliest: true } : {}),
        ...(r.unconfirmed === true ? { unconfirmed: true } : {}),
        ...(r.pending === true ? { pending: true } : {}),
        ...(typeof r.dateKind === "string" && kinds.includes(r.dateKind) ? { dateKind: r.dateKind } : {}),
        ...(typeof r.routesTo === "string" && MODEL.test(r.routesTo) ? { routesTo: r.routesTo } : {}),
        ...(versions.length ? { modelVersions: versions } : {}),
        ...(cleanText(r.replacement, 200) ? { replacement: cleanText(r.replacement, 200) } : {}),
        ...(cleanUrl(r.guide) ? { guide: cleanUrl(r.guide) } : {}),
    };
}
/** What the CLI and MCP server use: a local feed when one is given, the lookup service otherwise. */
export function feedSource(dir) {
    return dir ? localSource(dir) : remoteSource();
}
/** One line for stderr, so nobody is surprised by a network request. */
export function lookupNotice(src) {
    if (!src.remote)
        return undefined;
    return `Looking up dates with the ${src.describe}. It receives only the model names, API operations and versions found; no code, file names or repo name. Use --feed <dir> to use a local feed instead.`;
}
/** Findings for a scan, from any source. */
export async function impactsFrom(src, map, today) {
    const feed = await src.forUsages(map.usages);
    // The lookup service answers for the models in the code; the replacements' own records are needed too, to tell
    // whether a named replacement is itself retiring (a few steps of the chain, one request each)
    if (src.remote) {
        const have = new Set(feed.map((r) => r.id));
        const asked = new Set();
        for (let step = 0; step < 4; step++) {
            const next = [...new Set(feed.map((r) => r.replacement?.trim()).filter((m) => !!m && /^[\w.:@/+-]{1,200}$/.test(m) && !asked.has(m)))];
            if (!next.length)
                break;
            next.forEach((m) => asked.add(m));
            for (const r of await src.forModels(next))
                if (!have.has(r.id))
                    (have.add(r.id), feed.push(r));
        }
    }
    return findImpacts(map, feed, today);
}
