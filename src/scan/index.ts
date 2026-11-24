import { providerOfHost } from "../providers.js";
import { redactSecrets } from "../redact.js";
import { readFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ignored, loadRepoConfig, type RepoConfig } from "../config.js";
import { PROVIDERS, hostOfModel, isAiProvider, providerById, partnerOnlyHost, providersVersion, withProviders } from "../providers.js";
import type { ApiMap, Lang, SdkDependency, Usage } from "../types.js";
import { analyzeGeneric } from "./generic.js";
import { scanConfigAndNotebooks } from "./config.js";
import { listDocFiles, listLoaderFiles, listManifests, listSourceFiles, listViewFiles } from "./files.js";
import { markdownCode, pythonStringCode, templateCode, viewCode } from "./embedded.js";
import { assignRoles } from "./roles.js";
import { collectLoadRefs, emptyRefs, isDataFile, runtimeConfig } from "./dataflow.js";
import { catalogFeatures, catalogScore } from "./catalog-model.js";
import { blankLine, catalogAt, collectSelectedNames, listHolderAt, comparedAt, inResponseSchema, recordedBy } from "./enclosing.js";
import { analyzeJava } from "./java.js";
import { analyzeJs, collectExports, stripExt, type ExportedClients } from "./js.js";
import { readSdkDependencies } from "./manifest.js";
import { linesOf, parse, parseLoaded, preload, type Tree } from "./parser.js";
import { urlVersionUsages } from "./urls.js";
import { urlModelUsages } from "./urlmodels.js";
import { firstVersionDefaults, importedVia, setterModuleUsers, versionConstantUsages, versionSetterUsages, versionVariableUsages } from "./versions.js";
import { rubySdkUsages } from "./rbsdk.js";
import { phpSdkUsages, phpWrapperCallUsages, type PhpWrapper } from "./phpsdk.js";
import { typedSdkUsages } from "./typedsdk.js";
import { sdkClientUsages } from "./sdkclients.js";
import { fluentUsages } from "./fluent.js";
import { baseBindings, baseClientUsages, hostVariableUsages } from "./hostvars.js";
import { pythonWrapperUsages } from "./pywrap.js";
import { aiSdkUsages } from "./aisdk.js";
import { regionUsages, requestBodyUsages } from "./bodies.js";
import { libraryDefaultUsages } from "./libdefaults.js";
import { applyAiSdkSampling } from "./aisdkreleases.js";
import { applyLibrarySampling, librarySentUsages } from "./libsampling.js";
import { callShapeUsages, vocabUsages } from "./vocab.js";
import { rubyClientUsages } from "./rbclients.js";
import { phpClientUsages } from "./phpclients.js";
import { phpPostedArrayUsages } from "./phpbody.js";
import { assignTiers } from "./roles.js";
import { markGatedSettings } from "./gated.js";
import { markDeadCode } from "./deadcode.js";
import { azureOpenAiUsages } from "./azureopenai.js";
import { sdkNamespaceUsages } from "./sdknamespace.js";
import { baseRelUsages } from "./baserel.js";
import { markEnvDefaults } from "./envdefaults.js";
import { goTemplateUsages } from "./gotemplates.js";
import { sqlSeedUsages } from "./sqlseeds.js";
import { springConfigValues } from "./springcfg.js";
import { marketingByPaths } from "./marketingpaths.js";
import { docPathUsages } from "./docpaths.js";
import { costGuard } from "./costguard.js";
import { addUrlConstantLines } from "./urlconstlines.js";
import { isSdkSource } from "./sdkcode.js";
import { rubyHashBodyUsages } from "./rbhashbody.js";
import { autoMapUsages } from "./automap.js";
import { flowUsages } from "./flow.js";
import { mastraUsages } from "./mastra.js";
import { claudeConfigUsages, namedProviderCallUsages, promptObjectUsages } from "./modelconfigs.js";
import { pythonSdkChainUsages } from "./pysdkchains.js";
import { rubySchemaBodyUsages } from "./rbschema.js";
import { endpointClassUsages } from "./endpointclasses.js";
import { pathConstantUsages } from "./pathconsts.js";
import { goStructBodyUsages } from "./gostruct.js";
import { goMapBodyUsages } from "./gomapbody.js";
import { formBodyUsages } from "./formbody.js";
import { modelConstantUsages } from "./modelconsts.js";
import { libraryVersionConstUsages } from "./libversion.js";
import { wrapperPathUsages } from "./wrapperpaths.js";
import { phpConfigParamUsages, phpConfigReadUsages } from "./phpconfig.js";
import { compatibleHosts, fileOfVendor } from "./vendors.js";
import { pythonProviderUsages } from "./pyprovider.js";
import { provenUse, repoEvidence } from "./evidence.js";
import { placeOnPlatforms } from "./platform.js";
import { analyzePy } from "./py.js";
import { CallMap, indexFile, localsFor, modulePaths, traceAiSdkWrappers, traceParamCalls, traceWrapperCalls, type FileIndex } from "./callmap.js";
import { gatewayClaudeUsages } from "./gateways.js";
import { constValueUsages } from "./constvals.js";
import { phpValueUsages } from "./phpvals.js";
import { goValueUsages } from "./govals.js";
import { collectGarbage } from "./gc.js";
import { transportUsages } from "./transports.js";
import { libraryForwardUsages } from "./libforward.js";
import { ScanCache, blobHash, fingerprint, withSnippets } from "./scancache.js";
import { createHash } from "node:crypto";

export interface AnalyzeInput {
  rel: string;
  abs: string;
  lang: Lang;
  source: string;
  tree: Tree;
  exported: ExportedClients;
}
export type Analyzer = (input: AnalyzeInput) => Usage[];

/**
 * One analyzer per language. JS/TS, Python and Java follow SDK clients into calls; Go, Ruby, PHP and C# get the
 * string-level analysis (URLs, version headers, model settings). Adding a language = a grammar + an entry here.
 */
export const ANALYZERS: Partial<Record<Lang, Analyzer>> = {
  ts: (i) => analyzeJs(i.rel, i.abs, i.lang as "ts", i.source, i.tree, i.exported),
  js: (i) => analyzeJs(i.rel, i.abs, i.lang as "js", i.source, i.tree, i.exported),
  py: (i) => analyzePy(i.rel, i.source, i.tree),
  java: (i) => analyzeJava(i.rel, i.source, i.tree),
  go: (i) => analyzeGeneric(i.rel, i.lang, i.source, i.tree),
  rb: (i) => analyzeGeneric(i.rel, i.lang, i.source, i.tree),
  php: (i) => analyzeGeneric(i.rel, i.lang, i.source, i.tree),
  cs: (i) => analyzeGeneric(i.rel, i.lang, i.source, i.tree),
};

export function registerAnalyzer(lang: Lang, analyzer: Analyzer): void {
  ANALYZERS[lang] = analyzer;
}

/** Cheap skip for files that can't mention any provider: built from every registered provider, so new ones count. */
let PREFILTER: { version: number; re: RegExp } | undefined;
/** Leading literal text of each top-level alternative of a model pattern, 4+ characters ("gpt-", "tts-1", "dall-e-") */
export function literalPrefixes(re: RegExp): string[] {
  const src = re.source.replace(/^\^\(?/, "").replace(/\)?\$$/, "");
  const alts: string[] = [];
  let depth = 0, cur = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { cur += c + (src[i + 1] ?? ""); i++; continue; }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "|" && depth === 0) { alts.push(cur); cur = ""; continue; }
    cur += c;
  }
  alts.push(cur);
  const out: string[] = [];
  for (const a of alts) {
    const lit = /^[A-Za-z0-9-]*/.exec(a)![0];
    // A literal followed by "?" isn't required: drop its last character
    const head = a[lit.length] === "?" ? lit.slice(0, -1) : lit;
    // With a dash or digit only: plain words (models, command) would let nearly every file through
    if (head.length >= 4 && /[-\d]/.test(head)) out.push(head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  return out;
}

function prefilter(): RegExp {
  if (PREFILTER?.version === providersVersion) return PREFILTER.re;
  const words = new Set(["claude-", "gpt-", "gemini", "genai", "vertexai", "bedrock", "imagen", "veo-", "bison", "gecko", "octokit", "\\bo[1-9]\\b"]);
  for (const p of PROVIDERS) {
    words.add(p.id);
    for (const h of p.hosts) words.add(h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    for (const list of Object.values(p.packages)) for (const pkg of list ?? []) words.add(pkg.split(/[/:]/).pop()!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    for (const k of p.keywords ?? []) words.add(k);
    // v7: a file that names the provider's product (WHATSAPP_API_VERSION, STOREFRONT_API_VERSION) may hold a version
    if (p.versionEvidence) words.add(`(?:${p.versionEvidence.source})`);
    for (const r of p.resourceIds ?? []) words.add(r.pattern.source.replace(/^\^|\$$/g, ""));
    // The literal start of each model-ID family in the provider's pattern (tts-1, whisper-1, dall-e-, text-embedding-):
    // a file that only names such a model still gets looked at
    for (const w of literalPrefixes(p.modelPattern)) words.add(w);
  }
  PREFILTER = { version: providersVersion, re: new RegExp([...words].join("|"), "i") };
  return PREFILTER.re;
}

/** Tests, examples and fixtures still matter, but rank below production code. */
export function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__|spec|specs|e2e|fixtures?|__fixtures__|__mocks__|mocks?|fakes?|stubs?|cassettes|testing|test[-_]?utils?|testdata|test[-_]data|__data__|test[-_]?fixtures?|examples?|samples?|demos?|[\w-]+[-_]fixtures?|seeders?)\//i.test(rel) ||
    // sampleTraces.ts, mockData.js, fakeUsers.py: camelCase sample and mock data files
    /(^|\/)(sample|mock|fake|dummy|demo|seed|fixture)[A-Z][^/]*\.[a-z]+$/.test(rel) ||
    /\.(test|spec|mock|stories|(v|e2e|it|int|unit|integ|vi|jest|pw)(test|spec))\.[cm]?[jt]sx?$/.test(rel) ||
    /_test\.go$|(Test|Tests|IT|Spec)\.(java|kt|cs)$|_spec\.rb$|(^|\/)test_[^/]*\.rb$|Test\.php$/.test(rel) ||
    // sample, seed, demo, mock and recorded-session data files outside test folders: sample_dataset.ts, seed-demo.ts
    // (a code file is a test only by its language's own naming, above: channel-test.go is Go code, not a test; the
    // words test / spec anywhere in a name count only for data files)
    /(^|\/)([^/]*[-_.])?(mocks?|fakes?|stubs?|dummy|fixtures?|samples?|seeds?|demos?|examples?|smoke|typecheck(ing)?)([-_.][^/]*)?\.[a-z]+$/i.test(rel) ||
    /(^|\/)([^/]*[-_.])?(tests?|specs?)([-_.][^/]*)?\.(?!(?:go|java|kt|kts|scala|cs|py|rb|php|[cm]?[jt]sx?|swift|rs|c|cc|cpp|h|hpp)$)[a-z]+$/i.test(rel) ||
    /_test\.rb$/.test(rel) ||
    /(^|\/)typecheck(ing)?\//i.test(rel) ||
    // .NET-style sample and demo projects (Sample.Web/, MyApp.Samples/, MyApp.Demo/): dotted names only, so a word
    // that merely starts with demo (DemographicsService/) isn't one
    /(^|\/)(?:[\w-]+\.)?(?:Samples?|Examples?|Demos?)(?:\.[\w.-]+)?\//.test(rel) && /(^|\/)(?:[\w-]+\.(?:Samples?|Examples?|Demos?)|(?:Samples?|Examples?|Demos?)\.[\w.-]+)\//.test(rel) ||
    // .NET-style test projects named with a capitalised suffix: OpenAI-DotNet-Tests/, Foo_Tests/ (case-sensitive, so
    // generate-tests/ isn't one)
    /(^|\/)[\w.-]+[-_]Tests?\//.test(rel) ||
    /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(rel) ||
    /(^|\/)conftest\.py$/.test(rel) ||
    // v4: test-support modules inside source trees (pkg/testing.py, testutil.go, test_support.ts, testhelpers.rb)
    /(^|\/)(testing|test[-_]?utils?|test[-_]?helpers?|test[-_]support|test[-_]?setup)\.[a-z]+$/i.test(rel) ||
    // v3: .NET-style test projects (Foo.IntegrationTests/, Foo.Tests/), *-tests/ folders, test settings files
    /(^|\/)[\w.-]*(Integration|Unit|Functional|Acceptance|E2E|System|Smoke)Tests?\/|(^|\/)[\w-]+\.Tests?\/|(^|\/)([\w-]+[-_])?(e2e|integration|unit|functional|acceptance|system|smoke|api|ui|component|regression|perf|load|end[-_]to[-_]end|code[-_]example)[-_](tests?|specs?)\//i.test(rel) ||
    /(^|\/)(test[-_.]?settings|test[-_.]?config|appsettings\.(test|testing|integrationtest)s?)[\w.-]*\.(json|ya?ml|toml|ini)$/i.test(rel)
  );
}

/**
 * Gemini models have one schedule on the Gemini API and another on Vertex AI, and the model string alone
 * doesn't say which. If the repo only ever uses Vertex (vertexai SDK or vertexai=True clients), apply the
 * Vertex schedule to its Gemini references too. If it uses both, or we can't tell, leave them alone.
 */
