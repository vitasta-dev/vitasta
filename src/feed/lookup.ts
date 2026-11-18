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
import { normalizeModel, PROVIDERS } from "../providers.js";
import type { ApiMap, ChangeRecord, Usage } from "../types.js";

export const LOOKUP_URL = process.env.VITASTA_API ?? "https://app.vitasta.dev/v1/lookup";

/** What leaves the machine for one usage. */
export type QueryUsage = Pick<Usage, "provider" | "kind" | "model" | "op" | "apiVersion" | "host">;

// Captured at load, before any repo's .vitasta.yml can register providers of its own
const BUILT_IN = new Map(PROVIDERS.map((p) => [p.id, p]));

/** A public model ID of some built-in provider, or undefined. */
export function publicModel(raw: string): string | undefined {
  let m = normalizeModel(raw);
  const ft = /^ft:([^:]+):/.exec(m); // OpenAI fine-tunes: ft:<base>:<org>:<name>:<id>
  if (ft) m = ft[1];
  if (m.length > LIMITS.field) return undefined;
  for (const p of BUILT_IN.values()) if (p.modelPattern.test(m) || p.publicModelPattern?.test(m.toLowerCase())) return m;
  return undefined;
}

/** "GET /repos/acme/app/issues?x=1" → "GET /{}/{}/{}/{}"; a leading version segment (v1, v1beta, v2.0) is kept. */
export function maskOp(op: string): string | undefined {
  const [method, path] = op.split(" ");
  if (!method || !path || !/^[A-Z*]{1,7}$/.test(method)) return undefined;
  const segs = path.split(/[?#]/)[0].split("/").filter(Boolean);
  const masked = segs.map((s, i) => (i === 0 && /^v\d+(\.\d+)?([a-z]+\d*)?$/.test(s) ? s : "{}"));
  return `${method} /${masked.join("/")}`.slice(0, LIMITS.field);
}

export const LIMITS = { usages: 2000, models: 50, field: 200, params: 30, upcomingDays: 365, upcomingRecords: 100 } as const;

/** Distinct query usages for a scan: the minimum the service needs, deduplicated. */
export function queryOf(usages: Usage[]): QueryUsage[] {
  const out = new Map<string, QueryUsage>();
  for (const u of usages) {
    if (!BUILT_IN.has(u.provider)) continue;
    // Reached through something that isn't the provider's API: no retirement of the provider's applies
    if (u.via) continue;
    const q: QueryUsage = { provider: u.provider, kind: u.kind };
    const model = u.model ? publicModel(u.model) : undefined;
    if (model) q.model = model;
    const op = u.op ? maskOp(u.op) : undefined;
    if (op) q.op = op;
    if (u.apiVersion && /\d/.test(u.apiVersion) && /^[\w.:@ -]{1,60}$/.test(u.apiVersion)) q.apiVersion = u.apiVersion;
    if (u.host) q.host = u.host;
    // A usage that says nothing matchable once private details are dropped isn't worth sending
    if (!q.model && !q.op && !q.apiVersion && u.kind !== "sdk") continue;
    out.set(JSON.stringify(q), q);
  }
  return [...out.values()];
}

// ---- Pure lookups over a feed (used locally, and by the service) ----

/**
 * Records that could apply to a query (a superset: the client matches exactly afterwards). SDK call and parameter
 * selectors are treated as wildcards because the client doesn't send those; masked path segments ("{}") match any
 * segment.
 */
export function recordsForUsages(feed: ChangeRecord[], query: QueryUsage[]): ChangeRecord[] {
  return feed.filter((c) =>
    query.some((q) => {
      const u = { ...q, lang: "ts", file: "", line: 0, confidence: "certain", snippet: "" } as Usage;
      if (c.selector.params && q.kind !== "model-ref") u.params = c.selector.params;
      if (c.selector.sdkCalls && q.kind === "sdk") u.sdkCall = c.selector.sdkCalls[0];
      return matches(c, u);
    }),
  );
}

export function recordsForModel(feed: ChangeRecord[], model: string): ChangeRecord[] {
  const m = normalizeModel(model);
  return feed.filter((c) => (c.selector.models ?? []).some((s) => (s.endsWith("*") ? m.startsWith(s.slice(0, -1)) : s === m)));
}

export function upcomingRecords(feed: ChangeRecord[], provider: string | undefined, withinDays: number, today: string): ChangeRecord[] {
  const horizon = Math.min(Math.max(1, withinDays), LIMITS.upcomingDays);
  return feed
    .filter((c) => (!provider || c.provider === provider) && !c.unconfirmed)
    .map((c) => ({ c, d: daysBetween(today, c.effective) }))
    .filter(({ d }) => d >= 0 && d <= horizon)
    .sort((a, b) => a.d - b.d)
    .slice(0, LIMITS.upcomingRecords)
    .map(({ c }) => c);
}

// ---- Sources ----

export interface FeedSource {
  /** Shown to the user: where dates come from */
  describe: string;
  remote: boolean;
  forUsages(usages: Usage[]): Promise<ChangeRecord[]>;
  forModel(model: string): Promise<ChangeRecord[]>;
  upcoming(provider: string | undefined, withinDays: number, today: string): Promise<ChangeRecord[]>;
}

export function localSource(dir: string): FeedSource {
  let cache: { at: number; feed: ChangeRecord[] } | undefined;
  const feed = async () => {
    if (!cache || Date.now() - cache.at > 10 * 60_000) cache = { at: Date.now(), feed: await loadFeed(dir) };
    return cache.feed;
  };
  return {
    describe: `local feed at ${dir}`,
    remote: false,
    forUsages: async () => feed(),
    forModel: async (m) => recordsForModel(await feed(), m),
    upcoming: async (p, d, t) => upcomingRecords(await feed(), p, d, t),
  };
}

export class LookupError extends Error {}

/** https anywhere, or http only to this machine (for testing). */
function checkUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LookupError(`not a valid lookup URL: ${url}`);
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && local))) throw new LookupError(`lookup URL must be https: ${url}`);
  return u;
}

