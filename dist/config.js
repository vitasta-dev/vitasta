/**
 * .vitasta.yml: per-repo settings for teams.
 *
 *   ignore:                      # extra paths to skip (globs)
 *     - "legacy/**"
 *   providers:                   # your own APIs, same format as src/providers/*.json
 *     - id: acme-billing
 *       hosts: [billing.acme.internal]
 *       urlVersion: "/v(\\d+)/"
 *   changes:                     # your own deprecations and sunsets (same format as the feed)
 *     - id: acme-billing-v1
 *       provider: acme-billing
 *       type: version_sunset
 *       title: Billing API v1 is retired
 *       selector: { versions: ["1"] }
 *       effective: "2027-03-01"
 *       trigger: date
 *   policy:
 *     failOn: [broken, urgent]   # statuses that fail the PR check
 *     urgentDays: 30             # how far ahead counts as urgent
 *     includeTests: false        # report test/example files at all
 *     accept: [openai-gpt-4-0613-retire-2026-10-23]   # change ids you've accepted
 *     ignoreModels: ["gpt-4o-mini"]
 *     minConfidence: possible     # certain | likely | possible: weakest code match that may fail a PR
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PROVIDERS, providerFromSpec } from "./providers.js";
export const DEFAULT_POLICY = { failOn: ["broken", "urgent"], urgentDays: 30, includeTests: true, accept: [], ignoreModels: [], minConfidence: "possible" };
const STATUSES = ["broken", "urgent", "upcoming", "on-upgrade"];
const CHANGE_TYPES = ["model_retirement", "model_deprecation", "endpoint_shutdown", "param_removed", "sdk_api_removed", "version_sunset"];
/**
 * "src/**", "*.test.ts", "legacy/" → matcher on repo-relative paths. Globs come from repos we don't control, so they
 * are matched with a small dynamic-programming matcher (O(path × glob)), never turned into a backtracking RegExp.
 *   **  any characters, across folders     *  any characters within a folder     ?  one character (not /)
 */
