/**
 * Roles v3: two flows by file type. Code files keep the code rules (src/scan/roles.ts). A model in a data file
 * (YAML, JSON, TOML, INI, .properties, .env) fails a check only when that file is runtime configuration:
 *
 *   - a known configuration name or place: .env files, config.*, settings.*, *-config.*, appsettings*.json, compose
 *     files, Helm values, platform files (wrangler.toml, fly.toml …), CI workflows, files under config/ or deploy/;
 *   - or a file the repo's own code loads: its name or path in a string in the code ("model-settings.yml",
 *     "config/llm.yaml"), or its folder named next to a pattern for its type (Path("agents").glob("*.json")).
 *
 * Every other model place in a data file is still reported, as recorded data or a catalog entry, never hidden.
 */
import { basename, dirname, posix } from "node:path";

const DATA_EXT = "ya?ml|json|jsonc|json5|toml|ini|cfg|conf|properties|env";
const DATA_FILE = new RegExp(`\\.(${DATA_EXT})$|(^|/)\\.env([.\\w-]*)?$`, "i");

/** Is this a data/config file (the data flow), not code? Notebooks are code cells, so they stay in the code flow */
export const isDataFile = (rel: string): boolean => DATA_FILE.test(rel) && !/\.ipynb$/i.test(rel);

/** Names that are configuration by convention, wherever they sit */
const CONFIG_STEM = /(^|[-_.])(config|configuration|conf|settings|preferences|prefs)($|[-_.])/i;
const CONFIG_NAME =
  /^(\.env([.\w-]*)?|(application|bootstrap)([-.][\w-]+)?\.(properties|ya?ml)|package\.json|[\w.-]+\.env|appsettings([.\w-]*)?\.json|\.[\w-]+rc(\.(json|ya?ml|toml))?|(docker-)?compose([.\w-]*)?\.ya?ml|values([.\w-]*)?\.ya?ml|(wrangler|fly|netlify|vercel|render|serverless|cloudbuild|apphosting|firebase|app|now|railway|heroku|manifest)\.(json|toml|ya?ml)|action\.ya?ml)$/i;
/** Places that hold configuration: CI workflows, config folders, deployment manifests */
const CONFIG_DIR = /(^|\/)(\.github\/workflows|\.circleci|\.gitlab|\.config|config|configs|conf|settings|deploy|deployments?|k8s|kubernetes|helm|charts|infra)\//i;

export function knownConfig(rel: string): boolean {
  const name = basename(rel);
  return CONFIG_NAME.test(name) || CONFIG_STEM.test(name.replace(/\.[^.]+$/, "")) || CONFIG_DIR.test(rel);
}

/** What the repo's code loads: file names and paths in its strings, and folders it reads by a pattern */
export interface LoadRefs {
  names: Set<string>;
  paths: Set<string>;
  /** extension (lowercase, "yml" as "yaml") → folder names in the same code file as a pattern for that type */
  globDirs: Map<string, Set<string>>;
}

export const emptyRefs = (): LoadRefs => ({ names: new Set(), paths: new Set(), globDirs: new Map() });

const normExt = (e: string) => e.toLowerCase().replace(/^yml$/, "yaml");
const LITERAL = new RegExp(`["'\`]([^"'\`\\s\\\\]{1,200}\\.(?:${DATA_EXT}))["'\`]`, "gi");
/** "*.json", "agent_*.json", "**\/*.yaml", ".endswith('.yml')", endsWith(".json"), suffix == ".toml" */
const PATTERN = new RegExp(`["'\`](?:[^"'\`\\s*]{0,200}/)?[^"'\`\\s/*]{0,80}\\*{1,2}(?:/\\*)?[^"'\`\\s/*]{0,80}\\.(${DATA_EXT})["'\`]|(?:endswith|endsWith|suffix\\s*==)\\s*\\(?\\s*["'\`]\\.(${DATA_EXT})["'\`]`, "gi");
const BARE_EXT = new RegExp(`["'\`]\\.(${DATA_EXT})["'\`]`, "gi");
const WORD = /["'`]([\w.\/-]{2,120})["'`]/g;
const MAX_LINE = 1000;

/** Adds one code file's references to refs. Linear: one pass of simple patterns over lines of bounded length */
export function collectLoadRefs(source: string, refs: LoadRefs): void {
  if (!source.includes(".")) return;
  const exts = new Set<string>();
  const dirs = new Set<string>();
  const lines = source.split("\n").filter((l) => l.length <= MAX_LINE);
  for (const line of lines) {
    for (const m of line.matchAll(LITERAL)) {
      // classpath:x.json, file:./x.yaml, res://x.json: the path after the scheme
      const p = posix.normalize(m[1].replace(/^[a-z][\w+.-]*:(\/\/)?/i, "").replace(/^\.?\//, "")).replace(/^(\.\.\/)+/, "").toLowerCase();
      if (p.includes("*")) continue;
      // A templated path (f"pipelines/{name}.yml", `${dir}/x.json`, "agents/%s.json"): its folder and type
      if (/[{}%$]/.test(p)) {
        exts.add(normExt(/\.(\w+)$/.exec(p)![1]));
        for (const seg of p.split("/").slice(0, -1)) if (!/[{}%$]/.test(seg) && seg.length >= 2) dirs.add(seg);
        continue;
      }
      // A bare name ("model-settings.yml") matches that name anywhere; a path only matches that path
      if (p.includes("/")) refs.paths.add(p);
      else refs.names.add(p);
    }
    for (const m of line.matchAll(PATTERN)) exts.add(normExt(m[1] ?? m[2]));
    // A bare extension, as in "pipelines/" + name + ".yml"
    for (const m of line.matchAll(BARE_EXT)) exts.add(normExt(m[1]));
  }
  if (!exts.size) return;
  for (const line of lines) for (const m of line.matchAll(WORD)) for (const seg of m[1].split("/")) if (seg.length >= 2 && !seg.includes("*") && !/\.(\w+)$/.test(seg)) dirs.add(seg.toLowerCase());
  for (const e of exts) {
    const set = refs.globDirs.get(e) ?? new Set<string>();
    for (const d of dirs) set.add(d);
    refs.globDirs.set(e, set);
  }
}

/** Does the repo's code load this data file, by its name, its path, or its folder and type? */
export function loadedByCode(rel: string, refs: LoadRefs): boolean {
  const lower = rel.toLowerCase();
  if (refs.names.has(basename(lower))) return true;
  for (const p of refs.paths) if (lower === p || lower.endsWith(`/${p}`)) return true;
  const ext = /\.(\w+)$/.exec(lower)?.[1];
  const dir = basename(dirname(lower));
  return !!ext && dir !== "." && !!refs.globDirs.get(normExt(ext))?.has(dir);
}

/** Runtime configuration: what a running app or its CI reads, so a retired model there breaks something */
export const runtimeConfig = (rel: string, refs?: LoadRefs): boolean => knownConfig(rel) || (!!refs && loadedByCode(rel, refs));
