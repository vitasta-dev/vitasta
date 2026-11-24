/**
 * .env templates and docker-compose environment entries: when does the value there count as a real default?
 *
 * A model, API version or other setting in `.env.example` (.sample, .template, .dist, env.example) is the app's
 * default only when the repo's code reads that variable with no default of its own: then the template is what the
 * app runs with. If every read has its own default (`os.getenv("M", "gpt-4o")`, `process.env.M ?? "x"`,
 * `ENV.fetch("M", x)`, `${M:default}`), the code's default wins until someone overrides it; the template line is a
 * note. If nothing reads it, it stays as before (a version is already a copy for users: markUnreadEnv).
 *
 * A compose `environment:` entry sets the variable for one service, so it overrides the code's default only when that
 * service runs this repo's code: it has a build context, or bind-mounts a folder of the repo, and code under that
 * folder reads the variable. A service that only pulls an image isn't known to run it. When no code in the repo reads
 * the variable at all, the entry stays as it was (the image may read it).
 *
 * Never fails a check for the notes: they get the same role as an env value no code reads (users-copy).
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import type { Usage } from "../types.js";

const TEMPLATE_ENV = /(?:^|\/)(?:\.env\.(?:example|sample|template|dist|defaults?)|env\.(?:example|sample|template|dist)|[\w.-]+\.env\.(?:example|sample|template|dist))$/;
const COMPOSE = /(?:^|\/)(?:docker-)?compose(?:[.\w-]*)\.ya?ml$/i;
const MAX_READ = 60_000_000;
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "venv", ".venv", "__pycache__", "target", ".gradle", "vendor", "coverage"]);
const TEXT = /\.(ya?ml|properties|toml|json|xml|conf|ini|cfg|sh|bash|tf|gradle|kts?|scala|rs|swift|dart|ex|exs)$|(^|\/)(Dockerfile[\w.-]*|Makefile|Procfile)$/i;

/** Config, scripts and other languages: where a variable can also be read (${X:default} in application.yml, Dockerfile ENV) */
export async function textFiles(root: string): Promise<{ path: string; rel: string }[]> {
  const out: { path: string; rel: string }[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= 3000) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(full);
      } else if (e.isFile() && TEXT.test(e.name) && !/\.env\.(example|sample|template|dist)$/.test(e.name) && (await stat(full)).size <= 1_000_000) out.push({ path: full, rel: relative(root, full) });
    }
  }
  await walk(root);
  return out;
}

interface Read {
  file: string;
  /** Read with no default of its own anywhere on the line */
  bare: boolean;
}

