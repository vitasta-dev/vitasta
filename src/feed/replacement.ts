/**
 * What to move to, resolved through the feed: the provider's named replacement can itself be retired or retiring
 * (o1-mini → o4-mini, which retired 2026-10-23 → gpt-5.6-terra). Follow the chain on the same platform to the first
 * model that isn't retired or due within `horizonDays`, and say so. Generic: any record whose `replacement` is a
 * model the feed has a record for on the same provider and host (review: live test on test-app, 18 Nov 2026).
 */
import type { ChangeRecord } from "../types.js";
import { daysFrom } from "./dates.js";

export interface MoveTo {
  /** The model to move to, or undefined when the chain ends at a retiring model with no replacement announced */
  model?: string;
  /** What the provider names (the record's own replacement text) */
  named: string;
  /** Each named model that is itself retired or retiring, in order */
  skipped: { model: string; effective: string; retired: boolean }[];
  /** One line for reports and PRs */
  text: string;
}

/** A plain model ID (no spaces, not prose like "Responses API") */
const plainId = (s: string | undefined) => {
  const t = s?.trim().replace(/`/g, "");
  return t && /^[\w.:@/+-]{1,200}$/.test(t) ? t : undefined;
};

const MODEL_TYPES = new Set(["model_retirement", "model_deprecation"]);
const samePlatform = (a: ChangeRecord, b: ChangeRecord) => a.provider === b.provider && JSON.stringify(a.selector.hosts ?? []) === JSON.stringify(b.selector.hosts ?? []);
const covers = (r: ChangeRecord, model: string) => (r.selector.models ?? []).some((m) => (m.endsWith("*") ? model.startsWith(m.slice(0, -1)) : m === model));

export function resolveReplacement(change: ChangeRecord, feed: ChangeRecord[], today: string, horizonDays = 90): MoveTo | undefined {
  const named = change.replacement?.trim();
  if (!named) return undefined;
  const first = plainId(named);
  if (!first) return { named, skipped: [], text: named }; // prose: shown as the provider wrote it
  const skipped: MoveTo["skipped"] = [];
  const seen = new Set<string>();
  let cur: string | undefined = first;
  let good: string | undefined;
  while (cur && !seen.has(cur) && skipped.length < 6) {
    seen.add(cur);
    const model: string = cur;
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
  if (!skipped.length) return { model: first, named, skipped, text: first };
  const why = skipped.map((s, i) => `${i ? "its replacement " : ""}${s.model}, ${s.retired ? `retired since ${s.effective}` : `itself retiring on ${s.effective}`}`).join("; then ");
  if (good) return { model: good, named, skipped, text: `${good} (the provider names ${why})` };
  return { named, skipped, text: `no replacement that isn't itself retiring yet: the provider names ${why}, and nothing after it is announced` };
}
