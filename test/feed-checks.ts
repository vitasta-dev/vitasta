/**
 * Checks that hold the scanner to what the feed lists. Run blocking on the frozen test feed (lookup-privacy,
 * partner-models) and as a non-blocking report on the live feed (feed-drift); see test/feed-data.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { catalogLike } from "../src/feed/lookup.js";
import { modelProvider, normalizeModel } from "../src/providers.js";
import type { ChangeRecord } from "../src/types.js";

/**
 * Which records a check covers. "approved": records a person approved. A pending record (new, not reviewed yet) may
 * still be wrong (an extractor once read a service tier as a model ID), so it never blocks; the drift report lists
 * every record, pending ones marked.
 */
export type Scope = "approved" | "all";
const records = (dir: string, file: string, scope: Scope) =>
  (JSON.parse(readFileSync(resolve(dir, file), "utf8")) as (ChangeRecord & { pending?: boolean })[]).filter((r) => scope === "all" || !r.pending);
const tag = (r: { pending?: boolean }) => (r.pending ? " (pending)" : "");
const feedFiles = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("_")).sort();

/** Model IDs the lookup wouldn't send because a word isn't in src/data/model-words.json ("file model") */
export function modelWordGaps(dir: string, scope: Scope): string[] {
  const missed: string[] = [];
  for (const f of feedFiles(dir)) {
    for (const r of records(dir, f, scope)) for (const m of r.selector.models ?? []) if (!m.includes("*") && !catalogLike(m)) missed.push(`${f} ${m}${tag(r)}`);
  }
  return missed;
}

/** Azure and Bedrock model IDs the scanner doesn't know, or knows under another provider ("file provider model") */
export function partnerModelGaps(dir: string, scope: Scope): string[] {
  const missed: string[] = [];
  for (const file of ["azure.json", "bedrock.json"]) {
    for (const r of records(dir, file, scope)) {
      for (const m of r.selector.models ?? []) {
        if (m.includes("*") || m === "model-router") continue; // Azure's "model-router" is too common a word to look for
        const p = modelProvider(normalizeModel(m));
        if (p?.id !== r.provider) missed.push(`${file} ${r.provider} ${m}${p ? ` (found as ${p.id})` : ""}${tag(r)}`);
      }
    }
  }
  return missed;
}
