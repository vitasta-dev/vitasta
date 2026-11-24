/**
 * What a found model place is for, so the report and the fix stay complete while only real breakage fails a check
 *:
 *
 *   breaks        live code, defaults, config: fails a check; the fix swaps it
 *   users-copy    examples, docs, READMEs, samples: annotated, never fails; the fix swaps it (part of a complete fix)
 *   test-asserts  a test that configures or asserts the old value: the fix updates it, or the fix breaks their CI
 *   test-data     a test that only stores or displays the value: listed as cleanup
 *   catalog       lists, enums, price and capability tables: never renamed; the fix retires the entry or adds a hand step
 *   recorded      telemetry, recorded responses, seed data: info only, never edited
 * note a place in a test file: reported apart ("also in
 *                 tests"), never fails a check or counts as a break; `testRole` keeps test-asserts / test-data for
 *                 what a fix does with it
 */
import { modelRef } from "../providers.js";
import { isDataFile, loadedByCode, runtimeConfig, type LoadRefs } from "./dataflow.js";
import type { Usage } from "../types.js";

export type Role = "breaks" | "users-copy" | "test-asserts" | "test-data" | "catalog" | "recorded" | "note";

/** Code people copy from: examples, samples, tutorials, cookbooks, notebooks, starter templates, docs snippets */
export function isExamplePath(rel: string): boolean {
  return (
    /(^|\/)([\w-]*[-_])?(examples?|samples?|sample[-_]apps?|demos?|cookbooks?|tutorials?|quickstarts?|notebooks?|recipes|starters?|templates?|use[-_]cases?|explorations?|playgrounds?|showcases?|publications?|paper[-_]artifacts[\w-]*)\//i.test(rel) ||
    /(^|\/)(docs?|documentation)\/([\w-]+\/)*(includes|snippets|code[-_]?examples?|source)\//i.test(rel) ||
    // Docs sites (source/includes/…) and component registries users install (shadcn-style registry/<style>/, public/r/)
    /(^|\/)source\/includes\/|(^|\/)registry\/(default|new-york|[\w-]+-style)\/|(^|\/)public\/r\/[^/]+\.json$/i.test(rel) ||
    /\.(ipynb|md|mdx)$/i.test(rel) ||
    // v3: files an agent skill ships for people to copy (skills/<name>/assets/), and migration or upgrade guides
    /(^|\/)skills\/([^/]+\/)*assets?\//i.test(rel) ||
    /(^|\/)((migration|upgrade)[-_]?(guides?|notes)|migrating|upgrading)\/|(^|\/)[^/]*(migration|upgrade)[-_ ]?guides?[^/]*$/i.test(rel) && !/(^|\/)(db|database|alembic|prisma|sql)\//i.test(rel) ||
    /(^|\/)([^/]*[-_.])?(samples?|demos?|examples?)([-_.][^/]*)?\.[a-z]+$/i.test(rel) ||
    // v5: code shown to users as snippets (snippets/, call-snippets.ts, code-samples/, integration-scripts/), and code
    // in another language inside a web app's source tree (frontend/src/…/setup.py is text the app shows or serves)
    /(^|\/)([\w-]*[-_])?(snippets?|code[-_]samples?|integration[-_]scripts?)\/|(^|\/)[^/]*[-_.]?snippets?([-_.][^/]*)?\.[a-z]+$/i.test(rel) ||
    /(^|\/)(frontend|web|webapp|client|ui|www)\/(src|public|app)\/([^/]+\/)*[^/]+\.(py|go|rb|java|kt|php|rs|cs|sh)$/i.test(rel)
  );
}

