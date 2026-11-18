import { providerOfHost } from "../providers.js";
import { redactSecrets } from "../redact.js";
import { readFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ignored, loadRepoConfig } from "../config.js";
import { PROVIDERS, hostOfModel, providersVersion, withProviders } from "../providers.js";
import { analyzeGeneric } from "./generic.js";
import { scanConfigAndNotebooks } from "./config.js";
import { listManifests, listSourceFiles } from "./files.js";
import { analyzeJava } from "./java.js";
import { analyzeJs, collectExports } from "./js.js";
import { readSdkDependencies } from "./manifest.js";
import { parse } from "./parser.js";
import { urlVersionUsages } from "./urls.js";
import { provenUse, repoEvidence } from "./evidence.js";
import { placeOnPlatforms } from "./platform.js";
import { analyzePy } from "./py.js";
/**
 * One analyzer per language. JS/TS, Python and Java follow SDK clients into calls; Go, Ruby, PHP and C# get the
 * string-level analysis (URLs, version headers, model settings). Adding a language = a grammar + an entry here.
 */
export const ANALYZERS = {
    ts: (i) => analyzeJs(i.rel, i.abs, i.lang, i.source, i.tree, i.exported),
    js: (i) => analyzeJs(i.rel, i.abs, i.lang, i.source, i.tree, i.exported),
    py: (i) => analyzePy(i.rel, i.source, i.tree),
    java: (i) => analyzeJava(i.rel, i.source, i.tree),
    go: (i) => analyzeGeneric(i.rel, i.lang, i.source, i.tree),
    rb: (i) => analyzeGeneric(i.rel, i.lang, i.source, i.tree),
    php: (i) => analyzeGeneric(i.rel, i.lang, i.source, i.tree),
    cs: (i) => analyzeGeneric(i.rel, i.lang, i.source, i.tree),
};
export function registerAnalyzer(lang, analyzer) {
    ANALYZERS[lang] = analyzer;
}
/** Cheap skip for files that can't mention any provider: built from every registered provider, so new ones count. */
let PREFILTER;
function prefilter() {
    if (PREFILTER?.version === providersVersion)
        return PREFILTER.re;
    const words = new Set(["claude-", "gpt-", "gemini", "genai", "vertexai", "bedrock", "imagen", "veo-", "bison", "gecko", "octokit", "\\bo[1-9]\\b"]);
    for (const p of PROVIDERS) {
        words.add(p.id);
        for (const h of p.hosts)
            words.add(h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        for (const list of Object.values(p.packages))
            for (const pkg of list ?? [])
                words.add(pkg.split(/[/:]/).pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        for (const k of p.keywords ?? [])
            words.add(k);
        for (const r of p.resourceIds ?? [])
            words.add(r.pattern.source.replace(/^\^|\$$/g, ""));
    }
    PREFILTER = { version: providersVersion, re: new RegExp([...words].join("|"), "i") };
    return PREFILTER.re;
}
/** Tests, examples and fixtures still matter, but rank below production code. */
export function isTestPath(rel) {
    return (/(^|\/)(test|tests|__tests__|spec|specs|e2e|fixtures?|__fixtures__|__mocks__|mocks?|fakes?|stubs?|cassettes|testing|test[-_]?utils?|testdata|examples?|samples?|demos?|bench|benchmarks?)\//i.test(rel) ||
        // sampleTraces.ts, mockData.js, fakeUsers.py: camelCase sample and mock data files
        /(^|\/)(sample|mock|fake|dummy|demo|seed|fixture)[A-Z][^/]*\.[a-z]+$/.test(rel) ||
        /\.(test|spec|mock|stories|(v|e2e|it|int|unit|integ|vi|jest|pw)(test|spec))\.[cm]?[jt]sx?$/.test(rel) ||
        /_test\.go$|(Test|Tests|IT|Spec)\.(java|kt|cs)$|_spec\.rb$|(^|\/)test_[^/]*\.rb$|Test\.php$/.test(rel) ||
        // sample, seed, demo, mock and recorded-session data files outside test folders: sample_dataset.ts, seed-demo.ts
        /(^|\/)([^/]*[-_.])?(tests?|specs?|mocks?|fakes?|stubs?|dummy|fixtures?|samples?|seeds?|demos?|examples?|smoke|typecheck(ing)?)([-_.][^/]*)?\.[a-z]+$/i.test(rel) ||
        /(^|\/)typecheck(ing)?\//i.test(rel) ||
        /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(rel) ||
        /(^|\/)conftest\.py$/.test(rel));
}
/**
 * Gemini models have one schedule on the Gemini API and another on Vertex AI, and the model string alone
 * doesn't say which. If the repo only ever uses Vertex (vertexai SDK or vertexai=True clients), apply the
 * Vertex schedule to its Gemini references too. If it uses both, or we can't tell, leave them alone.
 */
function inferGoogleHost(usages, sdks) {
    const google = usages.filter((u) => u.provider === "google");
    if (!google.length)
        return;
    const calls = google.filter((u) => u.kind === "sdk" || u.kind === "http");
    const vertexCalls = calls.filter((u) => u.host === "vertex").length;
    const vertexSdk = sdks.some((s) => /vertexai|aiplatform/.test(s.name));
    const geminiApiSdk = sdks.some((s) => /^(@google\/genai|@google\/generative-ai|google-genai|google-generativeai)$/.test(s.name));
    const onlyVertex = (vertexCalls > 0 && vertexCalls === calls.length) || (vertexSdk && !geminiApiSdk && calls.every((u) => u.host === "vertex"));
    if (onlyVertex)
        for (const u of google)
            u.host ??= "vertex";
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
export async function scanRepo(root, opts = {}) {
    const config = await loadRepoConfig(root, opts.configText);
    for (const w of config.warnings)
        (opts.onWarn ?? (() => { }))(w);
    // The repo's own APIs apply to this scan only
    const map = await withProviders(config.providers, () => scanWithConfig(root, config, opts));
    return { ...map, config };
}
async function scanWithConfig(root, config, opts) {
    const warn = opts.onWarn ?? (() => { });
    const [allFiles, manifests] = await Promise.all([listSourceFiles(root), listManifests(root)]);
    const files = allFiles.filter((f) => !ignored(config, f.rel));
    const sdks = await readSdkDependencies(root, manifests);
    // Only sources are kept for the whole scan. Each file's syntax tree lives just while that file is being looked at:
    // tree-sitter's memory is capped (about 2 GB), and holding every tree of a big repo at once overflows it.
    const sources = [];
    // From every file, only the lines that can show the repo uses a provider: imports, API key names, process calls
    const evidenceLines = [];
    for (const f of files) {
        let source;
        try {
            source = await readFile(f.path, "utf8");
        }
        catch {
            continue;
        }
        const lines = source.split("\n").filter((l) => l.length < 400 && EVIDENCE_LINE.test(l));
        if (lines.length)
            evidenceLines.push(lines.join("\n"));
        // Cheap prefilter: skip files that can't possibly mention a provider
        if (prefilter().test(source))
            sources.push({ rel: f.rel, abs: f.path, lang: f.lang, source });
    }
    /** Parse one file, run `use` on its tree, and always free the tree. A file that can't be parsed is skipped. */
    async function withTree(p, use) {
        let tree;
        try {
            tree = await parse(p.lang, p.rel, p.source);
        }
        catch (e) {
            warn(`could not parse ${p.rel}: ${e.message}`);
            return;
        }
        try {
            use(tree);
        }
        catch (e) {
            warn(`could not analyze ${p.rel}: ${e.message}`);
        }
        finally {
            tree.delete();
        }
    }
    // JS/TS pass 1: which files export a constructed client (needed before any file is analyzed)
    const exported = new Map();
    for (const p of sources) {
        const lang = p.lang;
        if (lang === "ts" || lang === "js")
            await withTree(p, (tree) => collectExports(p.rel, p.abs, lang, p.source, tree, exported));
    }
    const usages = [];
    for (const p of sources) {
        const analyze = ANALYZERS[p.lang];
        if (!analyze)
            continue;
        await withTree(p, (tree) => {
            const found = withLines(analyze({ ...p, tree, exported }), p.source);
            usages.push(...found, ...resourceUsages(p.rel, p.lang, p.source, found), ...urlVersionUsages(tree, p.rel, p.lang, p.source, found));
        });
    }
    const configUsages = (await scanConfigAndNotebooks(root)).filter((u) => !ignored(config, u.file));
    // A JSON/JSONL file with many model values is data (eval results, logs, fixtures), not configuration
    const perFile = new Map();
    for (const u of configUsages)
        if (/\.jsonl?$/.test(u.file))
            perFile.set(u.file, (perFile.get(u.file) ?? 0) + 1);
    usages.push(...configUsages.filter((u) => (perFile.get(u.file) ?? 0) <= DATA_FILE_MODELS));
    for (const u of usages) {
        if (isTestPath(u.file))
            u.inTest = true;
        // The model ID itself can say where it runs (Bedrock IDs/ARNs, Vertex "@version" IDs)
        const h = u.model ? hostOfModel(u.model) : undefined;
        if (h)
            u.host = h;
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
        if (u.proxy)
            u.proxy = redactSecrets(u.proxy);
    }
    inferGoogleHost(usages, sdks);
    // Lint-rule fixtures: code next to a rule file of the same name (semgrep: rule.yaml + rule.py) is test input
    markRuleFixtures(root, usages);
    // A model the code places on a platform (an entry's provider field, an azure: block, a Vertex branch, a Copilot file)
    const byRel = new Map(sources.map((s) => [s.rel, s.source]));
    placeOnPlatforms(usages, (rel) => {
        if (byRel.has(rel))
            return byRel.get(rel);
        if (rel.endsWith(".ipynb"))
            return undefined;
        try {
            const p = join(root, rel);
            return statSync(p).size <= 2_000_000 ? readFileSync(p, "utf8") : undefined;
        }
        catch {
            return undefined;
        }
    });
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
    kept = kept.filter((u) => !(u.owner && checkedOnly.has(u.owner)));
    for (const u of kept) {
        delete u.weak;
        delete u.owner;
    }
    // Model names in a vendored copy of another project are that project's
    kept = kept.filter((u) => !(u.kind === "model-ref" && VENDORED.test(u.file)));
    return {
        root,
        scannedAt: new Date().toISOString(),
        filesScanned: files.length,
        sdks,
        usages: kept.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    };
}
/** Code that sits next to a lint rule of the same name (x.yaml with rules: and a pattern) is that rule's test */
function markRuleFixtures(root, usages) {
    const seen = new Map();
    for (const u of usages) {
        if (u.inTest)
            continue;
        const base = u.file.replace(/\.[^./]+$/, "");
        let hit = seen.get(base);
        if (hit === undefined) {
            hit = false;
            // rule.yaml next to rule.py, or rule-python.py next to rule.yaml
            for (const p of [".yaml", ".yml"].flatMap((ext) => [base + ext, base.replace(/-(python|py|javascript|js|typescript|ts|java|go|ruby|rb)$/, "") + ext]).map((f) => join(root, f))) {
                try {
                    if (statSync(p).size > 200_000)
                        continue;
                    const t = readFileSync(p, "utf8");
                    if (/^rules\s*:/m.test(t) && /\bpatterns?(-either|-inside|-not)?\s*:/.test(t))
                        hit = true;
                }
                catch {
                    /* no such file */
                }
            }
            seen.set(base, hit);
        }
        if (hit)
            u.inTest = true;
    }
}
/**
 * Names of model lists whose every use across the repo's code is a membership or prefix test. Reads each code file
 * once, only when some listed model came from a named list.
 */
async function onlyCheckedLists(usages, paths) {
    const names = [...new Set(usages.map((u) => u.owner).filter((x) => !!x))];
    const out = new Set();
    if (!names.length)
        return out;
    const any = new RegExp(`\\b(${names.join("|")})\\b`, "g");
    const checks = new Map(), uses = new Map();
    for (const p of paths) {
        let text;
        try {
            text = await readFile(p, "utf8");
        }
        catch {
            continue;
        }
        if (text.length > 2_000_000)
            continue;
        for (const m of text.matchAll(any)) {
            const name = m[1];
            const i = m.index;
            const before = text.slice(Math.max(0, i - 80), i);
            const after = text.slice(i + name.length, i + name.length + 40);
            const lineStart = text.lastIndexOf("\n", i - 1) + 1;
            const line = text.slice(lineStart, text.indexOf("\n", i) < 0 ? undefined : text.indexOf("\n", i));
            // neutral: the definition, imports and exports, types (typeof X[number]), comments
            if (/^\s*(import|from|export\s*\{|\}\s*from|#|\/\/|\*)/.test(line) || /^\s*(as\s+const\b)?\s*[:=](?!=)/.test(after) || /typeof\s*$/.test(before) || /^\s*\[\s*number\s*\]/.test(after) || /\bexport\s+(const|let|var)\s*$/.test(before) || /\b(const|let|var|final|static)\s+[\w<>\[\], ]*$/.test(before))
                continue;
            const isCheck = /^(\s+as\s+[\w\s\[\]<>|]+)?\s*\)?\s*(\?\.|\.)\s*(has|includes|contains|indexOf|some|find|containsKey)\s*\(/.test(after) ||
                /\b(not\s+)?in\s+(self\.|this\.|cls\.|\w+\.)?$/.test(before) || /\.(startswith|endswith|startsWith|endsWith)\(\s*(tuple\()?\s*(self\.|this\.)?$/.test(before);
            (isCheck ? checks : uses).set(name, ((isCheck ? checks : uses).get(name) ?? 0) + 1);
        }
    }
    for (const n of names)
        if ((checks.get(n) ?? 0) > 0 && !(uses.get(n) ?? 0))
            out.add(n);
    return out;
}
/** Fill in alsoLines from character spans, so a multi-line call counts as changed when its model line changes. */
/**
 * Quoted IDs of a provider's own objects (see ProviderDef.resourceIds), one usage per line, unless the file already
 * has that call with those parameters (then the call itself is the finding).
 */
function resourceUsages(file, lang, source, found) {
    const out = [];
    for (const p of PROVIDERS) {
        for (const r of p.resourceIds ?? []) {
            const covered = found.some((u) => u.provider === p.id && u.op === r.op && (r.params ?? []).every((x) => u.params?.includes(x)));
            if (covered)
                continue;
            const body = r.pattern.source.replace(/^\^|\$$/g, "");
            const lines = new Set();
            for (const m of source.matchAll(new RegExp(`["'\`](${body})["'\`]`, "g"))) {
                const line = source.slice(0, m.index).split("\n").length;
                if (lines.has(line))
                    continue;
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
function withLines(usages, source) {
    let starts;
    const lineAt = (i) => {
        starts ??= [0, ...[...source.matchAll(/\n/g)].map((m) => m.index + 1)];
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= i)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lo + 1;
    };
    for (const u of usages) {
        const spans = [u.modelSpan, ...Object.values(u.paramSpans ?? {})].filter((x) => !!x);
        const lines = new Set();
        for (const sp of spans)
            for (let l = lineAt(sp.start); l <= lineAt(Math.max(sp.start, sp.end - 1)); l++)
                if (l !== u.line)
                    lines.add(l);
        if (lines.size)
            u.alsoLines = [...lines].sort((a, b) => a - b);
    }
    return usages;
}
