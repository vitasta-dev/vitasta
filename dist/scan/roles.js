/**
 * What a found model place is for, so the report and the fix stay complete while only real breakage fails a check
 * (founder, 19 Nov: "replacement should be in all files"):
 *
 *   breaks        live code, defaults, config: fails a check; the fix swaps it
 *   users-copy    examples, docs, READMEs, samples: annotated, never fails; the fix swaps it (part of a complete fix)
 *   test-asserts  a test that configures or asserts the old value: the fix updates it, or the fix breaks their CI
 *   test-data     a test that only stores or displays the value: listed as cleanup
 *   catalog       lists, enums, price and capability tables: never renamed; the fix retires the entry or adds a hand step
 *   recorded      telemetry, recorded responses, seed data: info only, never edited
 */
import { modelRef } from "../providers.js";
/** Code people copy from: examples, samples, tutorials, cookbooks, notebooks, starter templates, docs snippets */
export function isExamplePath(rel) {
    return (/(^|\/)([\w-]*[-_])?(examples?|samples?|sample[-_]apps?|demos?|cookbooks?|tutorials?|quickstarts?|notebooks?|recipes|starters?|templates?|use[-_]cases?|explorations?|playgrounds?|showcases?|publications?|paper[-_]artifacts[\w-]*)\//i.test(rel) ||
        /(^|\/)(docs?|documentation)\/([\w-]+\/)*(includes|snippets|code[-_]?examples?|source)\//i.test(rel) ||
        // Docs sites (source/includes/…) and component registries users install (shadcn-style registry/<style>/, public/r/)
        /(^|\/)source\/includes\/|(^|\/)registry\/(default|new-york|[\w-]+-style)\/|(^|\/)public\/r\/[^/]+\.json$/i.test(rel) ||
        /\.(ipynb|md|mdx)$/i.test(rel) ||
        /(^|\/)([^/]*[-_.])?(samples?|demos?|examples?)([-_.][^/]*)?\.[a-z]+$/i.test(rel));
}
/** Recorded calls: telemetry and tracing attributes, recorded responses, fixtures, seeds, cassettes */
const RECORDED_LINE = /gen_ai\.|SpanAttribute|\bspan[._(]|ls_model_name|response[_.]?model|respModel|response_metadata|\btotal_(calls|tokens)\b|usage_metadata|llm\.model_name|run_?output/i;
const RECORDED_PATH = /(^|\/)(__fixtures__|__testfixtures__|cassettes|recordings?|snapshots?|__snapshots__|seeds?)\/|(^|\/)seed[-_][^/]*\.[a-z]+$|\.output\.[jt]sx?$/i;
/** v2: data files of saved runs (JSON/JSONL under references/, backfills/, history/, results/, logs/, traces/ …) */
const RECORDED_DATA_FILE = /(^|\/)(references?|backfills?|snapshots?|history|histories|exports?|results?|outputs?|logs?|traces?|runs?|transcripts?|conversations?)\/([^/]+\/)*[^/]+\.(json|jsonl|ndjson)$/i;
/** A line that is mock or stored data in a test: what a mock returns, a fake object, stored rows */
const TEST_DATA_LINE = /mock|return_value|jest\.fn|vi\.fn|\bfake|stub|\.returning|resolvedValue|toEqual\(|toMatchObject\(|toContain\(|monkeypatch|\bpatch\(|profile/i;
/**
 * v2: a name gate in a test: the model name is compared or matched (startswith, includes, `in`, a comparison in an if),
 * not set. An assert/expect against the old value isn't a gate: the fix has to update it (founder, 19 Nov)
 */
const TEST_GATE = /\.(startswith|startsWith|endswith|endsWith|includes)\(|\bif\b[^\n]*(==|!=)|\bin\s+[\w.]*(model|name)\w*\b/;
const ASSERTS = /\bassert\w*\b|\bexpect\(/;
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|fixtures?|__fixtures__|mocks?|__mocks__)\//i;
/** Distinct models per file: past these, a file of model IDs is a catalog (20+), or its plain data entries are (8+) */
const CATALOG_FILE = 20;
const CATALOG_DATA = 8;
/**
 * v2: one model ID mapped to another ("gpt-4o": "openai/gpt-4o", 'claude-x' => 'claude-y'): a translation table
 * between naming schemes, a catalog, not a setting
 */
export function modelToModel(line) {
    for (const m of line.matchAll(/["'`]([^"'`\s]{3,120})["'`]\s*(?::|=>|,)\s*["'`]([^"'`\s]{3,120})["'`]/g)) {
        if (modelRef(m[1]) && modelRef(m[2]))
            return true;
    }
    return false;
}
/** A model ID as the key of a block: { "gpt-4o": { … } }, ['anthropic.claude-…']: { …: a map of model → settings */
const MODEL_KEYED = /^\s*\[?\s*["'`][^"'`]+["'`]\s*\]?\s*:\s*[{[]\s*$/;
export function roleOf(u, distinctInFile = 0) {
    const test = !!u.inTest || TEST_DIR.test(u.file);
    if (u.recorded || (RECORDED_PATH.test(u.file) && !isExamplePath(u.file)) || RECORDED_DATA_FILE.test(u.file) || RECORDED_LINE.test(u.snippet ?? ""))
        return "recorded";
    if (u.listed || MODEL_KEYED.test(u.snippet ?? "") || modelToModel(u.snippet ?? ""))
        return "catalog";
    // Many models in one file: a registry, preset or price table. A real call is never a catalog entry, and in tests
    // only plain data counts (tests name many models in calls and settings)
    if (u.kind !== "sdk" && ((distinctInFile >= CATALOG_FILE && (!test || !u.setting)) || (distinctInFile >= CATALOG_DATA && !u.setting)))
        return "catalog";
    if (u.doc)
        return "users-copy";
    if (test)
        return isExamplePath(u.file) && !TEST_DIR.test(u.file) ? "users-copy" : testRole(u);
    return isExamplePath(u.file) ? "users-copy" : "breaks";
}
/**
 * A test of lookup logic over model IDs: the model goes into a predicate, lookup, price or capability function, or the
 * test file is about costs, prices, capabilities or known models. Renaming the ID there changes what is tested (the
 * expected price, true/false), so it's never edited automatically: a hand step, like a catalog entry.
 */
const LOOKUP_CALL = /\b(is|has|supports?|can|needs?|uses?)[A-Z_]\w*\(|\b(get|find|lookup|resolve)\w*(Definition|Info|Entry|Entries|Cost|Price|Pricing|Limit|Capabilit\w*|Context|Tokens?|Family|Tier|Provider)\w*\(|\b(calculate|estimate|count)\w*(Cost|Price|Tokens?)\w*\(|\bmatch\w*\(/;
const LOOKUP_TEST_FILE = /(cost|price|pricing|known[-_]?models|model[-_.]?(utils|info|registry|catalog|definitions?)|capabilit|tokens?[-_.]?(count|usage)|usage[-_.]?(badge|breakdown))[^/]*$/i;
/** A test that calls or configures with the model (the fix must update it) vs one that only holds it as data */
function testRole(u) {
    if (LOOKUP_CALL.test(u.snippet ?? "") || LOOKUP_TEST_FILE.test(u.file))
        return "test-data";
    if (u.kind === "sdk")
        return "test-asserts";
    const line = u.snippet ?? "";
    if (TEST_GATE.test(line) && !ASSERTS.test(line))
        return "test-data";
    return u.setting && !TEST_DATA_LINE.test(line) ? "test-asserts" : "test-data";
}
export function assignRoles(usages) {
    const distinct = new Map();
    for (const u of usages)
        if (u.model)
            distinct.set(u.file, (distinct.get(u.file) ?? new Set()).add(u.model));
    for (const u of usages)
        u.role = roleOf(u, distinct.get(u.file)?.size ?? 0);
}
/** The usage's role, computed for usages that didn't come through scanRepo (hand-made, older callers) */
export const roleFor = (u) => u.role ?? roleOf(u);
