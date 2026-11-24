import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { PROVIDERS, matchUrl, mentionsRouter, modelRef, urlVersionOf } from "../providers.js";
import { alwaysCounts, configKeySetting, isSettingName } from "./context.js";
import { DATA_OWNER, NAME_LIST } from "./shapes.js";
import type { Usage } from "../types.js";

/**
 * Model IDs often live outside code: YAML/JSON/TOML config, .env files, and Jupyter notebook code cells.
 * We don't parse these as code; we only look for tokens that are model IDs. Every hit is "possible".
 */

const CONFIG_EXT = /\.(ya?ml|json|toml|properties|ini|cfg|conf)$/i;
// v13: also env.example / env.sample / env.template (no leading dot)
const ENV_FILE = /^\.env(\..+)?$|\.env$|^env\.(example|sample|template|dist|local|development|production)$/;
const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Pipfile.lock", "composer.lock", "tsconfig.json", "jsconfig.json"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "venv", ".venv", "__pycache__", "target", ".gradle", "vendor", "coverage"]);
const MAX_BYTES = 2_000_000;
const TOKEN = /[A-Za-z0-9][\w.:@\/-]*[\w]/g;
/** Data written by programs, not configuration: results, outputs, recorded responses, logs, test recordings */
const DATA_PATH = /(^|\/|[-_.])(results?|outputs?|responses?|logs?|traces?|predictions?|cassettes?|recordings?|snapshots?|golden|expected|transcripts?|generations?|benchmarks?|leaderboards?|evals?|runs?|corpus|corpora|holdout|datasets?)([-_.\/]|$)/i;
/** Keys only an API response has: a "model" near two of these is a recorded response, not a setting */
const RESPONSE_KEY = /["']?(choices|usage|created|system_fingerprint|finish_reason|stop_reason|prompt_tokens|completion_tokens|input_tokens|output_tokens|usage_metadata|usageMetadata|candidates|modelVersion|logprobs)["']?\s*:/;

import { versionConstantUsages, versionSetterUsages } from "./versions.js";
import { urlModelConfigUsages } from "./urlmodels.js";
import { sdkClientUsages } from "./sdkclients.js";

export async function scanConfigAndNotebooks(root: string): Promise<Usage[]> {
  const out: Usage[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
        continue;
      }
      if (!e.isFile() || SKIP_FILES.has(e.name)) continue;
      const isNotebook = e.name.endsWith(".ipynb");
      if (!isNotebook && !CONFIG_EXT.test(e.name) && !ENV_FILE.test(e.name)) continue;
      if ((await stat(full)).size > MAX_BYTES) continue;
      const text = await readFile(full, "utf8").catch(() => "");
      const rel = relative(root, full);
      // A knowledge base of retirements (dates, replacements) names models as data
      if (!isNotebook && retirementData(text)) continue;
      // An OpenAPI/Swagger spec documents request shapes; its model values are examples
      if (!isNotebook && /^[ \t]*["']?(openapi|swagger)["']?\s*:\s*["']?\d/m.test(text.slice(0, 2000))) continue;
      // JSON/YAML a program wrote (results, recorded responses, logs) holds model names as data
      if (!isNotebook && !ENV_FILE.test(e.name) && DATA_PATH.test(rel.replace(/\.[^./]+$/, ""))) continue;
      const refs = isNotebook ? notebookRefs(rel, text) : textRefs(rel, text, "config");
      out.push(...refs);
      // v7: API versions in configuration (name: FACEBOOK_API_VERSION … value: 'v18.0')
      if (!isNotebook) {
        const consts = versionConstantUsages(rel, "config", text, refs);
        out.push(...consts, ...configUrlVersions(rel, text, [...refs, ...consts]), ...urlModelConfigUsages(rel, text, refs));
        // Framework settings a provider request carries (spring.ai.anthropic.chat.options.temperature)
        out.push(...sdkClientUsages(rel, "config", text));
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * v14: versioned provider URLs written in configuration (authorization_url: https://www.facebook.com/v22.0/dialog/oauth,
 * a provider catalog's token URLs): the URL itself names the API, so no other evidence is needed
 */
export function configUrlVersions(file: string, text: string, found: Usage[]): Usage[] {
  if (text.length > MAX_BYTES) return [];
  const have = new Set(found.filter((u) => u.apiVersion).map((u) => `${u.line}|${u.apiVersion!.split(": ").pop()}`));
  const out: Usage[] = [];
  text.split("\n").forEach((l, i) => {
    if (l.length > 2000 || /^\s*(#|\/\/|;)/.test(l)) return;
    for (const m of l.matchAll(/https?:\/\/[^\s"'<>`\\,)]+/g)) {
      const probe = m[0] + "/";
      const hit = matchUrl(probe);
      let provider = hit?.provider.urlVersion ? hit.provider : undefined;
      if (!hit) {
        const host = /^https?:\/\/([^/:?#]+)/i.exec(m[0])?.[1]?.toLowerCase();
        provider = host ? PROVIDERS.find((p) => p.urlVersion && p.versionOnlyHosts?.includes(host)) : undefined;
      }
      const version = provider && urlVersionOf(provider, probe);
      if (!provider || !version || have.has(`${i + 1}|${version}`)) continue;
      have.add(`${i + 1}|${version}`);
      out.push({ provider: provider.id, kind: "version-pin", lang: "config", file, line: i + 1, apiVersion: `url: ${version}`, confidence: "likely", snippet: l.trim().slice(0, 200) });
    }
  });
  return out;
}

function textRefs(file: string, text: string, lang: "config" | "notebook", lineOffset = 0, lineMap?: number[]): Usage[] {
  const out: Usage[] = [];
  const lines = text.split("\n");
  const routed = mentionsRouter(text);
  let lineStart = 0;
  lines.forEach((line, i) => {
    const offset = lineStart;
    lineStart += line.length + 1;
    // A commented-out line (.env, YAML, TOML, INI, JSONC, notebook code) is not a setting
    if (/^\s*(#|\/\/|;)/.test(line)) return;
    // a placeholder's default (${LLM_MODEL:gpt-4.1}) is read as the value: its opener and closer become spaces
    const scan = line.replace(/\$\{[\w.\-\[\]]+:-?([^{}$]*)\}/g, (m0, d) => " ".repeat(m0.length - d.length - 1) + d + " ");
    for (const m of scan.matchAll(TOKEN)) {
      const tok = m[0];
      const ref = modelRef(tok, routed);
      if (!ref) continue;
      // Only model settings count: model: x, MODEL_ID=x, "model": "x", or an item in a list under a model key. A
      // cloud-form ID counts anywhere except as a key ("claude-…@…": 200000)
      const isKey = /^["']?\s*:/.test(line.slice((m.index ?? 0) + tok.length));
      if (lang === "config" && recordedResponse(lines, i)) continue;
      // (a placeholder's default, model: ${OPENAI_MODEL:gpt-4o-mini}, sits after its opener: the key is still model)
      const before = line.slice(0, m.index ?? 0).replace(/\$\{[\w.\-\[\]]+:-?$/, "");
      const strict = settingAt(lines, i, before, lang) ?? (alwaysCounts(ref.model) && !isKey ? "setting" : undefined);
      // Otherwise an item in a list of models, or a value in a map of models, counts if the repo uses the provider
      //
      const kind = strict ?? (lang === "config" && !isKey && (inModelBlock(lines, i, routed) || inEntryTable(lines, i, line.slice(0, m.index ?? 0), routed)) ? "listed" : undefined) ?? "catalog";
      out.push({
        ...(kind === "listed" || kind === "catalog" ? { listed: true } : {}), ...(kind === "setting" ? { setting: true } : {}),
        ...(kind === "catalog" ? { context: "catalog" as const, contextReason: "a model id outside a request or setting (a list, table or text)" } : {}),
        ...(strict ? {} : { weak: true }),
        provider: ref.provider.id, kind: "model-ref", lang, file,
        line: lineMap ? lineMap[i] : i + 1 + lineOffset,
        model: ref.model, confidence: "possible", snippet: line.trim().slice(0, 200), ...(ref.host ? { host: ref.host } : {}),
        // Only plain config files can be edited by offset (notebook cells are JSON-escaped inside the file), and a
        // prefixed ID ("anthropic/claude-x") isn't rewritten: the replacement has no prefix
        modelSpan: lang === "config" && !ref.prefixed ? { start: offset + (m.index ?? 0), end: offset + (m.index ?? 0) + tok.length, kind: "bare" } : undefined,
      });
    }
  });
  return out;
}

/** Only code cells; line numbers point at the line inside the .ipynb JSON so editors can jump there. */
function notebookRefs(file: string, json: string): Usage[] {
  let nb: { cells?: { cell_type?: string; source?: string | string[] }[] };
  try {
    nb = JSON.parse(json);
  } catch {
    return [];
  }
  const jsonLines = json.split("\n");
  const out: Usage[] = [];
  let searchFrom = 0;
  for (const cell of nb.cells ?? []) {
    const src = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
    if (cell.cell_type !== "code" || !src) continue;
    const cellLines = src.split("\n");
    // Map each cell line to its line in the raw JSON (best effort: first match after the previous one)
    const map: number[] = cellLines.map((l) => {
      const needle = JSON.stringify(l).slice(1, -1).slice(0, 60);
      if (!needle.trim()) return searchFrom + 1;
      // Bounded look-ahead: a miss must not rescan the rest of a large notebook (quadratic on crafted files)
      for (let j = searchFrom; j < Math.min(jsonLines.length, searchFrom + 400); j++) {
        if (jsonLines[j].includes(needle)) {
          searchFrom = j;
          return j + 1;
        }
      }
      return searchFrom + 1;
    });
    const refs = textRefs(file, src, "notebook", 0, map);
    out.push(...refs);
    // v15: API versions in code cells too (GraphAPI(token, version='2.7'), versioned URLs), on the notebook's lines
    const vs = [...versionSetterUsages(file, "notebook", src, []), ...configUrlVersions(file, src, [])];
    for (const u of vs) out.push({ ...u, lang: "notebook", line: map[u.line - 1] ?? u.line });
  }
  return out;
}

/** Keys a record about a model's retirement has: retired_on, deprecation_date, shutdown, sunset, replacement */
const RETIREMENT_KEY = /^[ \t]*-?\s*["']?(retire\w*|deprecat\w*|shut_?down\w*|sunset\w*|end_of_life|eol(_date)?|replace(ment|d_by)\w*|successor|migrat(e|ion)_to)["']?\s*:/gim;

/** A retirement key with a date: retired_on: 2026-01-05, "shutdown_date": "2026-06-30" */
const DATED_RETIREMENT = /^[ \t]*-?\s*["']?(retire\w*|deprecat\w*|shut_?down\w*|sunset\w*|end_of_life|eol(_date)?)["']?\s*:\s*["']?\d{4}-\d{2}(-\d{2})?/im;

/**
 * At least two different retirement keys, one of them dated: a file of retirement records, not a config. (A
 * settings schema with "deprecated": true on some fields isn't one.)
 */
function retirementData(text: string): boolean {
  if (!DATED_RETIREMENT.test(text)) return false;
  const keys = new Set([...text.matchAll(RETIREMENT_KEY)].map((m) => m[1].toLowerCase().replace(/_?(date|on|at)$/, "").slice(0, 7)));
  return keys.size >= 2;
}

/** Two or more response-only keys near this line: a recorded API response */
function recordedResponse(lines: string[], i: number): boolean {
  let hits = 0;
  for (let j = Math.max(0, i - 12); j < Math.min(lines.length, i + 13); j++) if (RESPONSE_KEY.test(lines[j]) && ++hits >= 2) return true;
  return false;
}

const isModel = (t: string, routed: boolean) => !!modelRef(t.replace(/^["']|["',]+$/g, ""), routed);
const valueOf = (l: string) => {
  const m = /^\s*(?:-\s*|["']?[\w.\-]+["']?\s*[:=]\s*)?["']?([A-Za-z0-9][\w.:@\/-]*[\w])["']?\s*,?\s*(#.*)?$/.exec(l);
  return m?.[1];
};

/**
 * A list item or a map value in a block (same indentation) that holds at least two model IDs, under a key that
 * isn't about prices, limits or capabilities: YAML "- gpt-4o" lists, JSON string arrays, "fast: gpt-4o-mini" maps,
 * flow lists "[gpt-4o, o3]".
 */
function inModelBlock(lines: string[], i: number, routed: boolean): boolean {
  const line = lines[i];
  const flow = /\[([^\]]*)\]/.exec(line);
  if (flow && flow[1].split(",").filter((x) => isModel(x.trim(), routed)).length >= 2) return !DATA_OWNER.test(line.slice(0, flow.index));
  const indent = /^\s*/.exec(line)![0].length;
  const sameBlock = (l: string) => l.trim() !== "" && /^\s*/.exec(l)![0].length === indent;
  let n = 0;
  let owner = "";
  let settingKey = false;
  const look = (l: string) => {
    const v = valueOf(l);
    if (v && isModel(v, routed)) n++;
    const k = /^\s*["']?([\w.\-]+)["']?\s*[:=]/.exec(l)?.[1];
    if (k && isSettingName(k)) settingKey = true;
  };
  // Within 200 lines either way: enough to tell a list of models, and linear on very long lists (review F2)
  for (let j = i; j >= Math.max(0, i - 200) && sameBlock(lines[j]); j--) look(lines[j]);
  for (let j = i + 1; j < Math.min(lines.length, i + 201) && sameBlock(lines[j]); j++) look(lines[j]);
  // An object with its own model key ({model: x, name: y}) is one settings object, not a map of models
  if (settingKey && !/^\s*-/.test(line)) return false;
  for (let j = i - 1; j >= Math.max(0, i - 2000); j--) {
    const l = lines[j];
    if (l.trim() && /^\s*/.exec(l)![0].length < indent) {
      owner = /["']?([\w.\-]+)["']?\s*[:=[{]/.exec(l)?.[1] ?? "";
      break;
    }
  }
  const listItem = /^\s*-|^\s*["'][^"']*["']\s*,?\s*$/.test(line);
  return n >= 2 && !DATA_OWNER.test(owner) && !(listItem && NAME_LIST.test(owner));
}

/**
 * A registry of entries, one model per entry: the same key ("id", "name", "slug") at the same indentation in
 * neighbouring entries also holds a model ID. registry.json [{ "id": "claude-…", … }, { "id": "gpt-…", … }]
 */
function inEntryTable(lines: string[], i: number, before: string, routed: boolean): boolean {
  // the key right before this value, wherever it sits on the line ("id": "claude-…" inside { … } too)
  const key = /["']?([\w.\-]+)["']?\s*[:=]\s*["']?$/.exec(before)?.[1];
  if (!key || DATA_OWNER.test(key) || NAME_LIST.test(key)) return false;
  const indent = /^\s*/.exec(lines[i])![0].length;
  const same = new RegExp(`["']?${key.replace(/[.\-]/g, "\\$&")}["']?\\s*[:=]\\s*["']?([A-Za-z0-9][\\w.:@/-]*[\\w])`);
  for (let j = Math.max(0, i - 80); j < Math.min(lines.length, i + 81); j++) {
    if (j === i || /^\s*/.exec(lines[j])![0].length !== indent) continue;
    const m = same.exec(lines[j]);
    if (m && isModel(m[1], routed)) return true;
  }
  return false;
}

export function isConfigName(name: string): boolean {
  return CONFIG_EXT.test(basename(name)) || ENV_FILE.test(basename(name));
}

/**
 * Config: the key on this line is model-named, or this is a "- item" in a list under a model-named key.
 * Notebook code cells are Python: model="x", MODEL = "x", model: "x".
 */
/** Is the token a model setting ("setting"), an item in a list under a model-named key ("listed"), or neither? */
function settingAt(lines: string[], i: number, before: string, lang: "config" | "notebook"): "setting" | "listed" | undefined {
  if (lang === "notebook") return /(\w*model\w*)\s*[:=]\s*["']$/i.test(before) && isSettingName(/(\w*model\w*)\s*[:=]\s*["']$/i.exec(before)![1]) ? "setting" : undefined;
  if (configKeySetting(before)) return "setting";
  const item = /^(\s*)-\s*["']?$/.exec(before);
  if (!item) return undefined;
  const indent = item[1].length;
  for (let j = i - 1; j >= 0 && j >= i - 200; j--) {
    const m = /^(\s*)["']?([\w.\-]+)["']?\s*:\s*$/.exec(lines[j]);
    if (m && m[1].length < indent + 1) return isSettingName(m[2]) ? "listed" : undefined;
    if (/^\S/.test(lines[j]) && !/^\s*-/.test(lines[j])) return undefined;
  }
  return undefined;
}