/** After a variable name: does what follows give the read its own default? */
export function hasOwnDefault(rest: string): boolean {
  // process.env.X ?? "d" / || "d" / ?: "d" / `or "d"` / `.get("X") or "d"`, also after a closing quote, bracket or paren
  if (/^["'`\]\)]*\s*(\?\?|\|\||\?:|\bor\b)\s*\S/.test(rest)) return true;
  // call with a second argument: getenv("X", "d"), environ.get("X", d), ENV.fetch("X", d), env('X', d), getOrDefault("X", d)
  if (/^["'`]\s*,\s*[^\s)]/.test(rest)) return true;
  // ENV.fetch("X") { "d" } / ENV.fetch("X") do |k| … end
  if (/^["']\s*\)\s*(\{|do\b)/.test(rest)) return true;
  // destructuring default: const { X = "d" } = process.env
  if (/^\s*=\s*["'`\w]/.test(rest) && !/^\s*==/.test(rest)) return true;
  return false;
}

/** Reads of NAME in one code file: each occurrence is bare or has its own default */
function readsIn(text: string, name: string, lower: string, placeholdersOnly = false): { any: boolean; bare: boolean } {
  if (!text.includes(name) && !text.toLowerCase().includes(lower)) return { any: false, bare: false };
  const lines = text.split("\n");
  let any = false;
  let bare = false;
  const word = new RegExp(placeholdersOnly ? `(?<=\\$\\{?)${name}(?![\\w$])` : `(?<![\\w$])${name}(?![\\w$])`, "g");
  lines.forEach((l, i) => {
    if (l.length > 1000) return;
    for (const m of l.matchAll(word)) {
      // a placeholder's name: ${NAME…}: what follows the name
      const after = l.slice((m.index ?? 0) + name.length);
      any = true;
      let dflt = hasOwnDefault(after);
      // placeholder with a default: ${X:d}, ${X:-d}, ${X-d}
      if (!dflt && l.slice(0, m.index ?? 0).endsWith("${") && /^(:-?[^}]|-[^}])/.test(after)) dflt = true;
      // Go: v := os.Getenv("X"); if v == "" { v = "d" } (a fallback on the next lines)
      if (!dflt && /Getenv\(/.test(l) && lines.slice(i, i + 4).some((x) => /==\s*""|len\([^)]*\)\s*==\s*0/.test(x))) dflt = true;
      // Python: a bare read with a fallback on the same line: `x = os.environ["X"] if "X" in os.environ else "d"`
      if (!dflt && /\bin\s+os\.environ\b/.test(l) && /\belse\b/.test(l)) dflt = true;
      if (!dflt) bare = true;
    }
    // a settings class field (pydantic: openai_model: str = "gpt-4o"; case-insensitive env names)
    const field = placeholdersOnly ? null : new RegExp(`^\\s*${lower}\\s*:\\s*[\\w\\[\\], |.]+(=\\s*\\S)?`, "i").exec(l);
    if (field && /BaseSettings|Settings/.test(text)) {
      any = true;
      if (!field[1]) bare = true;
    }
  });
  return { any, bare };
}

const envName = (snippet: string) => /^\s*(?:-\s*)?(?:export\s+)?["']?([A-Za-z_]\w*)["']?\s*[=:]/.exec(snippet)?.[1];

interface ServiceEnv {
  service: string;
  /** line (1-based) of each environment entry */
  lines: Set<number>;
  /** Folders (repo-relative) whose code the service runs; empty: it only pulls an image */
  contexts: string[];
}

function composeServices(rel: string, text: string): ServiceEnv[] | undefined {
  const lc = new LineCounter();
  let doc;
  try {
    doc = parseDocument(text, { lineCounter: lc });
  } catch {
    return undefined;
  }
  const services = doc.get("services", true);
  if (!isMap(services)) return undefined;
  const out: ServiceEnv[] = [];
  const base = dirname(rel) === "." ? "" : dirname(rel);
  const resolve = (p: string) => posix.normalize(posix.join(base, p)).replace(/^\.$/, "").replace(/\/$/, "");
  for (const pair of (services as YAMLMap).items) {
    const name = isScalar(pair.key) ? String(pair.key.value) : "?";
    const svc = pair.value;
    if (!isMap(svc)) continue;
    const env = svc.get("environment", true);
    const lines = new Set<number>();
    if (isSeq(env)) for (const it of env.items) if (it && typeof (it as any).range?.[0] === "number") lines.add(lc.linePos((it as any).range[0]).line);
    if (isMap(env)) for (const it of env.items) if (it.key && typeof (it.key as any).range?.[0] === "number") lines.add(lc.linePos((it.key as any).range[0]).line);
    if (!lines.size) continue;
    const contexts: string[] = [];
    const build = svc.get("build", true);
    if (isScalar(build) && typeof build.value === "string") contexts.push(resolve(build.value));
    else if (isMap(build)) {
      const c = build.get("context");
      contexts.push(resolve(typeof c === "string" ? c : "."));
    }
    const vols = svc.get("volumes", true);
    if (isSeq(vols)) {
      for (const v of vols.items) {
        const s = isScalar(v) && typeof v.value === "string" ? v.value : isMap(v) && typeof v.get("source") === "string" ? String(v.get("source")) : "";
        const src = s.split(":")[0];
        // a bind mount of a folder of the repo (./src:/app, .:/app), not a named volume or an absolute host path
        if (src.startsWith("./") || src.startsWith("../") || src === ".") contexts.push(resolve(src));
      }
    }
    out.push({ service: name, lines, contexts });
  }
  return out;
}

const under = (file: string, dir: string) => dir === "" || file === dir || file.startsWith(dir + "/");

export async function markEnvDefaults(usages: Usage[], files: { path: string; rel: string }[], root: string): Promise<void> {
  const cand = usages.filter((u) => u.lang === "config" && !u.envUnread && !u.envShadowed && !u.doc && (u.model || u.apiVersion) && (TEMPLATE_ENV.test(u.file) || COMPOSE.test(u.file)));
  if (!cand.length) return;
  const targets: { u: Usage; name: string; contexts?: string[]; service?: string }[] = [];
  const composeCache = new Map<string, ServiceEnv[] | undefined>();
  for (const u of cand) {
    const name = envName(u.snippet ?? "");
    if (!name) continue;
    if (TEMPLATE_ENV.test(u.file)) {
      targets.push({ u, name });
      continue;
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue; // a compose key, not an environment variable
    if (!composeCache.has(u.file)) composeCache.set(u.file, composeServices(u.file, await readFile(`${root}/${u.file}`, "utf8").catch(() => "")));
    const svc = composeCache.get(u.file)?.find((s) => s.lines.has(u.line));
    if (svc) targets.push({ u, name, contexts: svc.contexts, service: svc.service });
  }
  if (!targets.length) return;
  const wanted = new Map<string, Read[]>();
  for (const t of targets) wanted.set(t.name, []);
  let bytes = 0;
  const codePaths = new Set(files.map((f) => f.path));
  for (const f of [...files, ...(await textFiles(root))]) {
    const text = await readFile(f.path, "utf8").catch(() => "");
    bytes += text.length;
    if (bytes > MAX_READ) return; // too much to be sure: change nothing
    if (!text) continue;
    for (const [name, reads] of wanted) {
      if (reads.length > 200) continue;
      const r = readsIn(text, name, name.toLowerCase(), !codePaths.has(f.path));
      if (r.any) reads.push({ file: f.rel, bare: r.bare });
    }
  }
  const mark = (u: Usage, kind: "envShadowed", why: string) => {
    Object.assign(u, { [kind]: true, reason: u.reason ? `${u.reason}; ${why}` : why });
  };
  for (const t of targets) {
    const reads = wanted.get(t.name) ?? [];
    // Nothing in the repo reads it: whatever runs there (an image, a tool, code in a language not scanned) may, so the
    // value stays as it was; only a value that code defaults would otherwise outrank is demoted
    if (!reads.length) continue;
    if (t.contexts) {
      const mine = reads.filter((r) => r.file !== t.u.file && t.contexts!.some((c) => under(r.file, c)));
      if (mine.length || reads.some((r) => r.bare)) continue;
      mark(t.u, "envShadowed", t.contexts.length ? `no code in service ${t.service}'s folder reads ${t.name}; the repo's own reads all have defaults` : `service ${t.service} only pulls an image: the repo's code, whose reads all have defaults, isn't known to run there`);
      continue;
    }
    if (!reads.some((r) => r.bare)) mark(t.u, "envShadowed", `every read of ${t.name} has its own default in the code: this template line only overrides it`);
  }
}