/** Recorded calls: telemetry and tracing attributes, recorded responses, fixtures, seeds, cassettes */
const RECORDED_LINE = /gen_ai\.|SpanAttribute|\bspan[._(]|ls_model_name|response[_.]?model|respModel|response_metadata|\btotal_(calls|tokens)\b|usage_metadata|llm\.model_name|run_?output/i;
const RECORDED_PATH = /(^|\/)(__fixtures__|__testfixtures__|cassettes|recordings?|snapshots?|__snapshots__|seeds?|seeders?|seeding)\/|(^|\/)seed[-_][^/]*\.[a-z]+$|\.output\.[jt]sx?$/i;
/**
 * v3: history, not settings: release notes and changelogs (they name the models a release added), and a static
 * site's data folder (website/_data/*.yml: leaderboards, tables the site renders)
 */
const HISTORY_PATH = /(^|\/)(release[-_ ]?notes?|changelogs?)\/|(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS|RELEASE[-_]?NOTES|RELEASES|WHATS[-_]?NEW)([-_.][\w.-]*)?\.(md|mdx|rst|txt|adoc)$|(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS|RELEASE[-_]?NOTES)$|(^|\/)_data\//i;
/** v3: benchmark and leaderboard data (a data file under or named for a benchmark, a leaderboard, a bench run) */
const BENCH_DATA = /(^|\/|[-_.])(benchmarks?|leaderboards?|bench)([-_.\/]|$)/i;
/** v2: data files of saved runs (JSON/JSONL under references/, backfills/, history/, results/, logs/, traces/ …) */
/** v4: data files under a test-data folder (__data__/, testdata/, test_data/): inputs tests read, recorded */
/**
 * v5: translations. A model name in a locale file (locales/en.json, i18n/zh-CN.yaml, messages.fr.json) is UI text,
 * even though the app loads the file
 */
const I18N_PATH = /(^|\/)(locales?|i18n|l10n|translations?|langs?|languages|intl)\/|(^|\/|[-_.])(en|zh|ja|ko|fr|de|es|it|pt|ru|ar|hi|nl|sv|pl|tr|vi|th|uk|cs|he|fa|bn|ms|da|fi|nb|el|hu|ro|sk|id)([-_][A-Za-z]{2,4})?\.(json|ya?ml|toml|properties)$/;
const TEST_DATA_DIR = /(^|\/)(__data__|testdata|test[-_]data)\//i;
const RECORDED_DATA_FILE = /(^|\/)(references?|backfills?|snapshots?|history|histories|exports?|results?|outputs?|logs?|traces?|runs?|transcripts?|conversations?)\/([^/]+\/)*[^/]+\.(json|jsonl|ndjson)$/i;
/** A line that is mock or stored data in a test: what a mock returns, a fake object, stored rows */
const TEST_DATA_LINE = /mock|return_value|jest\.fn|vi\.fn|\bfake|stub|\.returning|resolvedValue|toEqual\(|toMatchObject\(|toContain\(|monkeypatch|\bpatch\(|profile/i;
/**
 * v2: a name gate in a test: the model name is compared or matched (startswith, includes, `in`, a comparison in an if),
 * not set. An assert/expect against the old value isn't a gate: the fix has to update it
 */
const TEST_GATE = /\.(startswith|startsWith|endswith|endsWith|includes)\(|\bif\b[^\n]*(==|!=)|\bin\s+[\w.]*(model|name)\w*\b/;
const ASSERTS = /\bassert\w*\b|\bexpect\(/;

/** v5: fixture folders by any name (session-fixture/, fixtures-v2/, test-fixtures/) */
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|fixtures?|__fixtures__|mocks?|__mocks__|[\w-]+[-_]fixtures?|fixtures?[-_][\w-]+)\//i;
/**
 * v3: test projects (Foo.IntegrationTests/, Foo.Tests/, e2e-tests/). Tests, but an examples/ folder inside one is
 * still the examples (code-example-tests/…/examples/ are samples their tests run)
 */
const TEST_PROJECT_CASED = /(^|\/)[\w.-]+[-_]Tests?\//;
const TEST_PROJECT = /(^|\/)[\w.-]*(Integration|Unit|Functional|Acceptance|E2E|System|Smoke)Tests?\/|(^|\/)[\w-]+\.Tests?\/|(^|\/)([\w-]+[-_])?(e2e|integration|unit|functional|acceptance|system|smoke|api|ui|component|regression|perf|load|end[-_]to[-_]end|code[-_]example)[-_](tests?|specs?)\//i;
/** v3: test settings files (testsettings.json, test-settings.yaml, appsettings.Test.json) */
const TEST_SETTINGS = /(^|\/)(test[-_.]?settings|test[-_.]?config|appsettings\.(test|testing|integrationtest)s?)[\w.-]*\.(json|ya?ml|toml|ini)$/i;

/** Distinct models per file: past these, a file of model IDs is a catalog (20+), or its plain data entries are (8+) */
const CATALOG_FILE = 20;
const CATALOG_DATA = 8;

/**
 * v2: one model ID mapped to another ("gpt-4o": "openai/gpt-4o", 'claude-x' => 'claude-y'): a translation table
 * between naming schemes, a catalog, not a setting
 */
export function modelToModel(line: string): boolean {
  for (const m of line.matchAll(/["'`]([^"'`\s]{3,120})["'`]\s*(?::|=>|,)\s*["'`]([^"'`\s]{3,120})["'`]/g)) {
    if (modelRef(m[1]) && modelRef(m[2])) return true;
  }
  return false;
}

/** A model ID as the key of a block: { "gpt-4o": { … } }, ['anthropic.claude-…']: { …: a map of model → settings */
const MODEL_KEYED = /^\s*\[?\s*["'`][^"'`]+["'`]\s*\]?\s*:\s*[{[]\s*$/;

/**
 * refs: what the repo's code loads (src/scan/dataflow.ts). Without it (a usage that didn't come through scanRepo),
 * a data file counts as runtime configuration, as before v3.
 */
export function roleOf(u: Usage, distinctInFile = 0, refs?: LoadRefs, testRefs?: LoadRefs): Role {
  const data = u.lang === "config" || (u.lang !== "notebook" && isDataFile(u.file));
  const test = !!u.inTest || TEST_DIR.test(u.file) || TEST_PROJECT.test(u.file) || TEST_PROJECT_CASED.test(u.file) || TEST_SETTINGS.test(u.file);
  // v13: a library's default version, at its use or at the lockfile / manifest row that pins the library: what the app calls
  if (u.apiVersion?.startsWith("default: ") && !test && !isExamplePath(u.file)) return "breaks";
  // v13: a version pin in a folder named after that version (rest/admin/2025-04/…, api/v19.0/…): one generated copy
  // per version, a catalog of versions rather than the one the app uses
  // a SQL seed row whose table the code reads into a provider request is configuration, even in a seeds/ folder
  if (u.sqlSeed === "linked" && !test) return "breaks";
  const pinned = u.apiVersion?.split(": ").pop();
  if (pinned && !u.model && !test && u.file.split("/").slice(0, -1).includes(pinned)) return "catalog";
  if (u.recorded || (RECORDED_PATH.test(u.file) && !isExamplePath(u.file)) || RECORDED_DATA_FILE.test(u.file) || RECORDED_LINE.test(u.snippet ?? "")) return "recorded";
  if (HISTORY_PATH.test(u.file) || (data && (BENCH_DATA.test(u.file) || TEST_DATA_DIR.test(u.file)))) return "recorded";
  if (u.listed || MODEL_KEYED.test(u.snippet ?? "") || modelToModel(u.snippet ?? "")) return "catalog";
  // Data flow: a setting in runtime configuration (weak_model_name: x in a settings registry the code reads) is a
  // setting however many models the file names
  const runtime = data && (!refs || runtimeConfig(u.file, refs));
  const runtimeSetting = runtime && !!u.setting && !test;
  // Many models in one file: a registry, preset or price table. A real call is never a catalog entry, and in tests
  // only plain data counts (tests name many models in calls and settings)
  if (!runtimeSetting && u.kind !== "sdk" && ((distinctInFile >= CATALOG_FILE && (!test || !u.setting)) || (distinctInFile >= CATALOG_DATA && !u.setting))) return "catalog";
  if (u.doc || u.envUnread || u.envShadowed || (data && I18N_PATH.test(u.file))) return "users-copy";
  // a per-environment env template (.env.production.example, .env.local.sample) and any Markdown file (README prose,
  // agent.md files) are copies for users, not what the app runs; a plain.env.example the code
  // reads keys from stays the app's default
  if (/(?:^|\/)\.env\.[\w-]+\.(?:example|sample|template|dist)$|\.mdx?$/i.test(u.file)) return "users-copy";
  if (test) return isExamplePath(u.file) && !TEST_DIR.test(u.file) ? "users-copy" : testRole(u);
  if (isExamplePath(u.file)) return "users-copy";
  // A data file only tests load is test input (v4); one no code here loads and no convention marks as configuration
  // is data. Both are reported, never failing
  if (data && !runtime) return testRefs && loadedByCode(u.file, testRefs) ? "test-data" : "recorded";
  return "breaks";
}

/**
 * A test of lookup logic over model IDs: the model goes into a predicate, lookup, price or capability function, or the
 * test file is about costs, prices, capabilities or known models. Renaming the ID there changes what is tested (the
 * expected price, true/false), so it's never edited automatically: a hand step, like a catalog entry.
 */
const LOOKUP_CALL = /\b(is|has|supports?|can|needs?|uses?)[A-Z_]\w*\(|\b(get|find|lookup|resolve)\w*(Definition|Info|Entry|Entries|Cost|Price|Pricing|Limit|Capabilit\w*|Context|Tokens?|Family|Tier|Provider)\w*\(|\b(calculate|estimate|count)\w*(Cost|Price|Tokens?)\w*\(|\bmatch\w*\(/;
const LOOKUP_TEST_FILE = /(cost|price|pricing|known[-_]?models|model[-_.]?(utils|info|registry|catalog|definitions?)|capabilit|tokens?[-_.]?(count|usage)|usage[-_.]?(badge|breakdown))[^/]*$/i;

/** A test that calls or configures with the model (the fix must update it) vs one that only holds it as data */
function testRole(u: Usage): Role {
  if (LOOKUP_CALL.test(u.snippet ?? "") || LOOKUP_TEST_FILE.test(u.file)) return "test-data";
  // v5: the client is mocked and no assertion names the model: renaming it changes nothing the test checks
  if (u.mocked) return "test-data";
  // v7: a versioned URL a stub or an assertion matches
  if (u.urlAsserted) return "test-asserts";
  if (u.kind === "sdk") return "test-asserts";
  const line = u.snippet ?? "";
  if (TEST_GATE.test(line) && !ASSERTS.test(line)) return "test-data";
  return u.setting && !TEST_DATA_LINE.test(line) ? "test-asserts" : "test-data";
}

export function assignRoles(usages: Usage[], refs?: LoadRefs, testRefs?: LoadRefs): void {
  const distinct = new Map<string, Set<string>>();
  for (const u of usages) if (u.model) distinct.set(u.file, (distinct.get(u.file) ?? new Set()).add(u.model));
  for (const u of usages) {
    const r = roleOf(u, distinct.get(u.file)?.size ?? 0, refs, testRefs);
    // A place in a test file is a note; what kind of test place it is stays for the fix
    if (r === "test-asserts" || r === "test-data") {
      u.role = "note";
      u.testRole = r;
    } else u.role = r;
  }
}

/** A test file in the role sense: test code and test settings, not examples or samples (those are users-copy) */
export function isTestFile(rel: string, inTest: boolean): boolean {
  const test = inTest || TEST_DIR.test(rel) || TEST_PROJECT.test(rel) || TEST_PROJECT_CASED.test(rel) || TEST_SETTINGS.test(rel);
  return test && !(isExamplePath(rel) && !TEST_DIR.test(rel));
}

/** What a fix does with a place: a note's test role (test-asserts, test-data), otherwise its role */
export const fixRoleFor = (u: Usage): Role => {
  const r = roleFor(u);
  return r === "note" ? (u.testRole ?? testRole(u)) : r;
};

/** The usage's role, computed for usages that didn't come through scanRepo (hand-made, older callers) */
export const roleFor = (u: Usage): Role => u.role ?? roleOf(u);

/**
 * ("our job is to give update"): every place is reported; its context says what it is, and its tier
 * whether it needs action. Action: a live request site or default (role breaks, no context, not a test or doc, not
 * gated). Also in your code: catalog entries, dead or unused code, a provider the request site doesn't show, docs and
 * copies for users. Only action findings can fail a check.
 */
export function assignTiers(usages: Usage[]): void {
  for (const u of usages) {
    if (!u.context) {
      if (u.dead) u.context = "dead";
      else if (u.envUnread || u.envShadowed) u.context = "unused";
      else if (u.proxy || u.libmap) u.context = "provider-unresolved";
      else if (u.listed || roleFor(u) === "catalog") u.context = "catalog";
    }
    if (u.context && !u.contextReason) {
      u.contextReason = u.context === "dead" ? "nothing in the repo reaches this code" : u.context === "unused" ? "set here, but the code that sends doesn't read it" : u.context === "provider-unresolved" ? `the request site doesn't show the provider${u.proxy ? ` (it goes to ${u.proxy})` : ""}` : "a model list, table or offered id";
    }
    u.tier = roleFor(u) === "breaks" && !u.context && !u.inTest && !u.doc && !u.gated ? "action" : "also";
  }
}
