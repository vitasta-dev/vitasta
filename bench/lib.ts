/**
 * Shared pieces of the accuracy benchmark: the corpus of public repos, read-only clones, and stable keys for
 * labelled places. Repos are cloned with hooks, LFS and submodules off and are never built, installed or run.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeModel } from "../src/providers.js";
import { scanConfigAndNotebooks } from "../src/scan/config.js";
import { listSourceFiles } from "../src/scan/files.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord, Usage } from "../src/types.js";
import { findImpacts } from "../src/feed/match.js";

export const BENCH = dirname(fileURLToPath(import.meta.url));
export const CACHE = join(homedir(), ".cache", "vitasta", "repos");
export const LABELS = join(BENCH, "labels", "labels.jsonl");
export const QUEUE = join(BENCH, "queue");

export const repoDir = (repo: string) => join(CACHE, repo.replace("/", "__"));

const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "-c", "protocol.file.allow=never", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process="];
const gitEnv = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };

/** Shallow, read-only clone into the cache (once). Returns the commit it's at. */
export function ensureClone(repo: string, sha?: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo name ${repo}`);
  if (sha && !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`bad sha for ${repo}`);
  const dir = repoDir(repo);
  const git = (...a: string[]) => execFileSync("git", [...SAFE_GIT, "-C", dir, ...a], { encoding: "utf8", stdio: "pipe", timeout: 180_000, env: gitEnv }).trim();
  if (!existsSync(dir)) {
    execFileSync("git", [...SAFE_GIT, "clone", "--depth", "1", "--quiet", "--no-recurse-submodules", `https://github.com/${repo}`, dir], { stdio: "pipe", timeout: 180_000, env: gitEnv });
  }
  // Labels point at lines in one commit: go back to it if the repo has moved on since
  if (sha && git("rev-parse", "HEAD") !== sha) {
    try {
      git("fetch", "--depth", "1", "--quiet", "origin", sha);
      git("checkout", "--quiet", "--detach", sha);
    } catch {
      /* commit gone (force-pushed); the caller warns that labels may not line up */
    }
  }
  return git("rev-parse", "HEAD");
}

