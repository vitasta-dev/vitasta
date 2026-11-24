/**
 * v6, second stage (experimental, off by default): "is this a catalog entry?" A tiny logistic regression over
 * structural features of the place, run only on places the rules call breaks. It can turn a place into a catalog
 * entry (a note), never the other way. Features are about shape, not paths or repository names: how many sibling
 * entries share the shape, what fields they carry, the name holding the collection, nesting depth, whether the value
 * sits in a request, call, assignment or return, and how dense model IDs are in the file.
 *
 * Weights ship as JSON (src/data/catalog-model.json), trained on labelled public repos (see CHANGELOG). No runtime
 * dependency, and no code leaves the machine: features are computed from the file text in memory.
 */
import { createRequire } from "node:module";

const MAX_LINES = 400;
const ID_KEY = /^(id|model|model_?id|model_?name|api_?model_?id|provider_?model_?id|upstream_?model\w*|hosted_?id|slug|name|value)$/i;
const CATALOG_FIELD = /^(pricing|prices?|costs?|(input|output|prompt|completion|cache\w*)_?(cost|price)\w*|\w*_cost_per_\w+|\w*per_?million\w*|context_?(window|length|size|tokens)|max_?context\w*|max_?output\w*|max_?input_?tokens|max_?completion_?tokens|max_?tokens|capabilit(y|ies)|(input_?|output_?)?modalit(y|ies)|supports?_?\w+|supported_?\w+|vision|image_?input|knowledge_?cutoff|training_?cutoff|release_?date|tokenizer|limits)$/i;
const DISPLAY_FIELD = /^(label|title|display_?name|nickname|model_?name|description|desc|icon|logo|avatar|emoji|color|badge|tag|tags)$/i;
const REQUEST_FIELD = /^(temperature|top_?p|top_?k|presence_?penalty|frequency_?penalty|messages|contents|input|inputs|prompt|instructions|system|stream|stop|seed|reasoning_?effort|tool_?choice|response_?format|generation_?config)$/i;
const CONNECTION_FIELD = /^(api_?key|api_?base|base_?url|endpoint|enabled?|deployment|api_?version|organization|proxy|timeout|headers)$/i;
const CATALOG_HOLDER = /(models?|model_?list|llms?|providers?|definitions?|registry|catalog|options|choices|available|supported|known|list|entries|table|info)$/i;
const CONFIG_HOLDER = /(presets?|masks?|configs?|settings|defaults?|templates?|params|options_?default|request|body|payload)$/i;
const KEY_AT = /["']?([A-Za-z_$][\w$-]*)["']?\s*:(?!:)/g;
const SHORTHAND_AT = /(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=,|}|$)/g;

export const FEATURES = [
  "bias_free_const", // always 1 (kept so weights line up with names)
  "is_object_value", // the ID is the value of a key in an object or dict
  "key_is_model", // the key is "model" (often a setting) rather than an ID key
  "key_is_id", // id, modelId, apiModelId, name, slug …
  "log_siblings", // log(1 + entries in the parent collection that carry an ID key)
  "siblings_catalog_share", // share of those entries with price, context or capability fields
  "own_catalog_fields", // count of catalog fields in the object and one level down (capped at 5)
  "own_display_fields", // label, title, displayName, icon … (capped at 3)
  "own_request_fields", // temperature, messages … (capped at 3)
  "own_connection_fields", // api key, base URL … (capped at 3)
  "holder_catalog_name", // the variable, export or key holding the collection is named like a list of models
  "holder_config_name", // … named like a preset, config or request
  "depth", // openers between the literal and top level (capped at 6) / 6
  "in_call", // some opener above is a call's argument list
  "in_array", // the nearest collection is an array or list
  "assigned", // x.model = "…", model = "…" (not inside an object)
  "returned", // return "…"
  "file_model_density", // model literals per 100 lines in the file (capped at 20) / 20
  "file_log_models", // log(1 + model places in the file)
  "kind_sdk", // the scanner saw a provider SDK or HTTP call here
  "setting", // the scanner marked it a setting
  "lang_py",
] as const;

type Pos = { line: number; col: number; c: string };

function openerBefore(blanked: string[], line: number, col: number): Pos | undefined {
  let depth = 0;
  for (let i = line, stop = Math.max(0, line - MAX_LINES); i >= stop; i--) {
    const b = blanked[i];
    for (let j = (i === line ? Math.min(col, b.length) : b.length) - 1; j >= 0; j--) {
      const c = b[j];
      if (c === ")" || c === "]" || c === "}") depth++;
      else if (c === "(" || c === "[" || c === "{") {
        if (depth > 0) depth--;
        else return { line: i, col: j, c };
      }
    }
  }
  return undefined;
}

/** Keys at depth 1 (own) and 2 (one level down) of the block opened at `at`, and the depth-2 entries' key sets */
function blockKeys(lines: string[], blanked: string[], at: Pos): { own: string[]; nested: string[]; entries: string[][] } {
  const own: string[] = [];
  const nested: string[] = [];
  const entries: string[][] = [];
  let cur: string[] | undefined;
  let depth = 0;
  for (let i = at.line, stop = Math.min(lines.length - 1, at.line + MAX_LINES); i <= stop; i++) {
    const b = blanked[i];
    const depthAt: number[] = [];
    let done = false;
    for (let j = i === at.line ? at.col : 0; j < b.length && !done; j++) {
      depthAt[j] = depth;
      const c = b[j];
      if (c === "(" || c === "[" || c === "{") {
        depth++;
        if (depth === 2) entries.push((cur = []));
      } else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) done = true;
      }
    }
    for (const re of [KEY_AT, SHORTHAND_AT]) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(lines[i])); ) {
        const k = m.index + m[0].indexOf(m[1]);
        const d = depthAt[k];
        if (d === 1) own.push(m[1]);
        else if (d === 2) (nested.push(m[1]), cur?.push(m[1]));
      }
    }
    if (done) break;
  }
  return { own, nested, entries };
}

