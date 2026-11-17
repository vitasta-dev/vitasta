import { readdir, stat } from "node:fs/promises";
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
  if (file.endsWith(".d.ts") || file.endsWith(".min.js")) return undefined;
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