export function globToRegExp(glob) {
    // Like .gitignore: a pattern without a slash matches at any depth ("*.test.ts", "fixtures"), and a name also
    // covers everything inside it ("legacy" → legacy/x.ts). "legacy/" means a folder anywhere.
    const trimmed = glob.replace(/^\.?\//, "");
    const anchored = glob.startsWith("/") || glob.startsWith("./") || trimmed.replace(/\/$/, "").includes("/");
    if (!anchored) {
        const name = trimmed.replace(/\/$/, "");
        const forms = [`**/${name}`, `**/${name}/**`].map(globMatcher);
        return { test: (path) => forms.some((m) => m.test(path)) };
    }
    return globMatcher(trimmed);
}
function globMatcher(glob) {
    const g = glob.replace(/\/$/, "/**");
    const toks = [];
    for (let i = 0; i < g.length; i++) {
        if (g[i] === "*" && g[i + 1] === "*") {
            while (g[i + 1] === "*")
                i++;
            if (toks[toks.length - 1] !== "**")
                toks.push("**");
        }
        else
            toks.push(g[i]);
    }
    return {
        test(path) {
            // can[j]: the first j tokens can match the path read so far
            // A * or ** can match nothing, and "**/" can match no folder at all ("**/x.ts" matches "x.ts")
            const close = (c) => {
                for (let j = 0; j < toks.length; j++) {
                    if (!c[j])
                        continue;
                    if (toks[j] === "*" || toks[j] === "**")
                        c[j + 1] = true;
                    if (toks[j] === "**" && toks[j + 1] === "/")
                        c[j + 2] = true;
                }
                return c;
            };
            let can = new Array(toks.length + 1).fill(false);
            can[0] = true;
            close(can);
            for (const ch of path) {
                const next = new Array(toks.length + 1).fill(false);
                for (let j = 0; j < toks.length; j++) {
                    const t = toks[j];
                    if (t === "**") {
                        if (can[j + 1] || can[j])
                            next[j + 1] = true; // ** eats this character
                    }
                    else if (t === "*") {
                        if ((can[j + 1] || can[j]) && ch !== "/")
                            next[j + 1] = true;
                    }
                    else if (can[j] && (t === ch || (t === "?" && ch !== "/")))
                        next[j + 1] = true;
                }
                can = close(next);
                if (!can.some(Boolean))
                    return false;
            }
            return can[toks.length];
        },
    };
}
/** Longest string a repo's own pattern is ever tested against: model ids, versions and paths are short */
const MAX_PATTERN_INPUT = 256;
/** Time all of a repo's own patterns may spend matching in one scan, together; after that they match nothing (F1) */
const PATTERN_BUDGET_MS = 2000;
/** One time allowance shared by every pattern from one repo's config */
export class PatternBudget {
    spent = 0;
    get exhausted() {
        return this.spent > PATTERN_BUDGET_MS;
    }
}
// V8 switches a match to its linear-time engine once it backtracks too much (about 10× faster on the worst patterns
// measured). It only changes how a slow match runs, never what matches. Not every Node build has the flag.
try {
    (await import("node:v8")).setFlagsFromString("--enable-experimental-regexp-engine-on-excessive-backtracks");
}
catch {
    /* not available */
}
/**
 * A repo's RegExp with a hard ceiling on its work: it refuses long inputs, and once it has used its time budget for
 * this scan it stops matching, so even a pattern that slips past safePattern can't stall a scan for long.
 */
export class BoundedRegExp extends RegExp {
    budget = new PatternBudget();
    timed(run, none) {
        if (this.budget.exhausted)
            return none;
        const t = performance.now();
        try {
            return run();
        }
        finally {
            this.budget.spent += performance.now() - t;
        }
    }
    test(s) {
        return String(s).length <= MAX_PATTERN_INPUT && this.timed(() => super.test(s), false);
    }
    exec(s) {
        return String(s).length <= MAX_PATTERN_INPUT ? this.timed(() => super.exec(s), null) : null;
    }
}
/**
 * Patterns come from repos we don't control. Keep them to a shape that can't backtrack badly (ReDoS): short, no
 * repeated groups like (a|aa)+ or (a+)+, no back-references or look-arounds, and at most two open-ended repeats.
 */
export function safePattern(src, what) {
    if (src === undefined)
        return undefined;
    if (typeof src !== "string")
        throw new Error(`${what}: must be a string`);
    if (src.length > 200)
        throw new Error(`${what}: pattern longer than 200 characters`);
    const bare = src.replace(/\\./g, "x").replace(/\[(?:\\.|[^\]])*\]/g, "c"); // escapes and [classes] are single atoms
    if (/\)\s*(?:[*+?]|\{)/.test(bare))
        throw new Error(`${what}: a repeated group like (...)+ isn't allowed`);
    if (/\(\?(?:=|!|<=|<!)/.test(bare) || /\\[1-9k]/.test(src))
        throw new Error(`${what}: look-arounds and back-references aren't allowed`);
    if ((bare.match(/[*+]|\{\d+,\}/g) ?? []).length > 2)
        throw new Error(`${what}: at most two open-ended repeats (*, +) are allowed`);
    // Long bounded repeats next to open-ended ones still backtrack (\w*\w*\w{0,250}!): keep them short (review F1).
    // Whatever slips through is capped by the scan's time budget for repo patterns (BoundedRegExp)
    if ([...bare.matchAll(/\{(\d+)(?:,(\d*))?\}/g)].some((m) => Number(m[2] || m[1]) > 32))
        throw new Error(`${what}: bounded repeats {m,n} may go up to 32`);
    // Bounded repeats chained together backtrack too (a{0,40}a{0,40}a{0,40}...): cap repeats of any kind
    if ((bare.match(/[*+?]|\{\d+(,\d*)?\}/g) ?? []).length > 3)
        throw new Error(`${what}: at most three repeats (*, +, ?, {m,n}) are allowed`);
    new RegExp(src); // throws on invalid syntax
    return src;
}
const strings = (v, max = 200) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && x.length <= max);
/** Shape checks for a repo's custom provider, so a typo becomes a warning instead of a crash mid-scan. */
function specProblem(s) {
    if (!s || typeof s !== "object")
        return "must be a mapping";
    if (typeof s.id !== "string" || !/^[\w.-]{1,40}$/.test(s.id))
        return "id must be a short name";
    if (!strings(s.hosts))
        return "hosts must be a list of host names";
    if (s.packages !== undefined && (typeof s.packages !== "object" || Array.isArray(s.packages) || !Object.values(s.packages).every((v) => strings(v))))
        return "packages must map languages to lists of names";
    for (const k of ["clientClasses", "versionHeaders", "versionKeys", "keywords"])
        if (s[k] !== undefined && !strings(s[k]))
            return `${k} must be a list of strings`;
    if (s.sdkOps !== undefined && (typeof s.sdkOps !== "object" || Array.isArray(s.sdkOps) || !Object.entries(s.sdkOps).every(([k, v]) => k.length <= 200 && typeof v === "string" && /^[A-Z*]{1,7} \/\S{0,300}$/.test(v))))
        return 'sdkOps values must look like "POST /v1/things"';
    for (const k of ["modelPattern", "urlVersion", "stripPrefix", "opTemplate"])
        if (s[k] !== undefined && typeof s[k] !== "string")
            return `${k} must be a string`;
    return undefined;
}
const bounded = (re, budget) => {
    if (!re)
        return undefined;
    const b = new BoundedRegExp(re.source, re.flags);
    b.budget = budget;
    return b;
};
const isDate = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s)))
        return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === String(s);
};
const SELECTOR_FIELDS = ["models", "ops", "params", "sdkCalls", "hosts", "versions", "headers"];
/** Provider ids that ship with the scanner, read before any repo config can register its own */
const BUILT_IN_IDS = new Set(PROVIDERS.map((p) => p.id));
export const CONFIG_FILES = [".vitasta.yml", ".vitasta.yaml", ".github/vitasta.yml"];
/**
 * The repo's .vitasta.yml. `fromText` replaces reading the working tree: a PR check passes the base branch's file
 * (or null for none), so a PR can't change the policy its own check runs under (review B14).
 */