export function remoteSource(url = LOOKUP_URL, fetchImpl: typeof fetch = fetch): FeedSource {
  const host = checkUrl(url).host;
  const post = async (body: unknown): Promise<{ records?: ChangeRecord[]; upcoming?: ChangeRecord[] }> => {
    let res: Response;
    try {
      // No redirects: the query must only ever go to the host the user can see in the notice
      res = await fetchImpl(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", "user-agent": "vitasta-scanner" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new LookupError(`couldn't reach ${host}. Check your connection, or use --feed <dir> with a local feed.`);
    }
    if (res.status === 429) throw new LookupError("too many lookups from this address; try again in a few minutes.");
    if (!res.ok) throw new LookupError(`the lookup service answered ${res.status}.`);
    let data: { records?: unknown; upcoming?: unknown };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new LookupError(`the lookup service sent something that isn't JSON (a captive portal or proxy?).`);
    }
    return { records: validRecords(data.records), upcoming: validRecords(data.upcoming) };
  };
  return {
    describe: `Vitasta lookup service (${host})`,
    remote: true,
    async forUsages(usages) {
      const q = queryOf(usages);
      if (!q.length) return [];
      const out: ChangeRecord[] = [];
      for (let i = 0; i < q.length; i += LIMITS.usages) out.push(...((await post({ usages: q.slice(i, i + LIMITS.usages) })).records ?? []));
      return [...new Map(out.map((c) => [c.id, c])).values()];
    },
    forModel: async (model) => (await post({ models: [model.slice(0, LIMITS.field)] })).records ?? [],
    upcoming: async (provider, withinDays) => (await post({ upcoming: { provider, withinDays } })).upcoming ?? [],
  };
}

/** Keep only records with the shape matching needs; anything else from the network is dropped. */
function validRecords(v: unknown): ChangeRecord[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is ChangeRecord =>
      !!r && typeof r === "object" && typeof r.id === "string" && typeof r.provider === "string" && typeof r.type === "string" &&
      typeof r.effective === "string" && typeof r.title === "string" && !!r.selector && typeof r.selector === "object" && Array.isArray(r.sources),
  );
}

/** What the CLI and MCP server use: a local feed when one is given, the lookup service otherwise. */
export function feedSource(dir: string | undefined): FeedSource {
  return dir ? localSource(dir) : remoteSource();
}

/** One line for stderr, so nobody is surprised by a network request. */
export function lookupNotice(src: FeedSource): string | undefined {
  if (!src.remote) return undefined;
  return `Looking up dates with the ${src.describe}. It receives only the model names, API operations and versions found; no code, file names or repo name. Use --feed <dir> to use a local feed instead.`;
}

/** Findings for a scan, from any source. */
export async function impactsFrom(src: FeedSource, map: ApiMap, today: string) {
  return findImpacts(map, await src.forUsages(map.usages), today);
}
