import { providerOfHost } from "../providers.js";
import { redactSecrets } from "../redact.js";
import { readFile } from "node:fs/promises";
import { ignored, loadRepoConfig, type RepoConfig } from "../config.js";
import { PROVIDERS, hostOfModel, providersVersion, withProviders } from "../providers.js";
import type { ApiMap, Lang, SdkDependency, Usage } from "../types.js";
import { analyzeGeneric } from "./generic.js";
import { scanConfigAndNotebooks } from "./config.js";
import { listManifests, listSourceFiles } from "./files.js";
import { analyzeJava } from "./java.js";
import { analyzeJs, collectExports, type ExportedClients } from "./js.js";
import { readSdkDependencies } from "./manifest.js";
import { parse, type Tree } from "./parser.js";
import { analyzePy } from "./py.js";

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
function prefilter(): RegExp {
  if (PREFILTER?.version === providersVersion) return PREFILTER.re;
  const words = new Set(["claude-", "gpt-", "gemini", "genai", "vertexai", "bedrock", "imagen", "veo-", "bison", "gecko", "octokit", "\\bo[1-9]\\b"]);
  for (const p of PROVIDERS) {
    words.add(p.id);
    for (const h of p.hosts) words.add(h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    for (const list of Object.values(p.packages)) for (const pkg of list ?? []) words.add(pkg.split(/[/:]/).pop()!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    for (const k of p.keywords ?? []) words.add(k);
    for (const r of p.resourceIds ?? []) words.add(r.pattern.source.replace(/^\^|\$$/g, ""));
  }
  PREFILTER = { version: providersVersion, re: new RegExp([...words].join("|"), "i") };
  return PREFILTER.re;
}

/** Tests, examples and fixtures still matter, but rank below production code. */
export function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__|spec|specs|e2e|fixtures?|__mocks__|examples?|samples?|bench|benchmarks?|testdata)\//i.test(rel) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) ||
    /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(rel) ||
    /(^|\/)conftest\.py$/.test(rel)
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
/** More model values than this in one JSON file means it holds data, not settings */
const DATA_FILE_MODELS = 25;

export async function scanRepo(root: string, opts: { onWarn?: (msg: string) => void } = {}): Promise<ApiMap> {
  const config = await loadRepoConfig(root);
  for (const w of config.warnings) (opts.onWarn ?? (() => {}))(w);
  // The repo's own APIs apply to this scan only
  const map = await withProviders(config.providers, () => scanWithConfig(root, config, opts));
  return { ...map, config };
}

async function scanWithConfig(root: string, config: RepoConfig, opts: { onWarn?: (msg: string) => void }): Promise<ApiMap> {
  const warn = opts.onWarn ?? (() => {});
  const [allFiles, manifests] = await Promise.all([listSourceFiles(root), listManifests(root)]);
  const files = allFiles.filter((f) => !ignored(config, f.rel));
  const sdks = await readSdkDependencies(root, manifests);

  const parsed: { rel: string; abs: string; lang: Lang; source: string; tree: Tree }[] = [];
  for (const f of files) {
    let source: string;
    try {
      source = await readFile(f.path, "utf8");
    } catch {
      continue;
    }
    // Cheap prefilter: skip files that can't possibly mention a provider
    if (!prefilter().test(source)) continue;
    try {
      parsed.push({ rel: f.rel, abs: f.path, lang: f.lang, source, tree: await parse(f.lang, f.rel, source) });
    } catch (e) {
      warn(`could not parse ${f.rel}: ${(e as Error).message}`);
    }
  }

  // JS/TS pass 1: which files export a constructed client
  const exported: ExportedClients = new Map();
  for (const p of parsed) {
    if (p.lang === "ts" || p.lang === "js") collectExports(p.rel, p.abs, p.lang, p.source, p.tree, exported);
  }

  const usages: Usage[] = [];
  for (const p of parsed) {
    try {
      const analyze = ANALYZERS[p.lang];
      if (analyze) {
        const found = withLines(analyze({ ...p, exported }), p.source);
        usages.push(...found, ...resourceUsages(p.rel, p.lang, p.source, found));
      }
    } catch (e) {
      warn(`could not analyze ${p.rel}: ${(e as Error).message}`);
    } finally {
      p.tree.delete();
    }
  }

  const configUsages = (await scanConfigAndNotebooks(root)).filter((u) => !ignored(config, u.file));
  // A JSON/JSONL file with many model values is data (eval results, logs, fixtures), not configuration
  const perFile = new Map<string, number>();
  for (const u of configUsages) if (/\.jsonl?$/.test(u.file)) perFile.set(u.file, (perFile.get(u.file) ?? 0) + 1);
  usages.push(...configUsages.filter((u) => (perFile.get(u.file) ?? 0) <= DATA_FILE_MODELS));

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

  return {
    root,
    scannedAt: new Date().toISOString(),
    filesScanned: files.length,
    sdks,
    usages: usages.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };
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
      for (const m of source.matchAll(new RegExp(`["'\`](${body})["'\`]`, "g"))) {
        const line = source.slice(0, m.index).split("\n").length;
        if (lines.has(line)) continue;
        lines.add(line);
        const text = source.split("\n")[line - 1] ?? "";
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