function inferGoogleHost(usages: Usage[], sdks: SdkDependency[]): void {
  const google = usages.filter((u) => u.provider === "google");
  if (!google.length) return;
  const calls = google.filter((u) => u.kind === "sdk" || u.kind === "http");
  const vertexCalls = calls.filter((u) => u.host === "vertex").length;
  const vertexSdk = sdks.some((s) => /vertexai|aiplatform/.test(s.name));
  const geminiApiSdk = sdks.some((s) => /^(@google\/genai|@google\/generative-ai|google-genai|google-generativeai)$/.test(s.name));
  const onlyVertex = (vertexCalls > 0 && vertexCalls === calls.length) || (vertexSdk && !geminiApiSdk && calls.every((u) => u.host === "vertex"));
  if (onlyVertex) for (const u of google) u.host ??= "vertex";
}

/** Scan a repo directory and return its API map. */
/** Lines that can show a provider is used (see evidence.ts): imports, API key names, process calls */
const EVIDENCE_LINE = /^\s*(import|from|using|require|const|let|var|use)\b|require\(|_API_KEY|_AUTH_TOKEN|_PROJECT\b|spawn|exec|Popen|subprocess|ProcessBuilder|Command\(|system\(/;

/**
 * A copy of someone else's project kept for reference: a downloaded GitHub zip under docs/, examples/ or the like
 * (docs/other AI/some-chat-app-main/). Its model lists are that project's, not this app's. (A library copied in and
 * used by the app, some-lib-master/ or third_party/some-lib/, isn't left out.)
 */
const VENDORED = /(^|\/)(docs?|references?|resources|archive|examples?|samples?|other[^/]*)\/(.+\/)?[^/]+-(main|master)\//i;

/** More model values than this in one JSON file means it holds data, not settings */
const DATA_FILE_MODELS = 25;

/** Source kept for one scan, in characters (about 100 MB) */
const MAX_SOURCE_BYTES_DEFAULT = 100_000_000;

/**
 * v14: Anthropic calls that go to another endpoint: an Anthropic-compatible API on another host (the SDK pointed at
 * baseURL https://api.minimax.io/anthropic), or Claude on Vertex AI / Bedrock (AnthropicVertex, AnthropicBedrock),
 * which aren't the Messages API's /v1/messages. Their operations and settings aren't reported under it.
 */
const ANTHROPIC_CTOR = /\b(?:new\s+)?(?:Async)?Anthropic\s*\(/g;
const OTHER_PLATFORM = /\b(?:Async)?Anthropic(?:Vertex|Bedrock|Foundry)\b|@anthropic-ai\/(?:vertex|bedrock|foundry)-sdk|anthropic\[(?:vertex|bedrock)\]/;
function otherEndpoints(usages: Usage[], byRel: Map<string, string>): Usage[] {
  const foreign = new Map<string, boolean>();
  const isForeign = (file: string) => {
    if (foreign.has(file)) return foreign.get(file)!;
    const src = byRel.get(file) ?? "";
    const ctors = [...src.matchAll(ANTHROPIC_CTOR)].map((m) => src.slice(m.index!, m.index! + 600));
    // Every plain client here is pointed at another host
    const elsewhere = ctors.length > 0 && ctors.every((c) => {
      const base = /\b(?:baseURL|base_url|baseUrl)\s*[:=]\s*["'`](https?:\/\/[^"'`/]+)/.exec(c.slice(0, c.search(/\)\s*[;\n]/) + 1 || c.length));
      return !!base && !/anthropic\.com$/i.test(base[1]);
    });
    // Only another platform's client (AnthropicVertex), no plain one
    // (a file that also names the plain client, as a type or an import, uses it too)
    const platform = ctors.length === 0 && OTHER_PLATFORM.test(src) && !/\b(?:Async)?Anthropic\b\s*[,(:)\]|]|\bimport\s+(?:Async)?Anthropic\b|@anthropic-ai\/sdk["']/.test(src);
    foreign.set(file, elsewhere || platform);
    return elsewhere || platform;
  };
  const out: Usage[] = [];
  for (const u of usages) {
    if (u.provider !== "anthropic" || !u.op || !isForeign(u.file)) out.push(u);
    // A model named in that call is still a model the app uses (Claude on Vertex retires too): only the endpoint goes
    else if (u.model) {
      delete u.op;
      delete u.params;
      delete u.paramSpans;
      out.push(u);
    }
  }
  return out;
}

/** v14: env files' version lines whose variable no source file reads */
async function markUnreadEnv(usages: Usage[], paths: string[]): Promise<void> {
  const env = usages.filter((u) => u.lang === "config" && u.apiVersion && !u.model && /(^|\/)\.env(\.[\w.-]+)?$|(^|\/)env\.\w+$|\.env$/.test(u.file));
  if (!env.length) return;
  const names = new Map<Usage, string>();
  for (const u of env) {
    const n = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/.exec(u.snippet ?? "")?.[1];
    if (n) names.set(u, n);
  }
  if (!names.size) return;
  const read = new Set<string>();
  const wanted = new Set(names.values());
  for (const p of paths) {
    if (read.size === wanted.size) break;
    const text = await readFile(p, "utf8").catch(() => "");
    for (const n of wanted) if (!read.has(n) && text.includes(n) && new RegExp(`\\b${n}\\b`).test(text)) read.add(n);
  }
  for (const [u, n] of names) if (!read.has(n)) Object.assign(u, { envUnread: true, reason: `${n} is set here, but no code reads it` });
}

/**
 * `watchParams`: provider → the parameter names some feed record selects (watchParamsOf). When given, keys traced
 * through wrappers to a provider call are kept only if a record could match them; `watchOrigin`: a version or URL
 * constant starts a wrapper trace only if some record matches it (what's traced copies the fields a record reads, so no
 * finding changes); `watchKey` names the feed for the scan cache. The scan itself never needs the feed.
 */
export async function scanRepo(root: string, opts: { onWarn?: (msg: string) => void; configText?: string | null; catalogModel?: boolean; maxSourceBytes?: number; cacheDir?: string; watchParams?: Map<string, Set<string>>; watchOrigin?: (u: Usage) => boolean; watchKey?: string } = {}): Promise<ApiMap> {
  const config = await loadRepoConfig(root, opts.configText);
  for (const w of config.warnings) (opts.onWarn ?? (() => {}))(w);
  // The repo's own APIs apply to this scan only
  const map = await withProviders(config.providers, () => scanWithConfig(root, config, opts));
  return { ...map, config };
}

async function scanWithConfig(root: string, config: RepoConfig, opts: { onWarn?: (msg: string) => void; catalogModel?: boolean; maxSourceBytes?: number; cacheDir?: string; watchParams?: Map<string, Set<string>>; watchOrigin?: (u: Usage) => boolean; watchKey?: string }): Promise<ApiMap> {
  const MAX_SOURCE_BYTES = opts.maxSourceBytes ?? MAX_SOURCE_BYTES_DEFAULT;
  // VITASTA_PROFILE=1: time per phase, on stderr (no file names or code)
  const prof = process.env.VITASTA_PROFILE === "1";
  let lastT = Date.now();
  const phase = (name: string) => {
    // Between passes: collect what the pass dropped (V8 grows the heap lazily; a scan's passes drop most of what
    // they read, so without this the peak is mostly garbage)
    collectGarbage();
    if (!prof) return;
    const now = Date.now();
    const mu = process.memoryUsage();
    process.stderr.write(`[profile] ${name} ${now - lastT} ms rss ${Math.round(mu.rss / 1e6)} MB heap ${Math.round(mu.heapUsed / 1e6)} MB\n`);
    lastT = now;
  };
  // One clean line: file names and parser messages come from the repo, and stderr can carry Actions workflow commands
  const warn = (msg: string) => (opts.onWarn ?? (() => {}))(msg.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/::/g, ": :").slice(0, 300));
  const [allFiles, manifests] = await Promise.all([listSourceFiles(root), listManifests(root)]);
  const files = allFiles.filter((f) => !ignored(config, f.rel));
  const sdks = await readSdkDependencies(root, manifests);

  // Only sources are kept for the whole scan. Each file's syntax tree lives just while that file is being looked at:
  // tree-sitter's memory is capped (about 2 GB), and holding every tree of a big repo at once overflows it.
  // shifted: a virtual source whose characters moved (dedented docstring code): line numbers hold, offsets don't
  const sources: { rel: string; abs: string; lang: Lang; source: string; doc?: boolean; shifted?: boolean }[] = [];
  // From every file, only the lines that can show the repo uses a provider: imports, API key names, process calls
  const evidenceLines: string[] = [];
  // At most this much source per scan: past it, files are left out with a warning, so memory stays bounded (F2)
  let keptBytes = 0;
  const loadRefs = emptyRefs();
  const selectedNames = new Set<string>();
  const skippedCode: { rel: string; path: string; lang: Lang }[] = [];
  // v4: what test code loads, kept apart: a data file only tests read is test input, never runtime configuration
  const testLoadRefs = emptyRefs();
  // v14: past the budget, the files most likely to call an API are kept, not the first ones listed (n8n's nodes,
  // test sets): app code naming a provider host, then other app code, then tests and docs; smaller files first
  const HOSTS = new RegExp(PROVIDERS.flatMap((p) => [...p.hosts, ...(p.versionOnlyHosts ?? [])]).map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "$^");
  const candidates: { f: (typeof files)[number]; len: number; prio: number }[] = [];
  const keep = (f: (typeof files)[number], source: string) => {
    sources.push({ rel: f.rel, abs: f.path, lang: f.lang, source });
    keptBytes += source.length;
    // Code samples held in template strings, scanned as documentation (src/scan/embedded.ts)
    if (f.lang === "ts" || f.lang === "js") for (const v of templateCode(source)) if (prefilter().test(v.source)) sources.push({ rel: f.rel, abs: f.path, lang: v.lang, source: v.source, doc: true });
    if (f.lang === "py") for (const v of pythonStringCode(source)) if (prefilter().test(v.source)) sources.push({ rel: f.rel, abs: f.path, lang: v.lang, source: v.source, doc: true, shifted: v.shifted });
  };
  let capped = false;
  for (const f of files) {
    let source: string;
    try {
      source = await readFile(f.path, "utf8");
    } catch {
      continue;
    }
    // Data files the code loads by name or folder (roles v3: only those, and known config, fail a check)
    collectLoadRefs(source, isTestPath(f.rel) ? testLoadRefs : loadRefs);
    // v7: lists whose first or chosen entry app code uses as a default (defaultModels[0], models.find(…))
    if (!isTestPath(f.rel)) collectSelectedNames(source, selectedNames);
    const lines = source.split("\n").filter((l) => l.length < 400 && EVIDENCE_LINE.test(l));
    if (lines.length) evidenceLines.push(lines.join("\n"));
    // Cheap prefilter: skip files that can't possibly mention a provider
    // v12: files the prefilter skips can still use a versioned URL another module holds (getBaseUrl(shop))
    if (!prefilter().test(source) && source.length <= 2_000_000 && /\bimport\b|\brequire\(|\bfrom\s+[\w.]+\s+import\b/.test(source)) skippedCode.push({ rel: f.rel, path: f.path, lang: f.lang });
    if (!prefilter().test(source)) continue;
    const prio = (isTestPath(f.rel) || VENDORED.test(f.rel) ? 2 : 0) + (HOSTS.test(source) ? 0 : 1);
    candidates.push({ f, len: source.length, prio });
    if (!capped && keptBytes + source.length <= MAX_SOURCE_BYTES) keep(f, source);
    else capped = true;
  }
  if (capped) {
    // Choose within the budget by priority, then put the chosen set in place: drop kept files that lost, read the winners
    const chosen = new Set<string>();
    let budget = 0;
    for (const c of [...candidates].sort((a, b) => a.prio - b.prio || a.len - b.len)) {
      if (budget + c.len > MAX_SOURCE_BYTES) continue;
      budget += c.len;
      chosen.add(c.f.rel);
    }
    const had = new Set(sources.map((s) => s.rel));
    for (let i = sources.length - 1; i >= 0; i--) if (!chosen.has(sources[i].rel)) sources.splice(i, 1);
    keptBytes = sources.filter((s) => !s.doc).reduce((n, s) => n + s.source.length, 0);
    for (const c of candidates) {
      if (!chosen.has(c.f.rel) || had.has(c.f.rel)) continue;
      const source = await readFile(c.f.path, "utf8").catch(() => undefined);
      if (source !== undefined) keep(c.f, source);
    }
    warn(`read budget of ${Math.round(MAX_SOURCE_BYTES / 1_000_000)} MB reached: ${candidates.length - chosen.size} of ${candidates.length} candidate files left out (tests, docs and files naming no provider host first)`);
  }
  phase("read");
  // Code blocks in READMEs and docs, scanned as documentation
  for (const d of await listDocFiles(root)) {
    if (ignored(config, d.rel) || keptBytes > MAX_SOURCE_BYTES) continue;
    const md = await readFile(d.path, "utf8").catch(() => "");
    if (!md.includes("```") && !md.includes("~~~")) continue;
    for (const v of markdownCode(md)) {
      if (!prefilter().test(v.source)) continue;
      sources.push({ rel: d.rel, abs: d.path, lang: v.lang, source: v.source, doc: true });
      keptBytes += v.source.length;
    }
  }
  const viewText = new Map<string, string>();
  // View templates and pages: their inline scripts and URLs, scanned as JavaScript (src/scan/embedded.ts viewCode)
  for (const d of await listViewFiles(root)) {
    if (ignored(config, d.rel) || keptBytes > MAX_SOURCE_BYTES) continue;
    const t = await readFile(d.path, "utf8").catch(() => "");
    if (!prefilter().test(t)) continue;
    const v = viewCode(t);
    if (!v || !prefilter().test(v.source)) continue;
    sources.push({ rel: d.rel, abs: d.path, lang: v.lang, source: v.source });
    viewText.set(d.rel, t);
    keptBytes += v.source.length;
  }
  /** Parse one file, run `use` on its tree, and always free the tree. A file that can't be parsed is skipped. */
  async function withTree(p: (typeof sources)[number], use: (tree: Tree) => void): Promise<void> {
    let tree: Tree;
    try {
      tree = await parse(p.lang, p.rel, p.source);
    } catch (e) {
      warn(`could not parse ${p.rel}: ${(e as Error).message}`);
      return;
    }
    try {
      use(tree);
    } catch (e) {
      warn(`could not analyze ${p.rel}: ${(e as Error).message}`);
    } finally {
      tree.delete();
    }
  }

  phase("docs");
  // JS/TS pass 1: which files export a constructed client (needed before any file is analyzed)
  const exported: ExportedClients = new Map();
  // Call map pilot: the per-file cache (src/scan/scancache.ts), when the caller gives it a folder
  // Keys traced through wrappers are kept only when a record could match them (with a feed's watch list)
  const watched = (u: Usage) => !opts.watchParams || !u.params?.length || u.params.every((p) => opts.watchParams!.get(u.provider)?.has(p));
  const cacheDir = opts.cacheDir ?? process.env.VITASTA_SCAN_CACHE;
  const cache = cacheDir ? new ScanCache(cacheDir, root, fingerprint([PROVIDERS, config.providers ?? null, opts.watchParams ? [...opts.watchParams].map(([k, v]) => [k, [...v].sort()]).sort() : null, opts.watchKey ?? null])) : undefined;
  const srcKey = (p: (typeof sources)[number]) => `${p.rel}|${p.lang}|${p.doc ? 1 : 0}|${p.shifted ? 1 : 0}|${blobHash(p.source)}`;
  for (const p of sources) {
    const lang = p.lang;
    if (!((lang === "ts" || lang === "js") && !p.doc)) continue;
    const key = cache ? `x|${srcKey(p)}` : "";
    const hit = cache?.get(key);
    if (hit?.exports) {
      if (hit.exports.length) exported.set(stripExt(p.abs), new Map(hit.exports));
      continue;
    }
    await withTree(p, (tree) => collectExports(p.rel, p.abs, lang, p.source, tree, exported));
    cache?.set(key, { usages: [], exports: [...(exported.get(stripExt(p.abs))?.entries() ?? [])] });
  }
  // What JS/TS files see of each other's clients: a file's findings depend on it, so it's part of their cache key
  const exportedSig = cache ? createHash("sha256").update(JSON.stringify([...exported].map(([k, v]) => [relative(root, k), [...v]]).sort())).digest("hex").slice(0, 16) : "";

  phase("exports pass");
  const usages: Usage[] = [];
  const phpWrappers: PhpWrapper[] = [];
  // Call map pilot: structure of each TS/JS/Python file, for links across files (src/scan/callmap.ts)
  const cmFiles = new Map<string, FileIndex>();
  // very large or machine-written files: per-file analyzers only, none of the newer cross-file passes (src/scan/costguard.ts)
  const guard = costGuard();
  // A file with no provider findings of its own keeps its index without calls (most files): read again if a trace needs them
  const keepIndex = (rel: string, index: FileIndex, mine: Usage[]) => {
    if (!cmFiles.has(rel)) cmFiles.set(rel, mine.length ? index : { ...index, calls: [], slim: true });
  };
  /** Everything found in one source file (its own analysis, before links across files) */
  const analyzeOne = (p: (typeof sources)[number], tree: Tree, analyzed: string): Usage[] => {
    const analyze = ANALYZERS[p.lang]!;
    const found = withLines(analyze({ ...p, source: analyzed, tree, exported }), p.source);
    if (p.doc) for (const u of found) u.doc = true;
    // Offsets in a shifted source aren't the file's: no edit positions, so no fix can touch the wrong place
    if (p.shifted) for (const u of found) { delete u.modelSpan; delete u.paramSpans; }
    const mine = [...found, ...resourceUsages(p.rel, p.lang, p.source, found), ...urlVersionUsages(tree, p.rel, p.lang, p.source, found), ...urlModelUsages(tree, p.rel, p.lang, p.source, found), ...(p.doc ? [] : versionConstantUsages(p.rel, p.lang, p.source, found)), ...(p.doc ? [] : versionSetterUsages(p.rel, p.lang, p.source, found)), ...(p.lang === "rb" && !p.doc ? rubySdkUsages(p.rel, p.source) : []), ...(p.lang === "php" && !p.doc ? phpSdkUsages(p.rel, p.source, phpWrappers) : []), ...(p.doc ? [] : typedSdkUsages(p.rel, p.lang, p.source)), ...(p.doc ? [] : sdkClientUsages(p.rel, p.lang, p.source)), ...(p.doc ? [] : fluentUsages(p.rel, p.lang, p.source)), ...(p.doc ? [] : hostVariableUsages(p.rel, p.lang, p.source, found)), ...(p.doc ? [] : baseClientUsages(p.rel, p.lang, p.source, found)), ...(p.doc ? [] : aiSdkUsages(p.rel, p.lang, p.source)), ...(p.doc ? [] : requestBodyUsages(p.rel, p.lang, p.source, found))];
    if (!p.doc) mine.push(...regionUsages(p.rel, p.lang, p.source, mine));
    return mine;
  };
  for (const p of sources) {
    if (!ANALYZERS[p.lang]) continue;
    const cm = !p.doc && (p.lang === "ts" || p.lang === "js" || p.lang === "py");
    const key = cache ? `a|${srcKey(p)}|${p.lang === "ts" || p.lang === "js" ? exportedSig : ""}` : "";
    const hit = cache?.get(key);
    if (hit) {
      if (cm && hit.index) keepIndex(p.rel, hit.index, hit.usages);
      if (hit.php) phpWrappers.push(...(hit.php as PhpWrapper[]));
      usages.push(...withSnippets(hit.usages, p.source));
      continue;
    }
    await withTree(p, (tree) => {
      const index = cm && !guard.heavy(p) ? indexFile(p.lang as "ts", tree) : undefined;
      const phpBefore = phpWrappers.length;
      const mine = analyzeOne(p, tree, p.source);
      if (index) keepIndex(p.rel, index, mine);
      usages.push(...mine);
      cache?.set(key, { usages: mine, ...(index ? { index } : {}), ...(phpWrappers.length > phpBefore ? { php: phpWrappers.slice(phpBefore) } : {}) });
    });
  }
  phase("analysis");
  // v8: versions held in variables and constants (also imported from another file) and used in provider URLs
  const codeFiles = sources.filter((p) => !p.doc).map((p) => ({ rel: p.rel, lang: p.lang, source: p.source }));
  // Modules read by import path when a name's binding isn't in the kept sources (bounded: files under the root only)
  const readRel = (rel: string) => {
    if (rel.includes("..") || rel.startsWith("/")) return undefined;
    try {
      const abs = join(root, rel);
      return lstatSync(abs).isFile() && lstatSync(abs).size <= 2_000_000 ? readFileSync(abs, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  // Call map pilot (src/scan/callmap.ts): links across TS/JS/Python files by import path. Files outside the kept sources
  // are indexed only when a link or a trace needs them.
  const cmLangs = new Set(["ts", "js", "py"]);
  const codeRels = files.filter((f) => cmLangs.has(f.lang)).map((f) => f.rel);
  const langOfRel = new Map(files.map((f) => [f.rel, f.lang]));
  // Text of the kept sources; other files are read on demand, at most a quarter of the read budget more, and kept only
  // when a link needs them (a missed link is better than reading past the budget)
  const keptText = new Map(codeFiles.map((f) => [f.rel, f.source]));
  const extraText = new Map<string, string | undefined>();
  let cmRead = 0;
  // A file counts against the budget once: reading it again (a later search) is free, so the budget bounds how much of
  // the repo is read, not how often, and a late search sees the same files an early one did
  const counted = new Set<string>();
  const readExtra = (rel: string, keepIt: boolean) => {
    if (extraText.has(rel)) return extraText.get(rel);
    if (!counted.has(rel) && cmRead > MAX_SOURCE_BYTES / 4) return undefined;
    const t = readRel(rel);
    if (!counted.has(rel)) {
      counted.add(rel);
      cmRead += t?.length ?? 0;
    }
    if (keepIt) extraText.set(rel, t);
    return t;
  };
  // Files outside the kept sources are read when a pass needs them and not kept (memory): a pass reads them again
  // (the last ones read stay in a cache bounded by size: traces read the same files for each carrier)
  const recentText = new Map<string, string | undefined>();
  let recentBytes = 0;
  const text = (rel: string) => {
    const k = keptText.get(rel);
    if (k !== undefined) return k;
    if (recentText.has(rel)) {
      const t = recentText.get(rel);
      recentText.delete(rel);
      recentText.set(rel, t);
      return t;
    }
    const t = readExtra(rel, false);
    recentText.set(rel, t);
    recentBytes += t?.length ?? 0;
    while (recentBytes > 48_000_000 && recentText.size > 1) {
      const [old, ot] = recentText.entries().next().value!;
      recentText.delete(old);
      recentBytes -= ot?.length ?? 0;
    }
    return t;
  };
  await preload(["ts", "tsx", "py"]);
  // Workspace packages, from every package.json's name (bounded: names only, at most 2,000 manifests)
  const workspaces = new Map<string, string>();
  for (const abs of manifests.filter((m) => m.endsWith("/package.json")).slice(0, 2000)) {
    try {
      const rel = relative(root, abs);
      if (rel.startsWith("..") || lstatSync(abs).size > 1_000_000) continue;
      const name = (JSON.parse(readFileSync(abs, "utf8")) as { name?: unknown }).name;
      const dirOf = rel.split("/").slice(0, -1).join("/");
      if (typeof name === "string" && /^(?:@[\w.-]+\/)?[\w.-]+$/.test(name) && dirOf) {
        // Two packages with one name: neither
        workspaces.set(name, workspaces.has(name) ? "\0" : dirOf);
      }
    } catch {
      /* not a package */
    }
  }
  for (const [n, d] of workspaces) if (d === "\0") workspaces.delete(n);
  const map = new CallMap(cmFiles, codeRels, (rel) => {
    const src = text(rel);
    const lang = langOfRel.get(rel);
    if (src === undefined || !lang || !cmLangs.has(lang)) return undefined;
    if (guard.heavy({ rel, source: src })) return undefined;
    const key = cache ? `i|${rel}|${blobHash(src)}` : "";
    const hit = cache?.get(key);
    if (hit?.index) return hit.index;
    const tree = parseLoaded(lang, rel, src);
    if (!tree) return undefined;
    try {
      const index = indexFile(lang as "ts", tree);
      cache?.set(key, { usages: [], index });
      return index;
    } finally {
      tree.delete();
    }
  });
  map.workspaces = workspaces;
  const searchable = [...new Set([...codeFiles.filter((f) => cmLangs.has(f.lang)).map((f) => f.rel), ...skippedCode.filter((f) => cmLangs.has(f.lang)).map((f) => f.rel)])];
  // Files whose text has one of `any` and every one of `all` (a cheap filter before the call map links them)
  // (each string's longest word is looked for first, once per distinct word: './graphRequest' and '.graphRequest import'
  // both need "graphRequest")
  const coreWord = (n: string) => (n.match(/[A-Za-z_$][\w$]*/g) ?? [n]).reduce((a, b) => (b.length > a.length ? b : a), "");
  const wordFilters = new Map<string, Uint32Array | null>();
  const wordsOf = (rel: string): Uint32Array | null => {
    if (wordFilters.has(rel)) return wordFilters.get(rel)!;
    const t = readExtra(rel, false);
    const f = t === undefined ? null : wordFilter(t);
    wordFilters.set(rel, f);
    return f;
  };
  const cmCandidates = (names: string[], all?: string[]) => {
    const any = names.filter((n) => n.length > 2);
    const cores = [...new Set(any.map(coreWord))];
    return searchable.filter((rel) => {
      // A file outside the kept sources: its word filter first (read once), the text only when the filter passes
      if (!keptText.has(rel)) {
        const f = wordsOf(rel);
        if (!f || !any.some((n) => mayHave(f, n)) || (all && !all.every((n) => mayHave(f, n)))) return false;
      }
      const t = text(rel);
      if (!t) return false;
      const present = new Set(cores.filter((w) => t.includes(w)));
      const hit = any.some((n) => present.has(coreWord(n)) && t.includes(n)) && (!all || all.every((n) => t.includes(n)));
      return hit;
    });
  };
  // The lines of the last files read (a small cache: traces read a few files many times)
  const splitOf = new Map<string, string[] | undefined>();
  const lineText = (rel: string, ln: number) => {
    let ls = splitOf.get(rel);
    if (ls === undefined && !splitOf.has(rel)) {
      ls = text(rel)?.split("\n");
      splitOf.set(rel, ls);
      if (splitOf.size > 256) splitOf.delete(splitOf.keys().next().value!);
    }
    return ls?.[ln - 1];
  };
  phase("x:bases");
  const cmResolve = (useFile: string, name: string) => {
    const r = map.resolveLocal(useFile, name);
    return r && r.file !== useFile ? { file: r.file, start: r.def.start, end: r.def.end } : undefined;
  };
  // v9: PHP wrappers whose first parameter is an SDK request, called from other files
  if (phpWrappers.length) for (const f of codeFiles) if (f.lang === "php") usages.push(...phpWrapperCallUsages(f.rel, f.source, phpWrappers));
  phase("x:callmap-setup");
  // Call map pilot: a provider SDK imported through the repo's own module (from polar.integrations.stripe import
  // stripe_lib, where __init__.py does `import stripe as stripe_lib`): the file is analyzed again with that import
  // written out after its last line (line numbers and offsets don't move), and its own findings replaced
  {
    const sdkPackages = new Map<string, Set<string>>();
    for (const pv of PROVIDERS) for (const [lang, list] of Object.entries(pv.packages)) for (const pkg of list ?? []) {
      const key = lang === "js" ? "ts" : lang;
      if (!sdkPackages.has(key)) sdkPackages.set(key, new Set());
      sdkPackages.get(key)!.add(pkg);
    }
    const isSdk = (lang: string, spec: string) => {
      const set = sdkPackages.get(lang === "js" ? "ts" : lang);
      if (!set) return false;
      const root = lang === "py" ? spec.split(".")[0] : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      return set.has(spec) || set.has(root);
    };
    const pkgNames = [...new Set([...sdkPackages.values()].flatMap((s) => [...s]))].filter((n) => n.length > 2);
    const handsOn = new Map<string, boolean>();
    const mayHandOnSdk = (rel: string, depth = 0): boolean => {
      if (handsOn.has(rel)) return handsOn.get(rel)!;
      handsOn.set(rel, false);
      const t = keptText.get(rel) ?? readExtra(rel, false);
      let ok = !!t && pkgNames.some((n) => t.includes(n));
      // A barrel (every statement an import or export: export * from './client', from .client import *) hands one on
      // only when a module it re-exports from does, followed by text up to 3 deep
      if (t && !ok && depth < 3 && t.length < 50_000 && t.split("\n").every((l) => !l.trim() || /^\s*(?:import\b|export\b|from\b|\/\/|#|\*|\/\*|["'}\])]|[\w$]+,?\s*$)/.test(l))) {
        const specs = [...t.matchAll(/\bfrom\s+["']([^"'\n]{1,300})["']|^[ \t]*from\s+(\.[\w.]*)\s+import\b/gm)].map((m) => m[1] ?? m[2]);
        ok = specs.some((sp) => {
          const next = map.resolveSpec(rel, sp);
          return !!next && next !== rel && mayHandOnSdk(next, depth + 1);
        });
      }
      handsOn.set(rel, ok);
      return ok;
    };
    for (const p of sources) {
      if (p.doc || !(p.lang === "ts" || p.lang === "js" || p.lang === "py")) continue;
      const idx = cmFiles.get(p.rel);
      if (!idx) continue;
      const lines: string[] = [];
      for (const im of idx.imports) {
        if (im.local === "*" || isSdk(p.lang, im.spec)) continue;
        // Only a module that names an SDK package, or only re-exports, can hand one on: others aren't loaded
        const target = map.resolveSpec(p.rel, im.spec);
        if (!target || !mayHandOnSdk(target)) continue;
        const ext = map.resolveExternal(p.rel, im.local);
        // Python: a module-level client of an SDK class made in that module (client = StripeClient(…)), used here
        if (!ext && p.lang === "py" && /^[A-Za-z_]\w*$/.test(im.local)) {
          const r = map.resolveLocal(p.rel, im.local);
          const callee = r?.def.kind === "value" ? r.def.inst?.replace(/^new\s+/, "") : undefined;
          if (r && callee && /^[A-Za-z_][\w.]*$/.test(callee)) {
            const [root, ...rest] = callee.split(".");
            const ce = map.resolveExternal(r.file, root);
            if (ce && isSdk("py", ce.spec) && /^[\w.]+$/.test(ce.spec)) {
              const cls = ce.name === "*" ? `__vitasta_m.${rest.join(".")}` : `__vitasta_c`;
              if (ce.name === "*" && !rest.length) continue;
              lines.push(ce.name === "*" ? `import ${ce.spec} as __vitasta_m` : `from ${ce.spec} import ${ce.name} as __vitasta_c`, `${im.local} = ${cls}()`);
              continue;
            }
          }
        }
        if (!ext || !isSdk(p.lang, ext.spec) || !/^[A-Za-z_$][\w$]*$/.test(im.local) || !/^[@\w./-]+$/.test(ext.spec)) continue;
        if (p.lang === "py") lines.push(ext.name === "*" ? `import ${ext.spec} as ${im.local}` : `from ${ext.spec} import ${ext.name} as ${im.local}`);
        else lines.push(ext.name === "*" ? `import * as ${im.local} from "${ext.spec}";` : ext.name === "default" ? `import ${im.local} from "${ext.spec}";` : `import { ${ext.name} as ${im.local} } from "${ext.spec}";`);
      }
      if (!lines.length) continue;
      const analyzed = `${p.source}\n${lines.join("\n")}\n`;
      const key = cache ? `r|${srcKey(p)}|${p.lang === "ts" || p.lang === "js" ? exportedSig : ""}|${blobHash(lines.join("\n"))}` : "";
      const hit = cache?.get(key);
      const replace = (again: Usage[]) => {
        for (let i = usages.length - 1; i >= 0; i--) if (usages[i].file === p.rel && !usages[i].doc) usages.splice(i, 1);
        usages.push(...again);
      };
      if (hit) {
        replace(withSnippets(hit.usages, p.source));
        continue;
      }
      let tree: Tree | undefined;
      try {
        tree = await parse(p.lang, p.rel, analyzed);
        const n = p.source.split("\n").length;
        const again = analyzeOne(p, tree, analyzed).filter((u) => u.line <= n);
        replace(again);
        cache?.set(key, { usages: again });
      } catch (e) {
        warn(`could not analyze ${p.rel}: ${(e as Error).message}`);
      } finally {
        tree?.delete();
      }
    }
  }
  // v11: Python wrappers around an SDK call, called from other files with a dict built there
  phase("x:sdk-alias");
  // (callers of a keyword wrapper often name no provider, so the prefilter skipped them: read those Python files then)
  const skippedPy = () => skippedCode.filter((f) => f.lang === "py").flatMap((f) => {
    try {
      return [{ rel: f.rel, lang: f.lang, source: readFileSync(f.path, "utf8") }];
    } catch {
      return [];
    }
  });
  usages.push(...pythonWrapperUsages(codeFiles, usages, skippedPy).filter(watched));
  // v12: libraries that call a versioned API with their own default (omniauth-facebook, Socialite, AddFacebook() …)
  phase("x:pywrap");
  usages.push(...libraryDefaultUsages(root, codeFiles));
  // v18: sampling settings a wrapper library release sends on its own (@langchain/anthropic 0.x, ruby_llm ≤ 1.6.2)
  usages.push(...librarySentUsages(root, guard.lite(codeFiles), isTestPath, usages));
  // Layer 1: request fields set on an SDK params / options type, from the generated SDK vocabulary
  usages.push(...vocabUsages(guard.lite(codeFiles), usages).filter(watched));
  // Layer 4: SDK call shapes from the vocabulary where the receiver isn't known ("possible")
  usages.push(...callShapeUsages(guard.lite(codeFiles), usages));
  // Layer 2: Ruby clients built in another method, class, mixin or initializer (one-hop), from the vocabulary
  usages.push(...rubyClientUsages(guard.lite(codeFiles), usages).filter(watched));
  usages.push(...phpClientUsages(guard.lite(codeFiles), usages).filter(watched));
  // v13: base URLs imported from another module (export const WHATSAPP_API_BASE = 'https://graph.facebook.com/v23.0'),
  // resolved through the import path, then joined with a path in this file
  phase("x:libdefaults");
  const bases = codeFiles.map((g) => ({ g, b: baseBindings(g.source) })).filter((x) => x.b.size);
  if (bases.length) {
    const skippedRead = skippedCode.flatMap((s) => {
      try {
        const source = readFileSync(s.path, "utf8");
        return bases.some((x) => [...x.b.keys()].some((k) => source.includes(k))) ? [{ rel: s.rel, lang: s.lang, source }] : [];
      } catch {
        return [];
      }
    });
    for (const f of [...codeFiles, ...skippedRead]) {
      const extra = new Map<string, string>();
      for (const { g, b } of bases) {
        if (g.rel === f.rel) continue;
        for (const [name, url] of b) if (f.source.includes(name) && importedVia(f.source, f.rel, g.rel, name) === name) extra.set(name, url);
      }
      if (!extra.size) continue;
      const mine = usages.filter((u) => u.file === f.rel);
      for (const u of hostVariableUsages(f.rel, f.lang, f.source, mine, extra)) if (!mine.some((x) => x.line === u.line && x.op === u.op)) usages.push(u);
    }
  }
  let skippedRead: { rel: string; lang: Lang; source: string }[] | undefined;
  const readSkipped = () => (skippedRead ??= skippedCode.flatMap((f) => {
    try {
      return [{ rel: f.rel, lang: f.lang, source: readFileSync(f.path, "utf8") }];
    } catch {
      return [];
    }
  }));
  usages.push(...versionVariableUsages(codeFiles, usages, readSkipped, readRel, cmResolve));
  // the API version an SDK writes into its import paths (Google Ads: Google\Ads\GoogleAds\V23\…): src/scan/sdknamespace.ts
  usages.push(...sdkNamespaceUsages([...codeFiles, ...readSkipped().filter((f) => /Google[\\.:]+Ads|google\.ads|google\/ads/i.test(f.source))].filter((f, i, a) => a.findIndex((g) => g.rel === f.rel && g.source === f.source) === i), isTestPath, usages));
  // Python: a LangChain chat model whose provider comes from configuration (or a provider-prefixed id through a proxy)
  {
    const pyFiles = [...codeFiles.filter((f) => f.lang === "py"), ...readSkipped().filter((f) => f.lang === "py" && f.source.includes("init_chat_model("))];
    if (pyFiles.some((f) => f.source.includes("init_chat_model("))) {
      let text = "";
      for (const abs of manifests.filter((m) => /(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg)$/.test(m)).slice(0, 200)) {
        try {
          if (lstatSync(abs).isFile() && lstatSync(abs).size <= 2_000_000) text += readFileSync(abs, "utf8") + "\n";
        } catch {
          /* unreadable */
        }
      }
      usages.push(...pythonProviderUsages(guard.lite(pyFiles), text, usages).filter(watched));
    }
  }
  // Ruby: a client library's request body built from a declared option group (src/scan/rbschema.ts)
  if (codeFiles.some((f) => f.lang === "rb" && /def\s+\w*body/.test(f.source))) {
    const kept = new Set(codeFiles.map((f) => f.rel));
    usages.push(...rubySchemaBodyUsages(guard.lite([...codeFiles, ...readSkipped().filter((f) => f.lang === "rb" && !kept.has(f.rel) && !isTestPath(f.rel))]), usages).filter(watched));
  }
  // Ruby: sampling defaults in a hash a request body is built from, across files (src/scan/rbhashbody.ts)
  if (codeFiles.some((f) => f.lang === "rb" && /api\.anthropic\.com/.test(f.source))) {
    const kept = new Set(codeFiles.map((f) => f.rel));
    const rbIn = guard.lite([...codeFiles, ...readSkipped().filter((f) => f.lang === "rb" && !kept.has(f.rel))]).filter((f) => !isTestPath(f.rel));
    // (a defaults module names no provider: Ruby files holding a sampling key in a hash are read for this pass, bounded)
    const seenRb = new Set(rbIn.map((f) => f.rel));
    let bytes = 0;
    for (const f of files) {
      if (f.lang !== "rb" || seenRb.has(f.rel) || isTestPath(f.rel) || bytes > 30_000_000) continue;
      try {
        const st = lstatSync(f.path);
        if (!st.isFile() || st.size > 1_000_000) continue;
        const source = readFileSync(f.path, "utf8");
        if (!/\b(?:temperature|top_p|top_k)\b\s*(?::(?!:)|=>)/.test(source)) continue;
        bytes += source.length;
        rbIn.push({ rel: f.rel, lang: f.lang, source });
      } catch {
        /* unreadable */
      }
    }
    usages.push(...rubyHashBodyUsages(guard.lite(rbIn), usages).filter(watched));
  }
  // An SDK's endpoint classes: an abstract path property set by each subclass (src/scan/endpointclasses.ts)
  {
    const kept = new Set(codeFiles.map((f) => f.rel));
    const all = [...codeFiles, ...readSkipped().filter((f) => !kept.has(f.rel))].filter((f) => (f.lang === "cs" || f.lang === "java" || f.lang === "ts") && !isTestPath(f.rel));
    if (all.some((f) => /\babstract\s+(?:override\s+)?(?:string|String)\s+\w+/.test(f.source))) usages.push(...endpointClassUsages(guard.lite(all), usages).filter(watched));
  }
  // API paths in constants, the provider's host configured elsewhere in the file or directory (src/scan/pathconsts.ts)
  {
    // (files that name no provider but hold a versioned path literal, a relay's routes, are read for this pass too)
    const kept = new Set(codeFiles.map((f) => f.rel));
    const extra = readSkipped().filter((f) => !kept.has(f.rel) && /["'`]\/v\d+\//.test(f.source));
    usages.push(...pathConstantUsages(guard.lite([...codeFiles, ...extra].filter((f) => !isTestPath(f.rel))), usages).filter(watched));
    // C# / Java: model ids in a constants class, chosen by a default or model setting elsewhere (src/scan/modelconsts.ts)
    {
      const csj = [...codeFiles, ...readSkipped().filter((f) => !kept.has(f.rel))].filter((f) => (f.lang === "cs" || f.lang === "java") && !isTestPath(f.rel));
      usages.push(...modelConstantUsages(guard.lite(csj), usages).filter(watched));
    }
    // Go: a struct marshalled as the body of a request to a provider URL (src/scan/gostruct.ts)
    const goAll = [...codeFiles, ...readSkipped().filter((f) => !kept.has(f.rel) && f.lang === "go")].filter((f) => f.lang === "go" && !isTestPath(f.rel));
    // (a request DTO package names no provider and imports nothing: its struct files are read for this pass, bounded)
    if (goAll.some((f) => /json\.(?:Marshal|NewEncoder)/.test(f.source))) {
      const seenGo = new Set(goAll.map((f) => f.rel));
      let bytes = 0;
      for (const f of files) {
        if (f.lang !== "go" || seenGo.has(f.rel) || isTestPath(f.rel) || bytes > 30_000_000) continue;
        try {
          const st = lstatSync(f.path);
          if (!st.isFile() || st.size > 1_000_000) continue;
          const source = readFileSync(f.path, "utf8");
          if (!/\bstruct\s*\{/.test(source)) continue;
          bytes += source.length;
          goAll.push({ rel: f.rel, lang: f.lang, source });
        } catch {
          /* unreadable */
        }
      }
    }
    if (goAll.some((f) => /json\.(?:Marshal|NewEncoder)/.test(f.source))) usages.push(...goStructBodyUsages(guard.lite(goAll), usages).filter(watched));
    if (goAll.some((f) => /json\.(?:Marshal|NewEncoder)/.test(f.source))) usages.push(...goMapBodyUsages(guard.lite(goAll), usages).filter(watched));
    // A form posted to a provider URL, in every language (src/scan/formbody.ts)
    usages.push(...formBodyUsages(guard.lite(codeFiles.filter((f) => !isTestPath(f.rel))), usages).filter(watched));
  }
  // Python: an SDK resource chain on a client held elsewhere (self.client.beta.assistants.create) (src/scan/pysdkchains.ts)
  {
    let text = "";
    for (const abs of manifests.filter((m) => /(?:requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg)$/.test(m)).slice(0, 200)) {
      try {
        if (lstatSync(abs).isFile() && lstatSync(abs).size <= 2_000_000) text += readFileSync(abs, "utf8") + "\n";
      } catch {
        /* unreadable */
      }
    }
    if (text) {
      const kept = new Set(codeFiles.map((f) => f.rel));
      const py = [...codeFiles, ...readSkipped().filter((f) => !kept.has(f.rel))].filter((f) => f.lang === "py" && !isTestPath(f.rel));
      usages.push(...pythonSdkChainUsages(guard.lite(py), text, usages).filter(watched));
    }
  }
  // A config literal that sets a Claude model and a sampling setting together (src/scan/modelconfigs.ts)
  usages.push(...claudeConfigUsages(guard.lite(codeFiles.filter((f) => !isTestPath(f.rel))), usages).filter(watched));
  {
    const kept = new Set(codeFiles.map((f) => f.rel));
    const pv = [...codeFiles, ...readSkipped().filter((f) => !kept.has(f.rel))].filter((f) => !isTestPath(f.rel));
    usages.push(...namedProviderCallUsages(guard.lite(pv), usages).filter(watched));
    usages.push(...promptObjectUsages(guard.lite(pv), usages).filter(watched));
    // PHP: the array a raw HTTP POST sends (src/scan/phpbody.ts)
    usages.push(...phpPostedArrayUsages(guard.lite(pv), usages).filter(watched));
  }
  // Mastra: an agent's modelSettings (temperature / topP / topK) in a repo that can reach Anthropic (src/scan/mastra.ts)
  {
    const pkgs = manifests.filter((m) => m.endsWith("/package.json") && !m.includes("/node_modules/")).slice(0, 200);
    let text = "";
    for (const abs of pkgs) {
      try {
        if (lstatSync(abs).isFile() && lstatSync(abs).size <= 2_000_000) text += readFileSync(abs, "utf8") + "\n";
      } catch {
        /* unreadable */
      }
    }
    if (text.includes('"@mastra/core"')) {
      const kept = new Set(codeFiles.map((f) => f.rel));
      const tsFiles = [...codeFiles, ...readSkipped().filter((f) => !kept.has(f.rel))].filter((f) => (f.lang === "ts" || f.lang === "js") && (f.source.includes("modelSettings") || f.source.includes("anthropic/claude")));
      usages.push(...mastraUsages(guard.lite(tsFiles), text, usages).filter(watched));
    }
  }
  let flowExtra: { rel: string; lang: Lang; source: string }[] = [];
  // Java and C#: versions in constants, enums and defaults that reach a URL in another file (src/scan/constvals.ts); the
  // skipped Java/C# files are read for this pass only
  if (codeFiles.some((f) => f.lang === "java" || f.lang === "cs" || f.lang === "php" || f.lang === "go")) {
    const keptRels = new Set(codeFiles.map((f) => f.rel));
    let bytes = 0;
    const extra = files.filter((f) => (f.lang === "java" || f.lang === "cs" || f.lang === "php" || f.lang === "go") && !keptRels.has(f.rel) && !isTestPath(f.rel)).flatMap((f) => {
      if (bytes > 50_000_000) return [];
      try {
        const st = lstatSync(f.path);
        if (!st.isFile() || st.size > 1_000_000) return [];
        const source = readFileSync(f.path, "utf8");
        bytes += source.length;
        return [{ rel: f.rel, lang: f.lang, source }];
      } catch {
        return [];
      }
    });
    // Files that define a value (static/const fields, enums), and files that use one of those types by name
    const defines = extra.filter((x) => (x.lang === "go" ? /^(?:const|var)\b/m.test(x.source) : x.lang === "php" ? /\b(?:const|protected|private|public|var)\s/.test(x.source) && /\bclass\b/.test(x.source) : /\b(?:static|const|enum)\b/.test(x.source)));
    const typeNames = new Set([...codeFiles, ...defines].filter((x) => x.lang === "java" || x.lang === "cs" || x.lang === "php").flatMap((x) => [...x.source.matchAll(/\b(?:class|enum|interface|struct|record|trait)\s+([A-Z]\w*)/g)].map((m) => m[1])));
    const useRe = typeNames.size ? new RegExp(`\\b(?:${[...typeNames].slice(0, 2000).join("|")})(?:\\.|::)[A-Za-z_$]|\\bextends\\s+\\\\?(?:[\\w\\\\]*\\\\)?(?:${[...typeNames].slice(0, 2000).join("|")})\\b`) : undefined;
    const users = useRe ? extra.filter((x) => !defines.includes(x) && useRe.test(x.source)) : [];
    usages.push(...constValueUsages(guard.lite([...codeFiles, ...defines, ...users]), usages));
    usages.push(...phpValueUsages(guard.lite([...codeFiles, ...defines, ...users]), usages));
    // Go: module paths from the repo's go.mod files
    const goMods = manifests.filter((m) => m.endsWith("/go.mod")).slice(0, 200).flatMap((abs) => {
      try {
        const mod = /^module\s+(\S+)/m.exec(readFileSync(abs, "utf8"))?.[1];
        return mod ? [{ dir: relative(root, abs).split("/").slice(0, -1).join("/"), module: mod }] : [];
      } catch {
        return [];
      }
    });
    usages.push(...goValueUsages(guard.lite([...codeFiles, ...defines, ...users, ...extra.filter((x) => x.lang === "go" && !defines.includes(x) && !users.includes(x))]), usages, goMods));
    // Item 4/F: where a value that reaches a provider comes from (src/scan/flow.ts), in every language it reads, across
    // every non-test file (the skipped ones are read for this pass only)
    flowExtra = extra;
  }
  // Item 4/F: where a value that reaches a provider comes from (src/scan/flow.ts), in every language it reads, across
  // every non-test file (the skipped ones are read for this pass only)
  {
    const pySkipped = readSkipped().filter((x) => x.lang === "py" && !isTestPath(x.rel));
    // Provider-wrapper libraries: endpoint paths in constants / enums / Retrofit annotations (src/scan/wrapperpaths.ts),
    // over every non-test file of the languages read whole above
    {
      const seen = new Set([...codeFiles, ...flowExtra].map((f) => f.rel));
      const more = readSkipped().filter((f) => !seen.has(f.rel) && /@(?:GET|POST|PUT|DELETE|PATCH)\(|["']\/?[a-z][a-z_]*(?:\/[\w{}.%:-]+)*["']|["'`]\/?v\d+\/[a-z]/.test(f.source));
      usages.push(...wrapperPathUsages(guard.lite([...codeFiles, ...flowExtra, ...more].filter((f) => !isTestPath(f.rel))), usages).filter(watched));
    }
    // TS/JS files without findings of their own that name a setting a finding sends (a caller's { temperature: 0.2 })
    const words = [...new Set(usages.flatMap((u) => u.params ?? []).flatMap((p) => [p, p.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())]))].filter((w) => w.length > 3);
    const kept = new Set([...codeFiles, ...flowExtra].map((f) => f.rel));
    const tsSkipped = words.length ? readSkipped().filter((x) => (x.lang === "ts" || x.lang === "js" || x.lang === "rb") && !kept.has(x.rel) && !isTestPath(x.rel) && words.some((w) => x.source.includes(w))) : [];
    usages.push(...flowUsages(guard.lite([...codeFiles, ...flowExtra, ...pySkipped, ...tsSkipped]), usages, await springConfigValues(root)).filter(watched));
    // A provider's client pointed at another vendor's compatible endpoint is that vendor's call (src/scan/vendors.ts)
    const all = [...codeFiles, ...flowExtra];
    for (const pid of new Set(usages.map((u) => u.provider))) {
      const def = providerById(pid);
      if (!def || !isAiProvider(pid)) continue;
      const hosts = compatibleHosts(all, pid, def.hosts);
      if (!hosts.size) continue;
      for (let i = usages.length - 1; i >= 0; i--) {
        const u = usages[i];
        if (u.provider === pid && [...hosts.keys()].some((v) => fileOfVendor(u.file, v))) usages.splice(i, 1);
      }
    }
  }
  phase("x:version-vars");
  // v14: modules that import a client another module set the version on (graph.setVersion('7.0'); module.exports = graph)
  if (usages.some((u) => u.apiVersion?.startsWith("setter: "))) usages.push(...setterModuleUsers([...codeFiles, ...readSkipped()], usages));
  phase("x:setter-modules");
  // Call map pilot: provider versions fixed inside exported wrappers, at the files that call them (through imports and
  // re-exports, up to 3 hops)
  usages.push(...traceWrapperCalls(map, usages, lineText, isTestPath, cmCandidates, opts.watchOrigin));
  phase("x:trace-wrappers");
  // Call map pilot: keys callers put in the parameters a wrapper passes on to a provider call
  usages.push(...traceParamCalls(map, usages, lineText, isTestPath, cmCandidates).filter(watched));
  usages.push(...traceAiSdkWrappers(map, usages, text, isTestPath, cmCandidates));
  usages.push(...gatewayClaudeUsages(usages, text, cmResolve, guard.lite(codeFiles).filter((f) => !isTestPath(f.rel) && ["ts", "js", "py", "php", "go"].includes(f.lang)).map((f) => f.rel)));
  usages.push(...transportUsages(map, usages, text, cmCandidates, isTestPath, modulePaths, localsFor));
  // Item C: a published library forwarding its callers' settings to a provider (src/scan/libforward.ts)
  {
    let published = false;
    for (const abs of manifests.filter((m) => m.endsWith("/package.json")).slice(0, 200)) {
      try {
        const pj = JSON.parse(readFileSync(abs, "utf8")) as { name?: unknown; private?: unknown; main?: unknown; exports?: unknown; module?: unknown };
        if (typeof pj.name === "string" && pj.private !== true && (pj.main || pj.exports || pj.module)) published = true;
      } catch {
        /* not a package */
      }
    }
    // A type's file: the importing file itself, or where its import path leads (call map), else files naming it
    if (published) usages.push(...libraryForwardUsages(guard.lite(codeFiles), usages, true, (name, from) => {
      const own = text(from);
      const out: { rel: string; source: string }[] = own ? [{ rel: from, source: own }] : [];
      const spec = own ? new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`).exec(own)?.[1] : undefined;
      const target = spec ? map.resolveSpec(from, spec) : undefined;
      const tt = target ? text(target) : undefined;
      if (target && tt) out.push({ rel: target, source: tt });
      return out;
    }));
  }
  // Trace starts did their job: they aren't findings or usages of the scan
  // F: a request's settings set on other lines of its function (a body built above the call, an options object passed
  // by name): those lines are the request's too, so a fix there is found
  for (const u of usages) {
    if (!u.op || !u.params?.length || u.doc || (u.kind !== "http" && u.kind !== "sdk")) continue;
    if (u.paramSpans && u.params.every((p) => u.paramSpans![p])) continue;
    const ls = text(u.file)?.split("\n");
    if (!ls) continue;
    const enc = cmLangs.has(langOfRel.get(u.file) ?? "") ? map.enclosing(u.file, u.line) : undefined;
    const [from, to] = enc ? [enc.def.start, enc.def.end] : [Math.max(1, u.line - 40), Math.min(ls.length, u.line + 40)];
    const lines = new Set(u.alsoLines ?? []);
    for (const p of u.params) {
      if (u.paramSpans?.[p] || p.length < 3) continue;
      const forms = [...new Set([p, p.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), p.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase())])].map((x) => x.replace(/[$]/g, "\\$"));
      const re = new RegExp(`(?:^|[\\s{,(])["']?(?:${forms.join("|")})["']?\\s*(?::(?!:)|=>|=(?!=))|\\.(?:${forms.join("|")})\\s*=(?!=)|\\[\\s*["'](?:${forms.join("|")})["']\\s*\\]\\s*=(?!=)`);
      for (let r = Math.max(1, from); r <= Math.min(ls.length, to); r++) if (r !== u.line && ls[r - 1].length < 2000 && re.test(ls[r - 1])) lines.add(r);
    }
    if (lines.size) u.alsoLines = [...lines].sort((a, b) => a - b).slice(0, 60);
  }
  for (let i = usages.length - 1; i >= 0; i--) if (usages[i].traceOnly) usages.splice(i, 1);
  extraText.clear();
  splitOf.clear();
  recentText.clear();
  wordFilters.clear();
  // Fix 9: a request header pin (OpenAI-Beta: assistants=v1) goes with the request URL built next to it in the same
  // function (let url = `${baseURL}/threads/${id}/runs/${run}`): that line is also the pin's
  for (const u of usages) {
    if (u.kind !== "version-pin" || !u.apiVersion || !/^[a-z0-9-]+: /.test(u.apiVersion) || /^(?:url|const|setter): /.test(u.apiVersion) || u.doc) continue;
    const ls = lineText(u.file, u.line) === undefined ? undefined : text(u.file)?.split("\n");
    if (!ls) continue;
    const enc = cmLangs.has(langOfRel.get(u.file) ?? "") ? map.enclosing(u.file, u.line) : undefined;
    const [from, to] = enc ? [Math.max(enc.def.start, u.line - 8), Math.min(enc.def.end, u.line + 8)] : [u.line - 8, u.line + 8];
    const urls: number[] = [];
    for (let r = Math.max(1, from); r <= Math.min(ls.length, to); r++) {
      if (r !== u.line && /(?:\burl\b|\bURL\b|\bendpoint\b)\s*[:=]\s*`[^`]*\$\{[^`]*\/[\w{}$/.-]+`|(?:fetch|axios(?:\.\w+)?|got(?:\.\w+)?|request)\(\s*`[^`]*\$\{[^`]*\/[\w{}$/.-]+`/.test(ls[r - 1])) urls.push(r);
    }
    if (urls.length) u.alsoLines = [...new Set([...(u.alsoLines ?? []), ...urls])].sort((a, b) => a - b);
  }
  phase("x:callmap-trace");
  // v9: a version list whose first entry the code takes as its default (current(self::versions()), LIST[0])
  usages.push(...firstVersionDefaults(codeFiles, usages, selectedNames));

  phase("cross-file");
  const configUsages = (await scanConfigAndNotebooks(root)).filter((u) => !ignored(config, u.file));
  // A JSON/JSONL file with many model values is data (eval results, logs, fixtures, a generated model catalog), not
  // configuration: reported as catalog entries, grouped per file when the findings are made
  const perFile = new Map<string, number>();
  for (const u of configUsages) if (/\.jsonl?$/.test(u.file)) perFile.set(u.file, (perFile.get(u.file) ?? 0) + 1);
  for (const u of configUsages) if ((perFile.get(u.file) ?? 0) > DATA_FILE_MODELS && !u.context) Object.assign(u, { listed: true, setting: undefined, context: "catalog", contextReason: `one of ${perFile.get(u.file)} model ids in a data file` });
  usages.push(...configUsages);
  // PHP config defaults read with config('pkg.key') in other files (src/scan/phpconfig.ts)
  {
    const kept = new Set(codeFiles.map((f) => f.rel));
    if (usages.some((u) => u.kind === "version-pin" && /(?:^|\/)config\/[\w/-]+\.php$/.test(u.file))) {
      // every PHP file that reads config (a manager class names no provider of its own), bounded
      let bytes = 0;
      const more = files.filter((f) => f.lang === "php" && !kept.has(f.rel) && !isTestPath(f.rel)).flatMap((f) => {
        if (bytes > 50_000_000) return [];
        try {
          const st = lstatSync(f.path);
          if (!st.isFile() || st.size > 1_000_000) return [];
          const source = readFileSync(f.path, "utf8");
          if (!/\bconfig\s*\(|Config::get/.test(source)) return [];
          bytes += source.length;
          return [{ rel: f.rel, lang: f.lang, source }];
        } catch {
          return [];
        }
      });
      usages.push(...phpConfigReadUsages(guard.lite([...codeFiles.filter((f) => f.lang === "php" && !isTestPath(f.rel)), ...more]), usages).filter(watched));
    }
    // a request setting read as config('pkg.key'): the config file's line for it (src/scan/phpconfig.ts)
    if (usages.some((u) => u.lang === "php" && u.params?.length && /\b(?:config|Config::get)\(/.test(u.snippet ?? ""))) {
      const cfgFiles = files.filter((f) => f.lang === "php" && /(?:^|\/)config\/(?:[\w-]+\/)*[\w-]+\.php$/.test(f.rel) && !isTestPath(f.rel)).slice(0, 200).flatMap((f) => {
        const k = codeFiles.find((c) => c.rel === f.rel);
        if (k) return [k];
        try {
          const st = lstatSync(f.path);
          return st.isFile() && st.size <= 1_000_000 ? [{ rel: f.rel, lang: f.lang, source: readFileSync(f.path, "utf8") }] : [];
        } catch {
          return [];
        }
      });
      usages.push(...phpConfigParamUsages(cfgFiles, usages).filter(watched));
    }
  }
  // A published client library's own API version constant (src/scan/libversion.ts)
  usages.push(...libraryVersionConstUsages(root, files, manifests, usages, isTestPath).filter(watched));
  // Gateways again, now that seeds and model lists in data files are read (a Claude id the repo offers there)
  usages.push(...gatewayClaudeUsages(usages, text, cmResolve, guard.lite(codeFiles).filter((f) => !isTestPath(f.rel) && ["ts", "js", "py", "php", "go"].includes(f.lang)).map((f) => f.rel)));

  phase("config");
  for (const u of usages) {
    if (isTestPath(u.file)) u.inTest = true;
    // The model ID itself can say where it runs (Bedrock IDs/ARNs, Vertex "@version" IDs)
    const h = u.model ? hostOfModel(u.model) : undefined;
    if (h) u.host = h;
    // An SDK pointed at another provider's compatible endpoint (OpenAI SDK → api.groq.com, api.x.ai,
    // api.deepseek.com …) is a call to that provider, so its models and dates apply
    if (u.proxy) {
      const real = providerOfHost(u.proxy);
      if (real && real.id !== u.provider) {
        u.viaSdk = u.provider;
        u.provider = real.id;
        u.proxy = undefined;
      }
    }
    // Never carry a hard-coded key out of the repo: snippets end up in reports, PR checks and issues
    u.snippet = redactSecrets(u.snippet);
    if (u.proxy) u.proxy = redactSecrets(u.proxy);
  }
  inferGoogleHost(usages, sdks);
  // Lint-rule fixtures: code next to a rule file of the same name (semgrep: rule.yaml + rule.py) is test input
  markRuleFixtures(root, usages);
  // A model the code places on a platform (an entry's provider field, an azure: block, a Vertex branch, a Copilot file)
  const byRel = new Map(sources.filter((s) => !s.doc).map((s) => [s.rel, s.source]));
  const extra = new Map<string, string | undefined>();
  placeOnPlatforms(usages, (rel) => {
    if (byRel.has(rel)) return byRel.get(rel);
    if (rel.endsWith(".ipynb")) return undefined;
    // Read once per file (not per usage), never through a symlink, at most 2 MB (review F2/F3)
    if (!extra.has(rel)) {
      let text: string | undefined;
      try {
        const p = join(root, rel);
        const st = lstatSync(p);
        text = st.isFile() && st.size <= 2_000_000 ? readFileSync(p, "utf8") : undefined;
      } catch {
        text = undefined;
      }
      extra.set(rel, text);
    }
    return extra.get(rel);
  });

  // A partner vendor's model known only from src/data/partner-models.json counts only where the code runs it on that
  // platform: "Llama-3.3-70B-Instruct" through Azure is Azure's record; the same name for a local or other host isn't
  usages.splice(0, usages.length, ...usages.filter((u) => {
    const only = u.model ? partnerOnlyHost(u.model) : undefined;
    return !only || u.host === only;
  }));

  // Model IDs found only through a code shape (a model enum, list, per-provider map, model-shaped call) count when
  // the repo shows it really uses that provider: calls, dependencies, imports, a model CLI, or its API key
  let kept = otherEndpoints(usages, byRel);
  // Go templates (and Helm / Sprig) that write a request body with a literal model or setting (src/scan/gotemplates.ts)
  kept.push(...(await goTemplateUsages(root, codeFiles.filter((f) => f.lang === "go"), kept, (rel) => ignored(config, rel) || isTestPath(rel))));
  // v14: a version in a .env file that no code reads (FACEBOOK_GRAPH_VERSION=v3.0, nothing reads it): a copy for users
  await markUnreadEnv(kept, files.map((f) => f.path));
  // SQL seed rows: configuration only when the code reads the table into a provider request (src/scan/sqlseeds.ts)
  kept.push(...(await sqlSeedUsages(root, codeFiles, kept, (rel) => ignored(config, rel), isTestPath)));
  // a template or compose value only counts when code reads it without its own default (src/scan/envdefaults.ts)
  await markEnvDefaults(kept, files, root);
  if (usages.some((u) => u.weak)) {
    const ev = await repoEvidence(root, { usages, sdks, manifests, sources: evidenceLines });
    //
    for (const u of kept) if (u.weak && !provenUse(ev, u.provider) && !u.context) Object.assign(u, { listed: true, context: "catalog", contextReason: "a model id with no request to its provider in the repo" });
  }
  // A model list the repo only ever tests names against (GEMINI_TTS_MODELS.includes(model), `m in VISION_MODELS`),
  // in any file, is a capability list, not models the app offers
  const checkedOnly = await onlyCheckedLists(kept, files.map((f) => f.path));
  // Reported as catalog entries, not dropped: the fix retires or lists them
  for (const u of kept) if (u.owner && checkedOnly.has(u.owner)) Object.assign(u, { listed: true, reason: "a list the code only checks names against" });
  for (const u of kept) {
    delete u.weak;
    delete u.owner;
  }
  // Model names in a vendored copy of another project are that project's
  kept = kept.filter((u) => !(u.kind === "model-ref" && VENDORED.test(u.file)));

  // v4: a value inside a record that's only written out (run metadata, a log entry, a print), or a React context's
  // default, is recorded (src/scan/enclosing.ts). Calls to the provider are never touched
  const blankedOf = new Map<string, { lines: string[]; blanked: string[]; starts: number[] }>();
  for (const u of kept) {
    if (u.doc || u.recorded || !u.model || !byRel.has(u.file)) continue;
    let t = blankedOf.get(u.file);
    if (!t) {
      const lines = byRel.get(u.file)!.split("\n");
      const starts: number[] = [];
      let at = 0;
      for (const l of lines) (starts.push(at), (at += l.length + 1));
      t = { lines, blanked: lines.map((l) => (l.length > 2000 ? "" : blankLine(l))), starts };
      blankedOf.set(u.file, t);
    }
    const [li, col] = posOf(u, t);
    const text = t.lines[li] ?? "";
    if (col < 0 || col > text.length) continue;
    const why = recordedBy(t.lines, t.blanked, li, col);
    if (why) {
      Object.assign(u, { recorded: true, reason: why === "context-default" ? "a default value of a UI context" : "written to a log or record, not used" });
      continue;
    }
    // v5: a field default in a response schema describes what came back; a literal only compared against picks a
    // branch, and nothing sends it. Not in tests: there `assert name == "x"` checks the value, and a fix updates it
    if (u.lang === "py" && inResponseSchema(t.lines, li)) Object.assign(u, { recorded: true, reason: "a default in a response schema" });
    else if (u.kind === "model-ref" && !u.inTest && comparedAt(text, col)) Object.assign(u, { listed: true, reason: "only compared against, not sent" });
    else if (!u.inTest && !u.listed) {
      // v6: an entry in a model catalog (price, context, capabilities), a model registry, or a provider registry's
      // mapping
      const cat = catalogAt(t.lines, t.blanked, li, col);
      // v7: a catalog whose first or chosen entry the app uses (agentModel: defaultQAModels[0]) is a default: it breaks
      const holder = cat ? listHolderAt(t.lines, t.blanked, li, col) : undefined;
      if (cat && !(holder && selectedNames.has(holder))) Object.assign(u, { listed: true, setting: false, reason: cat === "catalog-entry" ? "an entry in a model catalog (price, context or capabilities)" : "an entry in a model registry" });
    }
  }
  // Loaders in languages the scanner doesn't parse (Kotlin, Rust, shell …): read only when a data file isn't settled
  if (kept.some((u) => isDataFile(u.file) && !runtimeConfig(u.file, loadRefs))) {
    for (const f of await listLoaderFiles(root)) collectLoadRefs(await readFile(f, "utf8").catch(() => ""), isTestPath(relative(root, f)) ? testLoadRefs : loadRefs);
  }
  markMockedTests(kept, byRel);
  markAssertedUrls(kept, byRel);
  // Automatic library maps (trial, src/scan/automap.ts): off unless VITASTA_LIBMAP_DIR names a map cache
  if (process.env.VITASTA_LIBMAP_DIR) {
    const readRepo = (rel: string) => {
      if (rel.startsWith("/") || rel.split("/").includes("..")) return undefined;
      try { return readFileSync(join(root, rel), "utf8"); } catch { return undefined; }
    };
    const py: { rel: string; lang: Usage["lang"]; source: string }[] = [];
    let bytes = 0;
    for (const f of files) {
      if (f.lang !== "py" || isTestPath(f.rel) || bytes > 50_000_000) continue;
      const own = codeFiles.find((c) => c.rel === f.rel);
      if (own) { py.push(own); continue; }
      try {
        const st = lstatSync(f.path);
        if (!st.isFile() || st.size > 1_000_000) continue;
        const source = readFileSync(f.path, "utf8");
        bytes += source.length;
        py.push({ rel: f.rel, lang: f.lang, source });
      } catch {
        /* unreadable */
      }
    }
    const am = autoMapUsages(py, readRepo, kept, process.env.VITASTA_LIBMAP_DIR);
    kept.push(...am.usages);
    if (am.unmapped.length) warn(`not mapped yet (findings through them may follow): ${am.unmapped.slice(0, 8).map((x) => `${x.package}${x.version ? `@${x.version}` : ""}`).join(", ")}${am.unmapped.length > 8 ? ", …" : ""}`);
  }
  markGatedSettings(kept);
  await markDeadCode(kept, { files: allFiles, sources, withTree, manifests, root });
  // a request whose URL is a constant of its file: the constant's line too (src/scan/urlconstlines.ts)
  addUrlConstantLines(kept, guard.lite(codeFiles));
  if (guard.skipped().length) warn(`${guard.skipped().length} very large file${guard.skipped().length > 1 ? "s" : ""} got only the per-file checks (over ${600_000 / 1000} KB, 15,000 lines or a 20,000-character line): ${guard.skipped().slice(0, 5).join(", ")}${guard.skipped().length > 5 ? ", …" : ""}`);
  assignRoles(kept, loadRefs, testLoadRefs);
  // A provider's own SDK copied into the repo (a nested module whose manifest names that SDK's package: go.mod's
  // module github.com/anthropics/anthropic-sdk-go, package.json's "name": "@anthropic-ai/sdk"): its code isn't the
  // app's use, so it gives one note at most
  {
    const sdkNames = new Set(PROVIDERS.flatMap((p) => Object.values(p.packages ?? {}).flat()).map((n) => String(n).toLowerCase()));
    const vendoredDirs: { dir: string; name: string }[] = [];
    for (const abs of manifests.filter((m) => /(?:^|\/)(?:go\.mod|package\.json|pyproject\.toml|setup\.py|[\w.-]+\.gemspec|composer\.json|pom\.xml)$/.test(m)).slice(0, 400)) {
      const dir = relative(root, dirname(abs));
      if (!dir) continue;
      let t = "";
      try { t = readFileSync(abs, "utf8").slice(0, 20_000); } catch { continue; }
      const name = (/^module\s+(\S+)/m.exec(t)?.[1] ?? /"name"\s*:\s*"([^"]+)"/.exec(t)?.[1] ?? /^[ \t]*name\s*=\s*["']([^"']+)["']/m.exec(t)?.[1] ?? /<artifactId>([^<]+)<\/artifactId>/.exec(t.split(/<dependencies>/)[0] ?? "")?.[1])?.toLowerCase();
      if (name && (sdkNames.has(name) || sdkNames.has(name.replace(/\/v\d+$/, "")))) vendoredDirs.push({ dir, name });
    }
    if (vendoredDirs.length) {
      const noted = new Set<string>();
      kept = kept.filter((u) => {
        const v = vendoredDirs.find((d) => u.file.startsWith(d.dir + "/"));
        if (!v) return true;
        if (noted.has(v.dir)) return false;
        noted.add(v.dir);
        Object.assign(u, { role: "recorded", reason: `in a copy of ${v.name} vendored at ${v.dir}/ (the SDK's own code, not this app's use)` });
        return true;
      });
    }
  }
  // A provider SDK's own code with no manifest (a built app's bundle modules holding the SDK's resource classes):
  // one note per provider, the rest dropped
  {
    const sdkFile = new Map<string, boolean>();
    const isSdk = (rel: string) => {
      let v = sdkFile.get(rel);
      if (v === undefined) sdkFile.set(rel, (v = isSdkSource(byRel.get(rel) ?? text(rel) ?? "")));
      return v;
    };
    const noted = new Set<string>();
    kept = kept.filter((u) => {
      if (u.role === "recorded" || !isSdk(u.file)) return true;
      if (noted.has(u.provider)) return false;
      noted.add(u.provider);
      Object.assign(u, { role: "recorded", reason: `in a copy of the ${u.provider} SDK's own code (${u.file} defines its resource classes): the SDK, not this app's use` });
      return true;
    });
  }
  kept = versionPinPrecision(kept, byRel);
  // v17: AI SDK sampling settings, by what the installed @ai-sdk/anthropic release does with them
  kept = applyAiSdkSampling(root, kept);
  // v18: sampling settings set through LangChain, ruby_llm or litellm, by what the installed release does with them
  kept = applyLibrarySampling(root, kept, codeFiles);
  // v6, second stage (off unless asked): a small model that can turn a breaks place into a catalog entry
  const wantFeatures = process.env.VITASTA_FEATURES === "1";
  if (opts.catalogModel || wantFeatures) {
    const perFile = new Map<string, number>();
    for (const u of kept) if (u.model) perFile.set(u.file, (perFile.get(u.file) ?? 0) + 1);
    for (const u of kept) {
      if (u.role !== "breaks" || u.inTest || !u.model) continue;
      const t = blankedOf.get(u.file);
      if (!t) continue;
      const [li, col] = posOf(u, t);
      if (col < 0 || col > (t.lines[li] ?? "").length) continue;
      const x = catalogFeatures(t.lines, t.blanked, li, col, u, { lines: t.lines.length, models: perFile.get(u.file) ?? 0 });
      if (wantFeatures) u.features = x;
      const s = opts.catalogModel ? catalogScore(x) : undefined;
      if (s?.catalog) Object.assign(u, { role: "catalog", listed: true, reason: `looks like a catalog entry (model score ${s.p.toFixed(2)})` });
    }
  }
  // A Graph request whose path is built from a variable named for an ad object ({audience_id}/users, act_${account},
  // ${campaignId}/insights) is a Marketing API call, whatever the literal part says
  for (const u of kept) {
    if (u.provider !== "meta" || (u.kind !== "http" && u.kind !== "version-pin") || !u.snippet) continue;
    const vars = [...u.snippet.matchAll(/\$\{([^}]+)\}|\{([A-Za-z_][\w.]*)\}|#\{([^}]+)\}|\+\s*([A-Za-z_$][\w$.]*)\s*\+\s*["'`]\//g)].map((m) => m.slice(1).find(Boolean)!);
    if (vars.some((v) => /(?:custom_?)?audience|ad_?account|adset|ad_?set|campaign|creative|(?:^|[._])ad_?id\b|\bact_/i.test(v)) || /\/act_\$?\{|["'`]act_["'`]\s*\+/.test(u.snippet)) {
      u.provider = "meta-marketing";
      u.reason = `${u.reason ? u.reason + "; " : ""}its path is built from an ad object (Marketing API)`;
    }
  }
  // documentation and agent files that name a provider endpoint (src/scan/docpaths.ts): docs, the "also" tier
  kept.push(...(await docPathUsages(root, (rel) => ignored(config, rel), kept)));
  // a bare Graph base held in a name, joined elsewhere to Marketing endpoints: the Marketing record (src/scan/marketingpaths.ts)
  marketingByPaths(kept, codeFiles);
  // Azure OpenAI: the Azure-path call beside an AzureOpenAI client's OpenAI-path one, the Azure SDKs, Realtime URLs (src/scan/azureopenai.ts)
  kept.push(...azureOpenAiUsages(kept, codeFiles, isTestPath));
  // a path joined to a base URL held in a name (private $base = 'https://graph.microsoft.com/v1.0/me/' . 'drive/recent'): src/scan/baserel.ts
  kept.push(...baseRelUsages(codeFiles, kept, isTestPath));
  // a view's snippet is its real line, not the script-only text it was read as
  for (const u of kept) {
    const t = viewText.get(u.file);
    if (t) u.snippet = (t.split("\n")[u.line - 1] ?? "").trim().slice(0, 200);
  }
  // the names each finding's lines declare (const GRAPH_BASE = …, BASE = f"…{API_VERSION}"): a request line using one
  // is that finding's other line (src/feed/match.ts)
  const DECL = /^\s*(?:(?:export|const|let|var|val|final|static|private|public|protected|readonly|internal)\s+)*(?:[\w<>\[\]?]+\s+)?([A-Za-z_$][\w$]{2,})\s*(?::[^=\n]*)?=(?![=>])/;
  // (an annotation line, @Value("${…:https://…}"), declares the field on the line after it)
  const FIELD_AFTER = /^\s*(?:(?:private|public|protected|internal|static|final|readonly)\s+)*[\w<>\[\]?.]+\s+([A-Za-z_$][\w$]{2,})\s*[;=]/;
  for (const u of kept) {
    if (u.kind !== "version-pin" && u.kind !== "http") continue;
    const names = [u.line, ...(u.alsoLines ?? [])].map((l) => {
      const t = lineText(u.file, l) ?? "";
      const d = DECL.exec(t)?.[1];
      if (d) return d;
      return /^\s*@\w+/.test(t) ? FIELD_AFTER.exec(lineText(u.file, l + 1) ?? "")?.[1] : undefined;
    }).filter((n): n is string => !!n && !/^(?:url|uri|path|value|result|response|data|body|params)$/i.test(n));
    if (!names.length || u.inTest) continue;
    u.declares = [...new Set(names)];
    // a version or URL in a declared name: the calls that use it are its other lines (a fix sees them)
    if (u.kind === "version-pin") {
      const re = new RegExp(`(?<![\\w$.])(?:${u.declares.map((n) => n.replace(/\$/g, "\\$")).join("|")})(?![\\w$])`);
      const extra: number[] = [];
      for (let l = 1; l <= 100000 && extra.length < 20; l++) {
        const t = lineText(u.file, l);
        if (t === undefined) break;
        if (l === u.line || (u.alsoLines ?? []).includes(l) || t.length > 2000 || !re.test(t) || !/\(/.test(t) || DECL.exec(t) || /^\s*(?:\/\/|#|\*|import\b|@)/.test(t)) continue;
        extra.push(l);
      }
      if (extra.length) u.alsoLines = [...new Set([...(u.alsoLines ?? []), ...extra])].sort((a, b) => a - b);
    }
  }
  for (const u of kept) {
    delete u.mocked;
    delete u.urlAsserted;
    // v10: two modules. AI: model IDs and the LLM params of AI providers' calls. API: versions, endpoints and params
    u.module = u.model || isAiProvider(u.provider) ? "ai" : "api";
  }
  // context labels and tiers
  assignTiers(kept);
  phase("finish");
  cache?.save();
  if (cache && prof) process.stderr.write(`[profile] cache hits ${cache.hits} misses ${cache.misses}${cache.changedSinceLast !== undefined ? `, ${cache.changedSinceLast} files changed since the last commit scanned` : ""}\n`);
  return {
    root,
    scannedAt: new Date().toISOString(),
    filesScanned: files.length,
    sdks,
    usages: kept.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };
}

/** Code that sits next to a lint rule of the same name (x.yaml with rules: and a pattern) is that rule's test */
function markRuleFixtures(root: string, usages: Usage[]): void {
  const seen = new Map<string, boolean>();
  for (const u of usages) {
    if (u.inTest) continue;
    const base = u.file.replace(/\.[^./]+$/, "");
    let hit = seen.get(base);
    if (hit === undefined) {
      hit = false;
      // rule.yaml next to rule.py, or rule-python.py next to rule.yaml
      for (const p of [".yaml", ".yml"].flatMap((ext) => [base + ext, base.replace(/-(python|py|javascript|js|typescript|ts|java|go|ruby|rb)$/, "") + ext]).map((f) => join(root, f))) {
        try {
          // lstat: a symlink (to /dev/zero, a FIFO, a file outside the repo) is never read (review F3)
          const st = lstatSync(p);
          if (!st.isFile() || st.size > 200_000) continue;
          const t = readFileSync(p, "utf8");
          if (/^rules\s*:/m.test(t) && /\bpatterns?(-either|-inside|-not)?\s*:/.test(t)) hit = true;
        } catch {
          /* no such file */
        }
      }
      seen.set(base, hit);
    }
    if (hit) u.inTest = true;
  }
}

/**
 * Names of model lists whose every use across the repo's code is a membership or prefix test. Reads each code file
 * once, only when some listed model came from a named list.
 */
async function onlyCheckedLists(usages: Usage[], paths: string[]): Promise<Set<string>> {
  const names = [...new Set(usages.map((u) => u.owner).filter((x): x is string => !!x))];
  const out = new Set<string>();
  if (!names.length) return out;
  const any = new RegExp(`\\b(${names.join("|")})\\b`, "g");
  const checks = new Map<string, number>(), uses = new Map<string, number>();
  for (const p of paths) {
    let text: string;
    try {
      text = await readFile(p, "utf8");
    } catch {
      continue;
    }
    if (text.length > 2_000_000) continue;
    for (const m of text.matchAll(any)) {
      const name = m[1];
      const i = m.index!;
      const before = text.slice(Math.max(0, i - 80), i);
      const after = text.slice(i + name.length, i + name.length + 40);
      const lineStart = text.lastIndexOf("\n", i - 1) + 1;
      const line = text.slice(lineStart, text.indexOf("\n", i) < 0 ? undefined : text.indexOf("\n", i));
      // neutral: the definition, imports and exports, types (typeof X[number]), comments
      if (/^\s*(import|from|export\s*\{|\}\s*from|#|\/\/|\*)/.test(line) || /^\s*(as\s+const\b)?\s*[:=](?!=)/.test(after) || /typeof\s*$/.test(before) || /^\s*\[\s*number\s*\]/.test(after) || /\bexport\s+(const|let|var)\s*$/.test(before) || /\b(const|let|var|final|static)\s+[\w<>\[\], ]*$/.test(before)) continue;
      const isCheck = /^(\s+as\s+[\w\s\[\]<>|]+)?\s*\)?\s*(\?\.|\.)\s*(has|includes|contains|indexOf|some|find|containsKey)\s*\(/.test(after) ||
        /\b(not\s+)?in\s+(self\.|this\.|cls\.|\w+\.)?$/.test(before) || /\.(startswith|endswith|startsWith|endsWith)\(\s*(tuple\()?\s*(self\.|this\.)?$/.test(before);
      (isCheck ? checks : uses).set(name, ((isCheck ? checks : uses).get(name) ?? 0) + 1);
    }
  }
  for (const n of names) if ((checks.get(n) ?? 0) > 0 && !(uses.get(n) ?? 0)) out.add(n);
  return out;
}

/** Fill in alsoLines from character spans, so a multi-line call counts as changed when its model line changes. */
/**
 * Quoted IDs of a provider's own objects (see ProviderDef.resourceIds), one usage per line, unless the file already
 * has that call with those parameters (then the call itself is the finding).
 */
function resourceUsages(file: string, lang: Lang, source: string, found: Usage[]): Usage[] {
  const out: Usage[] = [];
  for (const p of PROVIDERS) {
    for (const r of p.resourceIds ?? []) {
      const covered = found.some((u) => u.provider === p.id && u.op === r.op && (r.params ?? []).every((x) => u.params?.includes(x)));
      if (covered) continue;
      const body = r.pattern.source.replace(/^\^|\$$/g, "");
      const lines = new Set<number>();
      const all = linesOf(source);
      let at = 0;
      let line = 1;
      for (const m of source.matchAll(new RegExp(`["'\`](${body})["'\`]`, "g"))) {
        // Count lines from the last match on, not from the start of the file each time (review F2)
        for (let k = at; k < m.index!; k++) if (source.charCodeAt(k) === 10) line++;
        at = m.index!;
        if (lines.has(line)) continue;
        lines.add(line);
        const text = all[line - 1] ?? "";
        out.push({
          provider: p.id, kind: "http", lang, file, line, op: r.op, ...(r.params ? { params: r.params } : {}),
          confidence: "likely", snippet: text.trim().slice(0, 200), resource: r.what,
        });
      }
    }
  }
  return out;
}

function withLines(usages: Usage[], source: string): Usage[] {
  let starts: number[] | undefined;
  const lineAt = (i: number) => {
    starts ??= [0, ...[...source.matchAll(/\n/g)].map((m) => m.index! + 1)];
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const u of usages) {
    const spans = [u.modelSpan, ...Object.values(u.paramSpans ?? {})].filter((x): x is { start: number; end: number } => !!x);
    const lines = new Set<number>();
    for (const sp of spans) for (let l = lineAt(sp.start); l <= lineAt(Math.max(sp.start, sp.end - 1)); l++) if (l !== u.line) lines.add(l);
    if (lines.size) u.alsoLines = [...lines].sort((a, b) => a - b);
  }
  return usages;
}

/** A test file that replaces the provider client or its HTTP calls */
const MOCKS_CLIENT = /\b(MagicMock|AsyncMock|mock\.patch|patch\.object|vi\.mock|jest\.mock|vi\.fn|jest\.fn|respx|nock|httpx_mock|requests_mock|aioresponses|responses\.add|setupServer|mockResolvedValue|mockReturnValue|return_value|gomock|httptest\.NewServer|WireMock|Mockito|sinon\.stub)\b/;
/** An assertion, and calls that check what a mock received */
const ASSERT_LINE = /\bassert\w*\b|\bexpect\(|called_with|calledWith|CalledWith|toHaveBeenCalled|\bverify\(|\.Equal\(|assertThat/;
const ASSERT_WINDOW = 6;

/**
 * v5: in a test that mocks the provider client, a model no assertion names is only test input: a retirement can't
 * break the test and the fix needn't edit it. A model an assertion names (within a few lines of it) keeps test-asserts,
 * and so do its settings, so a fix edits both together.
 */
function markMockedTests(usages: Usage[], byRel: Map<string, string>): void {
  const asserted = new Map<string, string | undefined>();
  for (const u of usages) {
    if (!u.model || !(u.inTest || /(^|\/)(tests?|__tests__|specs?)\//i.test(u.file))) continue;
    if (!asserted.has(u.file)) {
      const text = byRel.get(u.file);
      if (!text || !MOCKS_CLIENT.test(text)) asserted.set(u.file, undefined);
      else {
        const lines = text.split("\n");
        const keep: string[] = [];
        for (let i = 0; i < lines.length; i++) if (lines[i].length <= 2000 && ASSERT_LINE.test(lines[i])) keep.push(lines.slice(i, i + ASSERT_WINDOW).join("\n"));
        asserted.set(u.file, keep.join("\n"));
      }
    }
    const a = asserted.get(u.file);
    if (a !== undefined && !a.includes(u.model)) u.mocked = true;
  }
}

/** A usage's own position (0-based line, column): its edit span if it has one (a call's usage line can be the call's), else its line */
function posOf(u: Usage, t: { lines: string[]; starts: number[] }): [number, number] {
  let li = u.line - 1;
  if (u.modelSpan) {
    const start = u.modelSpan.start;
    let lo = 0;
    let hi = t.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t.starts[mid] <= start) lo = mid;
      else hi = mid - 1;
    }
    li = lo;
  }
  const text = t.lines[li] ?? "";
  return [li, u.modelSpan ? u.modelSpan.start - t.starts[li] : text.indexOf(u.model!)];
}

/**
 * v7: request stubs and expectations that match a URL (WebMock stub_request, to have_requested,
 * toMatchMadeHttpRequest, nock, msw handlers, respx, responses, requests_mock), and plain assertions
 */
const URL_ASSERT = /\bstub_request\b|\bhave_requested\b|\bhave_been_requested\b|\bWebMock\b|toMatchMadeHttpRequest|toHaveBeenCalledWith|toHaveBeenLastCalledWith|\bnock\(|\.intercept\(|\bhttp\.(get|post|put|patch|delete)\(|\brest\.(get|post|put|patch|delete)\(|\brespx\.|\bresponses\.(add|get|post)|\brequests_mock\.|\bhttpretty\.|\bexpect\(|\bassert\w*\b|\.to\s*\(?\s*eq\b|\.toBe\(|\.toEqual\(|assertThat/;
const URL_ASSERT_WINDOW = 6;

/** v7: in a test, an API version in a URL that a stub or an assertion matches is asserted: changing it changes the test */
function markAssertedUrls(usages: Usage[], byRel: Map<string, string>): void {
  const linesOf = new Map<string, string[]>();
  for (const u of usages) {
    if (u.model || !u.apiVersion || !(u.inTest || isTestPath(u.file))) continue;
    let lines = linesOf.get(u.file);
    if (!lines) linesOf.set(u.file, (lines = (byRel.get(u.file) ?? "").split("\n")));
    const from = Math.max(0, u.line - 1 - URL_ASSERT_WINDOW);
    if (lines.slice(from, u.line).some((l) => l.length <= 2000 && URL_ASSERT.test(l))) u.urlAsserted = true;
  }
}

/** The parameter names feed records select, by provider (for scanRepo's watchParams) */
export function watchParamsOf(feed: { provider: string; selector: { params?: string[] } }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of feed) for (const p of c.selector.params ?? []) {
    if (!out.has(c.provider)) out.set(c.provider, new Set());
    out.get(c.provider)!.add(p);
  }
  return out;
}

/** The words in a text (identifiers), as a small Bloom filter: a word not in it is surely not in the text */
function wordFilter(text: string): Uint32Array {
  const words = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const f = new Uint32Array(Math.ceil(Math.max(1024, Math.min(1 << 20, words.size * 12)) / 32));
  const bits = f.length * 32;
  for (const w of words) for (const h of wordHashes(w, bits)) f[h >>> 5] |= 1 << (h & 31);
  return f;
}
function wordHashes(w: string, bits: number): number[] {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = (Math.imul(b, 33) + c) >>> 0;
  }
  return [a % bits, (a + b) % bits, (a + 2 * b) % bits];
}
/** Could the text hold this string? Every whole word in it must be in the filter (a string with none: maybe) */
function mayHave(f: Uint32Array, s: string): boolean {
  const bits = f.length * 32;
  for (const w of s.match(/[A-Za-z_$][\w$]*/g) ?? []) for (const h of wordHashes(w, bits)) if (!(f[h >>> 5] & (1 << (h & 31)))) return false;
  return true;
}

const GENERATED_NAME = /(?:\.generated\.|\.g\.cs$|\.Designer\.cs$|\.pb\.go$|_pb2\.py$|\.gen\.go$|_generated\.)/i;
const GENERATED_HEADER = /<auto-generated|@generated\b|Code generated .* DO NOT EDIT|This (?:file|code) (?:was|is) (?:automatically |auto-)generated|DO NOT EDIT[.!]? (?:This file|Generated)/i;
/**
 * Version pins in generated files (a generated entity's doc comments and attributes) aren't the app's: dropped, like
 * vendored code. A pin inside an enum that lists two or more versions of the provider (V18("v18.0"), V21("v21.0"))
 * is a catalog of versions, not the one the app sends; a use of one of its constants in a URL is reported where used.
 */
function versionPinPrecision(usages: Usage[], text: Map<string, string>): Usage[] {
  const generated = new Map<string, boolean>();
  const isGenerated = (rel: string) => {
    if (!generated.has(rel)) {
      const head = (text.get(rel) ?? "").split("\n", 12).join("\n");
      generated.set(rel, GENERATED_NAME.test(rel) || GENERATED_HEADER.test(head));
    }
    return generated.get(rel)!;
  };
  // enum bodies by file: [start, end] lines
  const enums = new Map<string, [number, number][]>();
  const enumsOf = (rel: string) => {
    if (enums.has(rel)) return enums.get(rel)!;
    const ls = (text.get(rel) ?? "").split("\n");
    const out: [number, number][] = [];
    ls.forEach((l, i) => {
      if (!/\benum\s+(?:class\s+)?[A-Z]\w*|\bclass\s+\w+\s*\([^)]*\bEnum\b[^)]*\)\s*:/.test(l) || l.length > 2000) return;
      if (/\(\s*[^)]*Enum[^)]*\)\s*:/.test(l)) {
        // Python: the indented block
        const ind = /^\s*/.exec(l)![0].length;
        let e = i + 1;
        while (e < ls.length && (!ls[e].trim() || /^\s*/.exec(ls[e])![0].length > ind)) e++;
        out.push([i + 1, e]);
        return;
      }
      let depth = 0, started = false;
      for (let r = i; r < Math.min(ls.length, i + 400); r++) {
        for (const c of ls[r]) {
          if (c === "{") { depth++; started = true; }
          else if (c === "}") depth--;
        }
        if (started && depth <= 0) { out.push([i + 1, r + 1]); break; }
      }
    });
    enums.set(rel, out);
    return out;
  };
  const pins = usages.filter((u) => u.kind === "version-pin" && u.apiVersion);
  const inEnum = (u: Usage) => enumsOf(u.file).find(([a, b]) => u.line >= a && u.line <= b);
  const listed = new Map<string, Set<string>>();
  for (const u of pins) {
    const e = inEnum(u);
    if (!e) continue;
    const k = `${u.file}|${e[0]}|${u.provider}`;
    listed.set(k, (listed.get(k) ?? new Set()).add(u.apiVersion!.split(": ").pop()!));
  }
  return usages.filter((u) => {
    if (u.kind !== "version-pin" || !u.apiVersion) return true;
    if (isGenerated(u.file)) return false;
    const e = inEnum(u);
    if (e && (listed.get(`${u.file}|${e[0]}|${u.provider}`)?.size ?? 0) >= 2) u.role = "catalog";
    return true;
  });
}
