import { statusOf } from "./dates.js";
import { resolveReplacement } from "./replacement.js";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_POLICY } from "../config.js";
import { normalizeModel } from "../providers.js";
import type { ApiMap, ChangeRecord, Finding, Usage } from "../types.js";

/**
 * A local change feed, if there is one: --feed / $VITASTA_FEED, else a snapshot bundled with the package
 * (dist/feed-data), else the sibling feed repo when running from source during development. Undefined means
 * "ask the lookup service" (see lookup.ts). A published install never picks up a folder from the user's project.
 */
export function defaultFeedDir(): string | undefined {
  if (process.env.VITASTA_FEED) return process.env.VITASTA_FEED;
  const bundled = resolve(import.meta.dirname, "../feed-data");
  if (existsSync(join(bundled, "openai.json"))) return bundled;
  const dev = resolve(import.meta.dirname, "../../../feed/data");
  if (/[\\/]src[\\/]feed$/.test(import.meta.dirname) && existsSync(join(dev, "openai.json"))) return dev;
  return undefined;
}

/** Load every *.json change file in a feed directory (each file holds an array of records). */
export async function loadFeed(dir: string): Promise<ChangeRecord[]> {
  const out: ChangeRecord[] = [];
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("_")).sort()) {
    const records = JSON.parse(await readFile(join(dir, name), "utf8")) as ChangeRecord[];
    out.push(...records);
  }
  return out;
}

/** Azure's model catalog names aren't case-sensitive ("DeepSeek-R1" and "deepseek-r1" are one model) */
function matchModel(patterns: string[], model: string, anyCase = false): boolean {
  const f = (x: string) => (anyCase ? x.toLowerCase() : x);
  return patterns.some((p) => (p.endsWith("*") ? f(model).startsWith(f(p.slice(0, -1))) : f(model) === f(p)));
}

/**
 * "* /v1/threads" matches /v1/threads and everything under it. A path parameter in the pattern matches any segment,
 * so the spec's /repos/{owner}/{repo} matches code calling /repos/{id}/{id} or /repos/acme/app. A segment the code
 * builds at runtime ({id}) only matches a parameter, never a fixed name: `/repos/${repo}/${path}` can't be said to
 * call /repos/{owner}/{repo}/import.
 */
function matchOp(patterns: string[], op: string): boolean {
  const [method, path] = op.split(" ");
  if (!path) return false; // malformed (e.g. a custom sdkOps value without a method): matches nothing
  const segs = path.split("/");
  const param = (s: string) => /^\{.*\}$/.test(s);
  return patterns.some((p) => {
    const [pm, pp] = p.split(" ");
    if (!pp) return false;
    if (pm !== "*" && method !== "*" && pm !== method) return false;
    const ps = pp.split("/");
    // the pattern must match the whole path when it has parameters (an exact operation), or a prefix otherwise
    const exact = ps.some(param) || pm !== "*";
    if (exact ? segs.length !== ps.length : segs.length < ps.length) return false;
    // "{}" is a segment the lookup client masked (the service answers with a superset), so it matches anything
    return ps.every((s, i) => s === segs[i] || param(s) || segs[i] === "{}");
  });
}

/** "2025-07" from "url: 2025-07", "apiVersion: 2025-07" or "anthropic-version: 2023-06-01" */
function versionOf(u: Usage): string | undefined {
  return u.apiVersion?.split(": ").pop()?.trim();
}

/** Does this change apply to this usage? Every selector field that is set must match. */
export function matches(change: ChangeRecord, u: Usage): boolean {
  if (change.provider !== u.provider) return false;
  const s = change.selector;
  // API version cut-offs match any usage that pins that version (a header, an SDK option or the URL)
  if (change.type === "version_sunset") {
    const v = versionOf(u);
    return !!v && !!s.versions?.includes(v);
  }
  if (s.models) {
    if (!u.model || !matchModel(s.models, normalizeModel(u.model), !!s.hosts?.includes("azure") && u.host === "azure")) return false;
  }
  if (s.ops) {
    if (!u.op || !matchOp(s.ops, u.op)) return false;
  }
  if (s.sdkCalls) {
    if (!u.sdkCall || !s.sdkCalls.some((c) => u.sdkCall === c || u.sdkCall!.startsWith(c + "."))) return false;
  }
  if (s.params) {
    if (!u.params || !s.params.some((p) => u.params!.includes(p))) return false;
  }
  // A model-ref only proves the model string exists, so it can only match model selectors
  if (u.kind === "model-ref" && (s.ops || s.params || s.sdkCalls)) return false;
  if (u.kind === "version-pin") return false;
  // Azure / Bedrock / Vertex retire models on their own schedules: a hosted model only matches that host's
  // records, and a model on the provider's own API only matches the provider's records.
  if (change.type === "model_retirement" || change.type === "model_deprecation") {
    if (u.via) return false;
    if (s.hosts ? !u.host || !s.hosts.includes(u.host) : !!u.host) return false;
  } else if (s.hosts && (!u.host || !s.hosts.includes(u.host))) {
    return false;
  }
  return true;
}

export function daysBetween(fromISO: string, toISO: string): number {
  const ms = Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

export function findImpacts(map: ApiMap, feedIn: ChangeRecord[], today: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const policy = map.config?.policy ?? DEFAULT_POLICY;
  // The repo's own change records (internal APIs) count like feed records; accepted ones are skipped
  const feed = [...feedIn, ...(map.config?.changes ?? [])].filter((c) => !policy.accept.includes(c.id));
  for (const change of feed) {
    for (const u of map.usages) {
      if (!matches(change, u)) continue;
      if (!policy.includeTests && u.inTest) continue;
      if (u.model && policy.ignoreModels.includes(normalizeModel(u.model))) continue;
      // one finding per change, place and model (a call and a loose string on the same line are the same thing)
      const key = `${change.id}|${u.file}|${u.line}|${u.model ? normalizeModel(u.model) : u.op ?? u.apiVersion ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Past an "earliest" date it can stop any day; past an auto-route date it works on another model; some versions
      // gone and others not means "check your version", not broken (src/feed/dates.ts)
      const { status, daysLeft } = statusOf(change, today, policy.urgentDays);
      const moveTo = resolveReplacement(change, feed, today);
      findings.push({ change, usage: u, daysLeft, status, ...(moveTo ? { moveTo } : {}) });
    }
  }
  const rank = { broken: 0, urgent: 1, upcoming: 2, "on-upgrade": 3 };
  return findings.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      Number(!!a.usage.inTest) - Number(!!b.usage.inTest) ||
      Number(!!a.usage.listed) - Number(!!b.usage.listed) ||
      a.daysLeft - b.daysLeft ||
      a.usage.file.localeCompare(b.usage.file) ||
      a.usage.line - b.usage.line,
  );
}
