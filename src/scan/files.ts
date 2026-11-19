import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Lang } from "../types.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".turbo", "coverage",
  "venv", ".venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache", ".tox", "site-packages",
  "target", ".gradle", ".idea", ".vscode", "vendor", ".vitasta-cache",
]);

const EXT: Record<string, Lang> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py",
  ".java": "java",
  ".go": "go",
  ".rb": "rb", ".rake": "rb",
  ".php": "php",
  ".cs": "cs",
};

const MAX_FILE_BYTES = 1_000_000;

export interface SourceFile {
  path: string;
  rel: string;
  lang: Lang;
}

export function langOf(file: string): Lang | undefined {
  // Type declarations, minified and bundled output (app.min.js, vendor.bundle.js, _ds_bundle.js) aren't source
  if (file.endsWith(".d.ts") || /[.\-_](min|bundle)\.[cm]?js$/.test(file)) return undefined;
  const dot = file.lastIndexOf(".");
  return dot >= 0 ? EXT[file.slice(dot)] : undefined;
}

/** Walk a repo and return source files we can parse. Matches directory names exactly, never as substrings. */
export async function listSourceFiles(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
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
      } else if (e.isFile()) {
        const lang = langOf(e.name);
        if (!lang) continue;
        const s = await stat(full);
        if (s.size > MAX_FILE_BYTES) continue;
        out.push({ path: full, rel: relative(root, full), lang });
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Markdown files (READMEs, docs) whose code blocks are scanned as documentation: at most 300, 1 MB each */
export async function listDocFiles(root: string): Promise<{ path: string; rel: string }[]> {
  const out: { path: string; rel: string }[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= 300) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 300) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) {
        const s = await stat(full);
        if (s.size <= MAX_FILE_BYTES) out.push({ path: full, rel: relative(root, full) });
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Manifest files anywhere in the repo (monorepos have several). */
export async function listManifests(root: string): Promise<string[]> {
  const names = new Set([
    "package.json", "requirements.txt", "requirements-dev.txt", "pyproject.toml", "Pipfile", "setup.py",
    "pom.xml", "build.gradle", "build.gradle.kts", "libs.versions.toml",
    "go.mod", "Gemfile", "Gemfile.lock", "composer.json", "packages.config", "Directory.Packages.props",
  ]);
  const out: string[] = [];
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
      } else if (e.isFile() && (names.has(e.name) || /^requirements.*\.txt$/.test(e.name) || e.name.endsWith(".csproj") || e.name.endsWith(".gemspec"))) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/** A manifest's text: a regular file of at most 1 MB (a huge one is data, and is never worth the memory), else "" */
export async function readManifest(file: string): Promise<string> {
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > 1_000_000) return "";
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}
