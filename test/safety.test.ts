import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitChangedLines, parseUnifiedDiff } from "../src/check.js";
import { globToRegExp, loadRepoConfig, safePattern } from "../src/config.js";
import { PROVIDERS } from "../src/providers.js";
import { renderMarkdown } from "../src/report/markdown.js";
import { scanRepo } from "../src/scan/index.js";

const tmp = () => mkdtemp(join(tmpdir(), "vitasta-safety-"));
const repoWith = async (files: Record<string, string>) => {
  const d = await tmp();
  for (const [f, t] of Object.entries(files)) {
    await mkdir(join(d, f, ".."), { recursive: true });
    await writeFile(join(d, f), t);
  }
  return d;
};
const provider = (id: string, host: string) => `providers:\n  - id: ${id}\n    hosts: [${host}]\n    modelPattern: "^${id}-model-[0-9]+$"\n`;

describe("repo config can't stall or leak", () => {
  it("matches globs without backtracking", () => {
    const t = Date.now();
    expect(globToRegExp("**a**a**a**a**a**a**a**a**a**ab").test("a".repeat(2000))).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
    expect(globToRegExp("**/*.test.ts").test("a.test.ts")).toBe(true);
    expect(globToRegExp("src/**/gen/*.ts").test("src/gen/x.ts")).toBe(true);
    expect(globToRegExp("src/**/gen/*.ts").test("src/a/gen/y/x.ts")).toBe(false);
  });

  it("refuses patterns that can backtrack badly", () => {
    for (const bad of ["(a|aa)+$", "((a+))+b", "^(a+)+$", "(?=a)b", "(a)\\1", "a*b*c*d"]) expect(() => safePattern(bad, "p")).toThrow();
    for (const good of ["^acme-[a-z0-9-]+$", "/v(\\d+)/", "^acme-\\w+-v\\d+$"]) expect(safePattern(good, "p")).toBe(good);
  });

  it("doesn't follow a symlinked .vitasta.yml out of the repo", async () => {
    const outside = await repoWith({ "creds.ini": "aws_secret_access_key = SECRETVALUE123\n" });
    const d = await tmp();
    await symlink(join(outside, "creds.ini"), join(d, ".vitasta.yml"));
    const cfg = await loadRepoConfig(d);
    expect(cfg.warnings.join(" ")).toMatch(/symlink/);
    expect(cfg.warnings.join(" ")).not.toMatch(/SECRET/);
  });

  it("skips badly shaped changes instead of crashing, and keeps blocking on a failOn typo", async () => {
    const d = await repoWith({
      ".vitasta.yml": [
        "changes:",
        "  - { id: a, provider: openai, type: model_retirement, effective: '2027-01-01', selector: { models: gpt-4o } }",
        "  - { id: b, provider: openai, type: model_retirement, effective: '2027-13-01', selector: { models: [gpt-4o] } }",
        "  - { id: c, provider: openai, type: model_retirement, effective: '2027-01-01', selector: { models: [gpt-4o] } }",
        "policy:",
        "  failOn: [brokn]",
      ].join("\n"),
    });
    const cfg = await loadRepoConfig(d);
    expect(cfg.changes.map((c) => c.id)).toEqual(["c"]);
    expect(cfg.policy.failOn).toEqual(["broken", "urgent"]);
    expect(cfg.warnings.join("\n")).toMatch(/brokn/);
  });

  it("keeps one repo's providers out of another repo's scan, even when scans overlap", async () => {
    const before = PROVIDERS.length;
    const r1 = await repoWith({ ".vitasta.yml": provider("acme-a", "a.acme.test"), "x.py": 'm = "acme-a-model-1"\nimport requests\nrequests.get("https://a.acme.test/v1/x")\n' });
    const r2 = await repoWith({ ".vitasta.yml": provider("acme-b", "b.acme.test"), "x.py": 'import requests\nrequests.get("https://b.acme.test/v1/x")\n' });
    const [m1, m2] = await Promise.all([scanRepo(r1), scanRepo(r2)]);
    expect(PROVIDERS.length).toBe(before);
    expect(m1.usages.some((u) => u.provider === "acme-b")).toBe(false);
    expect(m2.usages.some((u) => u.provider === "acme-a")).toBe(false);
    // Same provider count, different provider: the prefilter must not reuse r1's
    const alone = await scanRepo(r2);
    expect(m2.usages.filter((u) => u.provider === "acme-b").length).toBe(alone.usages.filter((u) => u.provider === "acme-b").length);
    expect(alone.usages.some((u) => u.provider === "acme-b")).toBe(true);
  });
});

describe("PR diff", () => {
  it("doesn't take an added '++' line for a file header, and reads quoted paths", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -0,0 +1,2 @@",
      "+++ i;",
      "+x",
      "@@ -5,0 +10 @@",
      "+y",
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const m = parseUnifiedDiff(diff);
    expect([...m.keys()]).toEqual(["a.ts", "café.ts"]);
    expect([...m.get("a.ts")!]).toEqual([1, 2, 10]);
    expect([...m.get("café.ts")!]).toEqual([1]);
  });

  it("gives paths relative to a scanned subfolder", async () => {
    const d = await repoWith({ "mono/packages/api/x.ts": "const a = 1;\n" });
    const git = (...a: string[]) => execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "pr");
    await writeFile(join(d, "mono/packages/api/x.ts"), 'const a = 1;\nconst m = "gpt-4-0613";\n');
    git("commit", "-qam", "pr");
    expect([...gitChangedLines(join(d, "mono/packages/api"), "main").keys()]).toEqual(["x.ts"]);
  });
});

describe("reports", () => {
  it("escape repo-controlled text", () => {
    const map = { root: ".", filesScanned: 1, scannedAt: "2026-11-16", usages: [], sdks: [{ provider: "openai", name: "openai", version: "[upgrade here](https://evil.example) <img src=x>", manifest: "package.json" }] } as any;
    const md = renderMarkdown(map, [], "r");
    // Inside a code span it renders as plain text
    expect(md).toContain("`[upgrade here](https://evil.example) <img src=x>`");
    expect(md.replace(/`[^`]*`/g, "")).not.toMatch(/evil|<img/);
  });
});
