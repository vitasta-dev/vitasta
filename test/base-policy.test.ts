import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { baseConfig } from "../src/check.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env }).trim();
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** base: no config; branch: adds a retired model and its own .vitasta.yml that turns failing off */
function repo(baseConfigText?: string): string {
  const d = mkdtempSync(join(tmpdir(), "vitasta-base-"));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "package.json"), '{"dependencies":{"@anthropic-ai/sdk":"^0.60.0"}}');
  if (baseConfigText) writeFileSync(join(d, ".vitasta.yml"), baseConfigText);
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "base");
  git(d, "switch", "-q", "-c", "pr");
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src/a.ts"), 'import Anthropic from "@anthropic-ai/sdk";\nconst c = new Anthropic();\nexport const b = () => c.messages.create({ model: "claude-3-opus-20240229", max_tokens: 1, messages: [] });\n');
  writeFileSync(join(d, ".vitasta.yml"), "policy:\n  failOn: []\n");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "pr");
  return d;
}

const feed = mkdtempSync(join(tmpdir(), "vitasta-base-feed-"));
dirs.push(feed);
writeFileSync(join(feed, "anthropic.json"), JSON.stringify([{ id: "opus3", provider: "anthropic", type: "model_retirement", title: "claude-3-opus-20240229 is retired", selector: { models: ["claude-3-opus-20240229"] }, effective: "2026-01-05", trigger: "date", replacement: "claude-opus-5", sources: [{ url: "https://example.com" }] }]));
const check = (d: string, base = "main") =>
  spawnSync("npx", ["tsx", resolve(import.meta.dirname, "../src/cli.ts"), "check", d, "--base", base, "--feed", feed, "--today", "2026-11-18"], { encoding: "utf8" });

describe("a PR check uses the base branch's policy, never the PR's own", () => {
  it("a PR that adds failOn: [] to its own .vitasta.yml still fails its check", () => {
    const r = check(repo());
    expect(r.stderr).toContain("Policy: main has no .vitasta.yml, so the default policy is used.");
    expect(r.status).toBe(1);
  }, 60_000);

  it("the base branch's own policy is honoured, and a missing base falls back to the default", () => {
    const relaxed = repo("policy:\n  failOn: []\n");
    expect(baseConfig(relaxed, "main")).toEqual({ text: "policy:\n  failOn: []\n", note: "Policy: from main's .vitasta.yml (this branch's own copy doesn't count for its check)." });
    expect(check(relaxed).status).toBe(0);
    expect(baseConfig(relaxed, "origin/nope")).toEqual({ text: null, note: "Policy: couldn't read origin/nope, so the default policy is used (never this branch's own .vitasta.yml)." });
  }, 60_000);
});