export async function loadRepoConfig(root, fromText) {
    const cfg = { ignore: [], providers: [], changes: [], policy: { ...DEFAULT_POLICY }, warnings: [] };
    // Every pattern from this config shares one time allowance per scan
    const budget = new PatternBudget();
    let text = fromText ?? undefined;
    for (const name of fromText !== undefined ? [] : CONFIG_FILES) {
        // Never follow a symlink, at any level (.github itself could be one): it could point outside the repo, and the
        // file's text can end up in warnings
        const st = await lstat(join(root, name)).catch(() => undefined);
        if (!st)
            continue;
        const parts = name.split("/").slice(0, -1);
        const dirsOk = (await Promise.all(parts.map((_, i) => lstat(join(root, ...parts.slice(0, i + 1))).catch(() => undefined)))).every((s) => s?.isDirectory() && !s.isSymbolicLink());
        if (!st.isFile() || !dirsOk) {
            cfg.warnings.push(`${name} is a symlink or not a regular file; ignored`);
            return cfg;
        }
        text = await readFile(join(root, name), "utf8").catch(() => undefined);
        if (text !== undefined)
            break;
    }
    if (text === undefined)
        return cfg;
    if (text.length > 200_000) {
        cfg.warnings.push(".vitasta.yml is larger than 200 KB; ignored");
        return cfg;
    }
    let raw;
    try {
        raw = parseYaml(text, { maxAliasCount: 50 }) ?? {};
    }
    catch (e) {
        // The parser's message quotes the offending lines: report only where it is
        const pos = e.linePos?.[0];
        cfg.warnings.push(`.vitasta.yml could not be read: invalid YAML${pos ? ` at line ${pos.line}, column ${pos.col}` : ""}`);
        return cfg;
    }
    for (const g of asArray(raw.ignore)) {
        if (typeof g === "string" && g.length < 300 && cfg.ignore.length < 200)
            cfg.ignore.push(globToRegExp(g));
    }
    for (const [i, p] of asArray(raw.providers).entries()) {
        try {
            const spec = p;
            const problem = specProblem(spec);
            if (problem)
                throw new Error(problem);
            safePattern(spec.modelPattern, `providers[${i}].modelPattern`);
            safePattern(spec.urlVersion, `providers[${i}].urlVersion`);
            safePattern(spec.stripPrefix, `providers[${i}].stripPrefix`);
            // A repo's provider can't stand in for a built-in one: its usages would then be sent to the lookup as that
            // provider's (review F6)
            if (BUILT_IN_IDS.has(spec.id))
                throw new Error(`id "${spec.id}" is a built-in provider; use another name`);
            // Path ownership and the lookup's public-ID rule are for built-in providers only
            const def = providerFromSpec({ ...spec, pathPattern: undefined, publicModelPattern: undefined });
            // A repo's keywords are plain words, not regexes (they go into the scan prefilter)
            const keywords = def.keywords?.filter((k) => typeof k === "string" && k.length <= 60).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            const hosts = def.hosts.filter((h) => typeof h === "string" && /^[\w.-]{1,253}$/.test(h));
            if (!hosts.length)
                throw new Error("hosts must be plain host names");
            cfg.providers.push({ ...def, hosts, keywords, modelPattern: bounded(def.modelPattern, budget), urlVersion: bounded(def.urlVersion, budget), stripPrefix: bounded(def.stripPrefix, budget) });
        }
        catch (e) {
            cfg.warnings.push(`providers[${i}] skipped: ${e.message}`);
        }
    }
    for (const [i, c] of asArray(raw.changes).entries()) {
        const r = c;
        const problem = !r?.id ? "missing id" : !r.provider ? "missing provider" : !CHANGE_TYPES.includes(r.type) ? `type must be one of ${CHANGE_TYPES.join(", ")}` :
            !isDate(r.effective) ? "effective must be a real date, YYYY-MM-DD" : !r.selector || typeof r.selector !== "object" || Array.isArray(r.selector) ? "missing selector" :
                SELECTOR_FIELDS.some((k) => r.selector[k] !== undefined && !(Array.isArray(r.selector[k]) && r.selector[k].every((x) => typeof x === "string"))) ? `selector fields (${SELECTOR_FIELDS.join(", ")}) must be lists of strings` :
                    !SELECTOR_FIELDS.some((k) => r.selector[k]?.length) ? "selector is empty" : undefined;
        // Text fields are text: a number or a list here crashed the scan later (review F15)
        const badText = !problem && ["title", "replacement", "guide"].find((k) => r[k] !== undefined && (typeof r[k] !== "string" || r[k].length > 500));
        if (problem || badText) {
            cfg.warnings.push(`changes[${i}] skipped: ${problem || `${badText} must be text`}`);
            continue;
        }
        cfg.changes.push({ ...r, effective: String(r.effective), trigger: r.trigger === "upgrade" ? "upgrade" : "date", title: r.title ?? r.id, sources: r.sources ?? [{ url: ".vitasta.yml", note: "defined by this repository" }] });
    }
    const pol = raw.policy ?? {};
    if (pol.failOn !== undefined) {
        const given = asArray(pol.failOn);
        const failOn = given.filter((s) => STATUSES.includes(s));
        const unknown = given.filter((s) => !STATUSES.includes(s));
        if (unknown.length)
            cfg.warnings.push(`policy.failOn: unknown status ${unknown.map((u) => JSON.stringify(u)).join(", ")} (use ${STATUSES.join(", ")})`);
        // An empty list is a deliberate "never fail"; a list of only typos keeps the default rather than silently turning checks off
        if (failOn.length || given.length === 0)
            cfg.policy.failOn = failOn;
    }
    if (Number.isFinite(pol.urgentDays) && pol.urgentDays >= 0 && pol.urgentDays <= 3650)
        cfg.policy.urgentDays = Math.floor(pol.urgentDays);
    if (typeof pol.includeTests === "boolean")
        cfg.policy.includeTests = pol.includeTests;
    cfg.policy.accept = asArray(pol.accept).filter((x) => typeof x === "string");
    if (["certain", "likely", "possible"].includes(pol.minConfidence))
        cfg.policy.minConfidence = pol.minConfidence;
    cfg.policy.ignoreModels = asArray(pol.ignoreModels).filter((x) => typeof x === "string");
    // Warnings are shown in CI logs and checks: one line each, no control characters
    cfg.warnings = cfg.warnings.map((w) => w.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 300));
    return cfg;
}
function asArray(x) {
    return Array.isArray(x) ? x : x === undefined || x === null ? [] : [x];
}
export function ignored(cfg, rel) {
    return !!cfg?.ignore.some((re) => re.test(rel));
}
