/**
 * Does this repo really talk to a provider? Evidence, from strongest to weakest:
 * - calls: an SDK or HTTP usage of that provider anywhere in the repo (imports followed to calls);
 * - dependencies: the provider's SDK in a manifest, or a multi-provider framework/router (LangChain, LiteLLM, the
 *   Vercel AI SDK, Spring AI, …) in a manifest or imported in code;
 * - binaries: a model CLI or runtime run or installed (`ollama`, `litellm`, `claude`, `codex`), in Dockerfiles,
 *   compose files, shell scripts, package scripts or a subprocess call;
 * - the provider's API key read from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, …).
 *
 * Model IDs found only through a code shape (shapes.ts) count when their provider is in use. Frameworks, routers
 * and router providers (OpenRouter) are evidence for every provider. Data: src/data/model-routers.json.
 */
import { createRequire } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import { readManifest } from "./files.js";
import { basename, join } from "node:path";
import { PROVIDERS } from "../providers.js";
const DATA = createRequire(import.meta.url)("../data/model-routers.json");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** A package name as a whole token in a manifest or an import, not as part of a longer name */
const token = (name) => new RegExp(`(^|[\\s"'=,\\[(:<>])${esc(name)}($|[\\s"'=<>~!\\[\\],;:)@^/]|\\.(?![\\w-]+\\.))`, "m");
const IMPORT_LINE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+)|import[^'"\n]*from\s+["']([^"']+)["']|(?:const|let|var)[^=\n]*=\s*require\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["'])/gm;
const EVIDENCE_FILE = /^(Dockerfile.*|.*\.dockerfile|(docker-)?compose.*\.ya?ml|.*\.sh|Makefile|Procfile|justfile|\.env(\..+)?|.*\.env)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor", ".venv", "venv", "__pycache__", "target", ".next"]);
/** Files that run or install things, read for model CLIs, images and API keys (at most 400 files, 256 KB each) */
async function evidenceTexts(root) {
    const out = [];
    async function walk(dir, depth) {
        if (depth > 6 || out.length >= 400)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (out.length >= 400)
                return;
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name))
                    await walk(full, depth + 1);
            }
            else if (e.isFile() && EVIDENCE_FILE.test(e.name)) {
                const s = await stat(full).catch(() => undefined);
                if (s && s.size <= 256_000)
                    out.push(await readFile(full, "utf8").catch(() => ""));
            }
        }
    }
    await walk(root, 0);
    return out;
}
/** A CLI run or installed: a shell command, a container image, an install line, or a subprocess call */
function runsCli(text, name) {
    const n = esc(name);
    const res = [
        new RegExp(`^\\s*(?:\\$\\s*|RUN\\s+|exec\\s+|npx\\s+(?:-y\\s+)?)?${n}\\s+[-\\w"']`),
        new RegExp(`image:\\s*["']?[\\w./-]*\\b${n}\\b`, "i"),
        new RegExp(`\\b(pip3?|uv|pipx|npm|pnpm|yarn|bun|brew|npx)\\s+(?:install|add|i|tool install|x)?[^\\n]*?(^|\\s)${n}(\\s|$|@|=)`),
        new RegExp(`\\b(spawn|spawnSync|execFile|execFileSync|execa|exec|Popen|run|call|check_output|check_call|ProcessBuilder|Command|system)\\s*\\(\\s*\\[?\\s*["']${n}["']`),
    ];
    // Line by line, lines up to 2 KB: a command is one line, and these backtrack on huge ones (review F2)
    if (!text.includes(name))
        return false;
    return text.split("\n").some((l) => l.length <= 2048 && l.includes(name) && res.some((re) => re.test(l)));
}
export async function repoEvidence(root, opts) {
    const ev = { all: false, providers: new Set(), reasons: [] };
    const add = (who, why) => {
        if (who === "*")
            ev.all = true;
        else
            for (const p of who)
                ev.providers.add(p);
        if (ev.reasons.length < 50)
            ev.reasons.push(`${who === "*" ? "*" : who.join(",")}: ${why}`);
    };
    for (const u of opts.usages) {
        if (u.kind !== "sdk" && u.kind !== "http")
            continue;
        add([u.provider, ...(u.viaSdk ? [u.viaSdk] : [])], `call in ${u.file}`);
        if (DATA.routerProviders.includes(u.provider))
            add("*", `${u.provider} call`);
    }
    for (const d of opts.sdks) {
        add([d.provider], `dependency ${d.name}`);
        if (DATA.routerProviders.includes(d.provider))
            add("*", `${d.provider} dependency`);
    }
    // Framework and router packages: in manifests, or imported in code
    const manifestTexts = await Promise.all(opts.manifests.map(readManifest));
    const imports = new Set();
    for (const src of opts.sources)
        for (const m of src.matchAll(IMPORT_LINE)) {
            const mod = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
            if (mod)
                imports.add(mod);
        }
    for (const group of DATA.packages) {
        for (const name of group.names) {
            const inManifest = manifestTexts.some((t) => token(name).test(t));
            const imported = [...imports].some((mod) => mod === name || mod.startsWith(name + "/") || mod.startsWith(name.replace(/-/g, "_") + ".") || mod === name.replace(/-/g, "_"));
            if (inManifest || imported)
                add(group.providers, `package ${name}`);
        }
    }
    // Provider SDKs imported in code without a manifest (scripts, notebooks exported to .py)
    for (const p of PROVIDERS) {
        for (const pkgs of Object.values(p.packages))
            for (const pkg of pkgs ?? []) {
                if ([...imports].some((mod) => mod === pkg || mod.startsWith(pkg + "/") || mod.startsWith(pkg + ".")))
                    add([p.id], `import ${pkg}`);
            }
    }
    // Binaries and API keys
    const runTexts = await evidenceTexts(root);
    const scripts = manifestTexts.filter((t, i) => basename(opts.manifests[i]) === "package.json").map((t) => {
        try {
            return Object.values(JSON.parse(t).scripts ?? {}).join("\n");
        }
        catch {
            return "";
        }
    });
    const runnable = [...runTexts, ...scripts, ...opts.sources];
    for (const group of DATA.cli) {
        for (const name of group.names)
            if (runnable.some((t) => runsCli(t, name)))
                add(group.providers, `runs ${name}`);
    }
    const keyText = [...runTexts, ...opts.sources];
    for (const p of PROVIDERS) {
        const keys = [`${p.id.toUpperCase().replace(/-/g, "_")}_API_KEY`, ...(DATA.envKeys[p.id] ?? [])];
        const key = keys.find((k) => keyText.some((t) => new RegExp(`\\b${esc(k)}\\b`).test(t)));
        if (key) {
            add([p.id], `env ${key}`);
            if (DATA.routerProviders.includes(p.id))
                add("*", `env ${key}`);
        }
    }
    return ev;
}
export function provenUse(ev, provider) {
    return ev.all || ev.providers.has(provider);
}
