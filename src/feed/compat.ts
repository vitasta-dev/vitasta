/**
 * What a model rejects or does differently, so a fix that moves code to it doesn't open a broken pull request.
 * Data: <feed>/_compat.json, one entry per model family, each fact with its source and the day it was read.
 *
 *   rejects:   request settings the model returns an error for (temperature on a model that only samples at its
 *              default; a thinking budget on a model that sets thinking by effort). `values` narrows it to some
 *              values of the setting; `action` says whether dropping it is a safe fix ("remove") or a person
 *              has to choose what to send instead ("manual").
 *   behaviour: changes that don't error but can break code reading the response (thinking blocks first).
 *              `pattern` finds code that is likely affected, so the pull request can name the line.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Span, Usage } from "../types.js";

export interface Reject {
  param: string;
  /** Only these values of the setting are rejected (text found inside the passed value), e.g. "budget_tokens" */
  values?: string[];
  /** What the provider answers, e.g. "400 invalid_request_error" */
  error?: string;
  /** What to send instead, in words */
  instead: string;
  /** What leaving it out does, in a few words, for the fix PR's first lines, e.g. "sampling uses the model's defaults" */
  effect?: string;
  action: "remove" | "manual";
}

export interface Behaviour {
  note: string;
  /** A regex over the file's text for code this likely breaks, e.g. content\[0\]\.text */
  pattern?: string;
}

/**
 * An SDK that handles the model wrongly below some version, so moving code to the model needs that version first.
 * Only for an effect read in the SDK's own code or notes, not for every release.
 */
export interface SdkMin {
  ecosystem: "npm" | "pypi";
  package: string;
  /** What the code imports, when it isn't the package name (Python: google-genai → google.genai) */
  import?: string;
  /** The first good version of each release line, e.g. ["2.0.107", "3.0.125", "4.0.67"] */
  min: string[];
  /** Calls that pass any of these settings aren't affected (an explicit maxOutputTokens overrides the SDK's cap) */
  unlessParams?: string[];
  /** What goes wrong with an older version, in a sentence */
  effect: string;
  /** The other way out, in words (e.g. "pass maxOutputTokens on the call") */
  instead?: string;
  source: string;
  /** How the effect was checked */
  note?: string;
  checked: string;
}

export interface ModelCompat {
  provider: string;
  /** Model IDs or prefixes ending in "*" */
  models: string[];
  rejects: Reject[];
  behaviour?: Behaviour[];
  sdk?: SdkMin[];
  source: string;
  checked: string;
}

export async function loadCompat(feedDir: string): Promise<ModelCompat[]> {
  try {
    const data = JSON.parse(await readFile(join(feedDir, "_compat.json"), "utf8")) as { models?: ModelCompat[] };
    return Array.isArray(data.models) ? data.models : [];
  } catch {
    return [];
  }
}

export function compatFor(list: ModelCompat[], provider: string, model: string): ModelCompat | undefined {
  return list.find((c) => c.provider === provider && c.models.some((m) => (m.endsWith("*") ? model.startsWith(m.slice(0, -1)) : m === model)));
}

export interface Conflict {
  reject: Reject;
  /** Where the setting is passed in the file (to remove it), when the scanner found its span */
  span?: Span;
}

/** Settings this call passes that the model rejects. `text` is the call's file. */
export function conflictsAt(c: ModelCompat, usage: Pick<Usage, "params" | "paramSpans">, text: string): Conflict[] {
  const out: Conflict[] = [];
  for (const r of c.rejects) {
    if (!usage.params?.includes(r.param)) continue;
    const span = usage.paramSpans?.[r.param];
    if (r.values?.length) {
      // Without the passed text we can't tell which value it is: say so rather than guess
      if (!span) {
        out.push({ reject: r });
        continue;
      }
      const passed = text.slice(span.start, span.end);
      if (!r.values.some((v) => passed.includes(v))) continue;
    }
    out.push({ reject: r, span });
  }
  return out;
}

/** Lines in the file that a behaviour change likely affects: [note, line numbers] */
export function behaviourHits(c: ModelCompat, text: string): { note: string; lines: number[] }[] {
  const out: { note: string; lines: number[] }[] = [];
  for (const b of c.behaviour ?? []) {
    if (!b.pattern) continue;
    let re: RegExp;
    try {
      re = new RegExp(b.pattern, "g");
    } catch {
      continue;
    }
    const lines = new Set<number>();
    for (const m of text.matchAll(re)) {
      lines.add(text.slice(0, m.index).split("\n").length);
      if (lines.size >= 10) break;
    }
    if (lines.size) out.push({ note: b.note, lines: [...lines] });
  }
  return out;
}
