/**
 * What a record's date means for a place in code, in one place: the status (broken / due / upcoming) and the words
 * every report uses (CLI report, PR check, MCP, the App's issues and PRs, the website).
 *
 *   shutdown    stops working on the date                       "is retired" / "is being retired"
 *   earliest    can stop any day from the date ("not sooner")    "can be retired"
 *   auto-route  keeps working, but on another model              "now runs as X" / "will silently change to X"
 *   read-only   creating and changing stop; reading still works  "is read-only" / "becomes read-only"
 *   modelVersions: versions retire on different dates; with no version in the code it's "some versions retired"
 *   until the last date, and only then retired.
 */
import type { ChangeRecord, Finding } from "../types.js";

export type DateKind = NonNullable<ChangeRecord["dateKind"]>;

export function dateKindOf(c: ChangeRecord): DateKind {
  return c.dateKind ?? (c.earliest ? "earliest" : "shutdown");
}

/**
 * Today as YYYY-MM-DD in UTC. One clock everywhere (CLI, Action, MCP, the App, the lookup service), so a model isn't
 * "retired" on a machine east of UTC hours before the provider's date begins elsewhere (review B9)
 */
export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function daysFrom(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z")) / 86_400_000);
}

/** The date by which every version is gone (the record's own date when it has no per-version dates) */
export function lastEffective(c: ChangeRecord): string {
  return (c.modelVersions ?? []).reduce((m, v) => (v.effective > m ? v.effective : m), c.effective);
}

/** Versions already past their date */
export function retiredVersions(c: ChangeRecord, today: string): { version: string; effective: string }[] {
  return (c.modelVersions ?? []).filter((v) => v.effective <= today && !v.earliest);
}

/** Some versions are past their date, others still run: the code doesn't say which one a deployment uses */
export function partlyRetired(c: ChangeRecord, today: string): boolean {
  const last = lastEffective(c);
  return !!c.modelVersions?.length && last > today && (c.effective <= today || retiredVersions(c, today).length > 0);
}

export function statusOf(c: ChangeRecord, today: string, urgentDays: number): { status: Finding["status"]; daysLeft: number } {
  const daysLeft = daysFrom(today, c.effective);
  if (c.trigger === "upgrade") return { status: "on-upgrade", daysLeft };
  if (partlyRetired(c, today)) return { status: "urgent", daysLeft };
  const kind = dateKindOf(c);
  const left = daysFrom(today, lastEffective(c));
  // The day itself: the provider's cut-off time isn't known, so it's due today, not broken yet
  if (left === 0) return { status: "urgent", daysLeft };
  if (left < 0) {
    // Past an "earliest" date it can stop any day; past an auto-route date it works but on another model
    return { status: kind === "earliest" || kind === "auto-route" ? "urgent" : "broken", daysLeft };
  }
  return { status: daysLeft <= urgentDays ? "urgent" : "upcoming", daysLeft };
}

const HOST = { bedrock: "Amazon Bedrock", vertex: "Vertex AI", azure: "Azure" } as const;

/** "is retired", "can be retired", "will silently change to gpt-5.1", "is partly retired", … (after the model name) */
export function verbOf(c: ChangeRecord, today: string): string {
  if (partlyRetired(c, today)) return "is partly retired (some versions)";
  const past = lastEffective(c) < today;
  switch (dateKindOf(c)) {
    case "earliest":
      return "can be retired";
    case "auto-route":
      return past ? `now runs as ${c.routesTo ?? "another model"}` : `will silently change to ${c.routesTo ?? "another model"}`;
    case "read-only":
      return past ? "is read-only" : "becomes read-only";
    default:
      return past ? "is retired" : "is being retired";
  }
}