export async function readList(file: string): Promise<string[]> {
  return (await readFile(file, "utf8")).split("\n").map((s) => s.replace(/#.*/, "").trim()).filter(Boolean);
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

export async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/** What a usage is about: the model ID, else the operation, else the pinned version. */
export const thingOf = (u: Pick<Usage, "model" | "op" | "apiVersion" | "sdkCall">) => (u.model ? normalizeModel(u.model) : u.op ?? (u.apiVersion ? `version ${u.apiVersion}` : u.sdkCall ?? "?"));

/** A place in a repo, independent of scanner internals: labels stay valid while the scanner changes. */
export const keyOf = (repo: string, file: string, line: number, thing: string) => `${repo}|${file}|${line}|${thing}`;

/** The rule a usage comes from, for per-rule accuracy: provider, kind and language. */
export const ruleOf = (u: Pick<Usage, "provider" | "kind" | "lang">) => `${u.provider}/${u.kind}/${u.lang}`;

export function contextAt(text: string, line: number, before = 8, after = 8): string {
  const lines = text.split("\n");
  const from = Math.max(0, line - 1 - before);
  return lines
    .slice(from, line + after)
    .map((l, i) => `${String(from + i + 1).padStart(4)}${from + i + 1 === line ? " >" : "  "} ${l.slice(0, 220)}`)
    .join("\n");
}

export interface UsageRow {
  key: string;
  /** Extra key for a model written on another line than the call (multi-line calls, constants) */
  altKey?: string;
  repo: string;
  file: string;
  line: number;
  rule: string;
  provider: string;
  kind: Usage["kind"];
  confidence: Usage["confidence"];
  thing: string;
  inTest: boolean;
}

export interface Candidate {
  key: string;
  repo: string;
  file: string;
  line: number;
  thing: string;
}

export interface RepoScan {
  repo: string;
  sha: string;
  usages: UsageRow[];
  /** Usages that match a retired or retiring feed record (what users would see) */
  flagged: { row: UsageRow; claim: string; changeId: string }[];
  /** Independent baseline for recall: retired model IDs written as a value anywhere the scanner should cover */
  candidates: Candidate[];
}

/** Scan one repo and turn the result into rows with stable keys. */
export async function scanForBench(repo: string, feed: ChangeRecord[], today: string, pin?: string): Promise<RepoScan> {
  const sha = ensureClone(repo, pin);
  const dir = repoDir(repo);
  const map = await scanRepo(dir);
  const texts = new Map<string, string>();
  const text = async (f: string) => {
    if (!texts.has(f)) texts.set(f, await readFile(join(dir, f), "utf8").catch(() => ""));
    return texts.get(f)!;
  };
  const rowOf = async (u: Usage): Promise<UsageRow> => {
    const thing = thingOf(u);
    let altKey: string | undefined;
    if (u.modelSpan && !u.file.endsWith(".ipynb")) {
      const l = (await text(u.file)).slice(0, u.modelSpan.start).split("\n").length;
      if (l !== u.line) altKey = keyOf(repo, u.file, l, thing);
    }
    return { key: keyOf(repo, u.file, u.line, thing), ...(altKey ? { altKey } : {}), repo, file: u.file, line: u.line, rule: ruleOf(u), provider: u.provider, kind: u.kind, confidence: u.confidence, thing, inTest: !!u.inTest };
  };
  const rows = new Map<Usage, UsageRow>();
  for (const u of map.usages) rows.set(u, await rowOf(u));
  const flagged = findImpacts(map, feed, today).map((f) => ({ row: rows.get(f.usage) ?? (undefined as never), claim: f.change.title, changeId: f.change.id })).filter((x) => x.row);

  // Recall baseline (same definition as the published benchmark): a retired model ID that is the whole content of
  // a quoted string in code, or a key's value in a config file
  const retired = new Set(feed.flatMap((c) => (c.type === "model_retirement" ? c.selector.models ?? [] : [])).filter((m) => !m.endsWith("*")));
  const candidates: Candidate[] = [];
  const files = new Set([...(await listSourceFiles(dir)).map((f) => f.rel), ...(await scanConfigAndNotebooks(dir)).map((u) => u.file)]);
  for (const rel of files) {
    if (rel.endsWith(".ipynb")) continue; // notebook lines are JSON lines; labels there aren't stable
    const t = await text(rel);
    const isConfig = !/\.(m|c)?[jt]sx?$|\.py$|\.java$/.test(rel);
    t.split("\n").forEach((line, i) => {
      const values = isConfig
        ? [...line.matchAll(/(?:[:=]\s*)["']?([A-Za-z0-9][\w.:@\/-]*[\w])["']?\s*,?\s*$/g)].map((m) => m[1])
        : [...line.matchAll(/(["'`])([A-Za-z0-9][\w.:@\/-]*[\w])\1/g)].map((m) => m[2]);
      for (const v of values) {
        const tok = normalizeModel(v);
        if (retired.has(tok) && /[\d-]/.test(tok)) candidates.push({ key: keyOf(repo, rel, i + 1, tok), repo, file: rel, line: i + 1, thing: tok });
      }
    });
  }
  return { repo, sha, usages: [...rows.values()], flagged, candidates };
}

/** Context for a place, read from the cached clone. */
export async function contextFor(repo: string, file: string, line: number): Promise<string> {
  return contextAt(await readFile(join(repoDir(repo), file), "utf8").catch(() => ""), line);
}

export interface Label {
  key: string;
  label: "real" | "not" | "unsure";
  by: string;
  at: string;
  /** Which queue it came from: corpus precision, corpus recall, or a weekly real-world sample */
  set: string;
  note?: string;
}

/** Latest label per key (a later label overrides an earlier one). */
export async function loadLabels(): Promise<Map<string, Label>> {
  const out = new Map<string, Label>();
  for (const l of await readJsonl<Label>(LABELS)) out.set(l.key, l);
  return out;
}

/** Deterministic shuffle so samples are reproducible */
export function seeded(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}