/** The name holding a block: `const MODELS = [`, `models: [`, `"providers": {`, `export default [` */
function holderName(lines: string[], at: Pos): string {
  const before = lines[at.line].slice(0, at.col);
  return /["']?([A-Za-z_$][\w$]*)["']?\s*(?::\s*[\w.<>[\]| ]+)?\s*[:=]\s*(?:\w+\s*\(\s*)?$/.exec(before)?.[1] ?? "";
}

export type FileStats = { lines: number; models: number };

export function catalogFeatures(lines: string[], blanked: string[], line: number, col: number, u: { kind?: string; setting?: boolean; lang?: string }, file: FileStats): number[] {
  const f: Record<(typeof FEATURES)[number], number> = Object.fromEntries(FEATURES.map((n) => [n, 0])) as any;
  f.bias_free_const = 1;
  const before = lines[line].slice(0, col);
  const key = /["']?([A-Za-z_$][\w$-]*)["']?\s*:\s*["'`]?$/.exec(before)?.[1];
  f.assigned = !key && /[\w$\].]\s*=\s*["'`]?$/.test(before) && !/[=!<>]=\s*["'`]?$/.test(before) ? 1 : 0;
  f.returned = /\breturn\s+["'`]?$/.test(before) ? 1 : 0;
  // Openers above the literal: depth, calls, holder names
  const chain: Pos[] = [];
  for (let p = openerBefore(blanked, line, col); p && chain.length < 6; p = openerBefore(blanked, p.line, p.col)) chain.push(p);
  f.depth = Math.min(chain.length, 6) / 6;
  f.in_call = chain.some((p) => p.c === "(" && /[\w$\]]\s*$/.test(lines[p.line].slice(0, p.col))) ? 1 : 0;
  const holders = chain.map((p) => holderName(lines, p)).filter(Boolean);
  f.holder_catalog_name = holders.some((h) => CATALOG_HOLDER.test(h) && !CONFIG_HOLDER.test(h)) ? 1 : 0;
  f.holder_config_name = holders.some((h) => CONFIG_HOLDER.test(h)) ? 1 : 0;
  const obj = chain[0];
  if (key && obj && (obj.c === "{" || obj.c === "(")) {
    f.is_object_value = 1;
    f.key_is_model = /^model$/i.test(key) ? 1 : 0;
    f.key_is_id = ID_KEY.test(key) && !f.key_is_model ? 1 : 0;
    const { own, nested } = blockKeys(lines, blanked, obj);
    const all = [...own, ...nested];
    f.own_catalog_fields = Math.min(5, all.filter((k) => CATALOG_FIELD.test(k)).length) / 5;
    f.own_display_fields = Math.min(3, own.filter((k) => DISPLAY_FIELD.test(k)).length) / 3;
    f.own_request_fields = Math.min(3, own.filter((k) => REQUEST_FIELD.test(k)).length) / 3;
    f.own_connection_fields = Math.min(3, own.filter((k) => CONNECTION_FIELD.test(k)).length) / 3;
    const parent = chain[1];
    if (parent) {
      f.in_array = parent.c === "[" ? 1 : 0;
      const sib = blockKeys(lines, blanked, parent).entries.filter((e) => e.some((k) => ID_KEY.test(k)));
      f.log_siblings = Math.log1p(sib.length) / Math.log1p(50);
      f.siblings_catalog_share = sib.length ? sib.filter((e) => e.some((k) => CATALOG_FIELD.test(k))).length / sib.length : 0;
    }
  } else if (obj) f.in_array = obj.c === "[" ? 1 : 0;
  f.file_model_density = Math.min(20, (100 * file.models) / Math.max(1, file.lines)) / 20;
  f.file_log_models = Math.log1p(file.models) / Math.log1p(200);
  f.kind_sdk = u.kind === "sdk" || u.kind === "http" ? 1 : 0;
  f.setting = u.setting ? 1 : 0;
  f.lang_py = u.lang === "py" ? 1 : 0;
  return FEATURES.map((n) => f[n]);
}

type Model = { features: string[]; weights: number[]; intercept: number; threshold: number; trained: string };
let model: Model | null | undefined;
function loadModel(): Model | null {
  if (model !== undefined) return model;
  try {
    const m = createRequire(import.meta.url)("../data/catalog-model.json") as Model;
    model = m.features.length === FEATURES.length && m.features.every((n, i) => n === FEATURES[i]) ? m : null;
  } catch {
    model = null;
  }
  return model;
}

/** Probability that the place is a catalog entry, and whether it passes the shipped threshold; undefined without weights */
export function catalogScore(x: number[]): { p: number; catalog: boolean } | undefined {
  const m = loadModel();
  if (!m) return undefined;
  const z = m.intercept + m.weights.reduce((s, w, i) => s + w * x[i], 0);
  const p = 1 / (1 + Math.exp(-z));
  return { p, catalog: p >= m.threshold };
}