/** A model on its platform: "gpt-4o on Azure" */
export function whereOf(model: string, host?: string): string {
  return `${model}${host ? ` on ${HOST[host as keyof typeof HOST] ?? host}` : ""}`;
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** When, in words: "on 2026-11-30 (12 days left)", "since 2026-11-17", "not before …", the per-version story, … */
export function whenOf(c: ChangeRecord, today: string): string {
  if (c.trigger === "upgrade") return `when you move to the new API version (${c.effective})`;
  const last = lastEffective(c);
  if (partlyRetired(c, today)) {
    const gone = retiredVersions(c, today);
    const byDate = new Map<string, string[]>();
    for (const v of gone) byDate.set(v.effective, [...(byDate.get(v.effective) ?? []), v.version]);
    const what = [...byDate].map(([d, vs]) => `version${vs.length > 1 ? "s" : ""} ${list(vs)} retired on ${d}`).join("; ");
    return `${what || `the first versions retired on ${c.effective}`}; other versions run until ${last} at the latest (${days(daysFrom(today, last))}). Check which version your deployment uses`;
  }
  const versions = c.modelVersions?.length && last !== c.effective ? `; all versions by ${last}` : "";
  const d = daysFrom(today, c.effective);
  const dl = daysFrom(today, last);
  switch (dateKindOf(c)) {
    case "earliest":
      return dl < 0 ? `any day now: the earliest date (${last}) has passed` : dl === 0 ? `from today (${last}) at the earliest` : `not before ${c.effective} (${days(d)} left at the earliest)${versions}`;
    case "auto-route":
      return dl < 0
        ? `since ${last}, calls go to ${c.routesTo ?? "another model"} without any change on your side`
        : dl === 0
        ? `today (${last}), calls start going to ${c.routesTo ?? "another model"} without any change on your side`
        : `on ${c.effective} (${days(d)} left), calls start going to ${c.routesTo ?? "another model"} without any change on your side`;
    case "read-only":
      return dl < 0 ? `since ${last}, creating and changing stopped; reading still works` : dl === 0 ? `today (${last}), creating and changing stop` : `on ${c.effective} (${days(d)} left), creating and changing stop`;
    default:
      return dl < 0 ? `since ${last} (${days(-dl)} ago)` : dl === 0 ? `today (${last})${versions}` : `on ${c.effective} (${days(d)} left)${versions}`;
  }
}

/** When the record was last checked against its sources: the newest `checked` date */
export function checkedOf(c: ChangeRecord): string | undefined {
  return c.sources.map((s) => s.checked).filter((x): x is string => !!x).sort().pop();
}

/** The day a finding was judged on (findings carry days left until the record's date) */
export function todayOf(f: Pick<Finding, "change" | "daysLeft">): string {
  return new Date(Date.parse(f.change.effective + "T00:00:00Z") - f.daysLeft * 86_400_000).toISOString().slice(0, 10);
}

/**
 * When, in a few words, for titles and commit messages: "retires 2026-11-30", "may retire from 2026-12-07",
 * "some versions retired; all by 2027-05-18", "switches to gpt-5.1 on 2027-01-14", "retires today" (review B8:
 * a title must not state a firm date the provider never gave)
 */
export function shortWhenOf(c: ChangeRecord, today: string): string {
  if (c.trigger === "upgrade") return `on upgrade to API version ${c.effective}`;
  const last = lastEffective(c);
  if (partlyRetired(c, today)) return `some versions retired; all by ${last}`;
  const dl = daysFrom(today, last);
  const all = c.modelVersions?.length && last !== c.effective ? `; all versions by ${last}` : "";
  switch (dateKindOf(c)) {
    case "earliest":
      return dl < 0 ? "may retire any day" : dl === 0 ? "may retire from today" : `may retire from ${c.effective}`;
    case "auto-route":
      return dl < 0 ? `now runs as ${c.routesTo ?? "another model"}` : `switches to ${c.routesTo ?? "another model"} ${dl === 0 ? "today" : `on ${c.effective}`}`;
    case "read-only":
      return dl < 0 ? `read-only since ${last}` : dl === 0 ? "read-only from today" : `read-only from ${c.effective}`;
    default:
      return dl < 0 ? "retired" : dl === 0 ? "retires today" : `retires ${c.effective}${all}`;
  }
}
