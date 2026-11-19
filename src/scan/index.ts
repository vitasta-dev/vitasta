import { providerOfHost } from "../providers.js";
import { redactSecrets } from "../redact.js";
import { readFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ignored, loadRepoConfig, type RepoConfig } from "../config.js";
import { PROVIDERS, hostOfModel, partnerOnlyHost, providersVersion, withProviders } from "../providers.js";
import type { ApiMap, Lang, SdkDependency, Usage } from "../types.js";
import { analyzeGeneric } from "./generic.js";
import { scanConfigAndNotebooks } from "./config.js";
import { listDocFiles, listManifests, listSourceFiles } from "./files.js";
import { markdownCode, pythonStringCode, templateCode } from "./embedded.js";
import { assignRoles } from "./roles.js";
import { analyzeJava } from "./java.js";
import { analyzeJs, collectExports, type ExportedClients } from "./js.js";
import { readSdkDependencies } from "./manifest.js";
import { linesOf, parse, type Tree } from "./parser.js";
import { urlVersionUsages } from "./urls.js";
import { provenUse, repoEvidence } from "./evidence.js";
import { placeOnPlatforms } from "./platform.js";
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
    /(^|\/)(test|tests|__tests__|spec|specs|e2e|fixtures?|__fixtures__|__mocks__|mocks?|fakes?|stubs?|cassettes|testing|test[-_]?utils?|testdata|examples?|samples?|demos?|bench|benchmarks?)\//i.test(rel) ||
    // sampleTraces.ts, mockData.js, fakeUsers.py: camelCase sample and mock data files
    /(^|\/)(sample|mock|fake|dummy|demo|seed|fixture)[A-Z][^/]*\.[a-z]+$/.test(rel) ||
    /\.(test|spec|mock|stories|(v|e2e|it|int|unit|integ|vi|jest|pw)(test|spec))\.[cm]?[jt]sx?$/.test(rel) ||
    /_test\.go$|(Test|Tests|IT|Spec)\.(java|kt|cs)$|_spec\.rb$|(^|\/)test_[^/]*\.rb$|Test\.php$/.test(rel) ||
    // sample, seed, demo, mock and recorded-session data files outside test folders: sample_dataset.ts, seed-demo.ts
    /(^|\/)([^/]*[-_.])?(tests?|specs?|mocks?|fakes?|stubs?|dummy|fixtures?|samples?|seeds?|demos?|examples?|smoke|typecheck(ing)?)([-_.][^/]*)?\.[a-z]+$/i.test(rel) ||
    /(^|\/)typecheck(ing)?\//i.test(rel) ||
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
const MAX_SOURCE_BYTES = 100_000_000;

export async function scanRepo(root: string, opts: { onWarn?: (msg: string) => void; configText?: string | null } = {}): Promise<ApiMap> {
  const config = await loadRepoConfig(root, opts.configText);
  for (const w of config.warnings) (opts.onWarn ?? (() => {}))(w);
  // The repo's own APIs apply to this scan only
  const map = await withProviders(config.providers, () => scanWithConfig(root, config, opts));
  return { ...map, config };
}

async function scanWithConfig(root: string, config: RepoConfig, opts: { onWarn?: (msg: string) => void }): Promise<ApiMap> {
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
  let cappedWarned = false;
  for (const f of files) {
    let source: string;
    try {
      source = await readFile(f.path, "utf8");
    } catch {
      continue;
    }
    if (keptBytes + source.length > MAX_SOURCE_BYTES) {
      if (!cappedWarned) warn(`stopped reading source files after ${Math.round(MAX_SOURCE_BYTES / 1_000_000)} MB; the rest of the repo wasn't scanned`);
      cappedWarned = true;
      continue;
    }
    const lines = source.split("\n").filter((l) => l.length < 400 && EVIDENCE_LINE.test(l));
    if (lines.length) evidenceLines.push(lines.join("\n"));
    // Cheap prefilter: skip files that can't possibly mention a provider
    if (prefilter().test(source)) {
      sources.push({ rel: f.rel, abs: f.path, lang: f.lang, source });
      keptBytes += source.length;
      // Code samples held in template strings, scanned as documentation (src/scan/embedded.ts)
      if (f.lang === "ts" || f.lang === "js") for (const v of templateCode(source)) if (prefilter().test(v.source)) sources.push({ rel: f.rel, abs: f.path, lang: v.lang, source: v.source, doc: true });
      if (f.lang === "py") for (const v of pythonStringCode(source)) if (prefilter().test(v.source)) sources.push({ rel: f.rel, abs: f.path, lang: v.lang, source: v.source, doc: true, shifted: v.shifted });
    }
  }
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

  // JS/TS pass 1: which files export a constructed client (needed before any file is analyzed)
  const exported: ExportedClients = new Map();
  for (const p of sources) {
    const lang = p.lang;
    if ((lang === "ts" || lang === "js") && !p.doc) await withTree(p, (tree) => collectExports(p.rel, p.abs, lang, p.source, tree, exported));
  }

  const usages: Usage[] = [];
  for (const p of sources) {
    const analyze = ANALYZERS[p.lang];
    if (!analyze) continue;
    await withTree(p, (tree) => {
      const found = withLines(analyze({ ...p, tree, exported }), p.source);
      if (p.doc) for (const u of found) u.doc = true;
      // Offsets in a shifted source aren't the file's: no edit positions, so no fix can touch the wrong place
      if (p.shifted) for (const u of found) { delete u.modelSpan; delete u.paramSpans; }
      usages.push(...found, ...resourceUsages(p.rel, p.lang, p.source, found), ...urlVersionUsages(tree, p.rel, p.lang, p.source, found));
    });
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
  let kept = usages;
  if (usages.some((u) => u.weak)) {
    const ev = await repoEvidence(root, { usages, sdks, manifests, sources: evidenceLines });
    kept = usages.filter((u) => !u.weak || provenUse(ev, u.provider));
  }
  // A model list the repo only ever tests names against (GEMINI_TTS_MODELS.includes(model), `m in VISION_MODELS`),
  // in any file, is a capability list, not models the app offers
  const checkedOnly = await onlyCheckedLists(kept, files.map((f) => f.path));
  // Reported as catalog entries, not dropped: the fix retires or lists them (founder, 19 Nov)
  for (const u of kept) if (u.owner && checkedOnly.has(u.owner)) Object.assign(u, { listed: true, reason: "a list the code only checks names against" });
  for (const u of kept) {
    delete u.weak;
    delete u.owner;
  }
  // Model names in a vendored copy of another project are that project's
  kept = kept.filter((u) => !(u.kind === "model-ref" && VENDORED.test(u.file)));

  assignRoles(kept);
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
