import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePr, gitChangedLines } from "../src/check.js";
import { findImpacts } from "../src/feed/match.js";
import { renderMarkdown } from "../src/report/markdown.js";
import { jsonReport } from "../src/report/json.js";
import { fixRoleFor, isTestFile } from "../src/scan/roles.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

// (option a): "Keep them, but as notes"
const FEED: ChangeRecord[] = [
  {
    id: "sonnet4", provider: "anthropic", type: "model_retirement", title: "claude-sonnet-4-20250514 is retired",
    selector: { models: ["claude-sonnet-4-20250514"] }, effective: "2026-06-15", trigger: "date", replacement: "claude-sonnet-5-5", sources: [],
  },
];
const call = (fn: string) => `import Anthropic from "@anthropic-ai/sdk";\nconst c = new Anthropic();\nexport const ${fn} = () => c.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [] });\n`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vitasta-notes-"));
  git(dir, "init", "-q", "-b", "main");
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "tests"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "^0.30.0" } }));
  await writeFile(join(dir, "src/app.ts"), call("a"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("findings in test files are notes", () => {
  it("a place in a test file has role note, keeping its test role for the fix", async () => {
    const dir = await repo();
    await writeFile(join(dir, "tests/app.test.ts"), call("t"));
    const map = await scanRepo(dir);
    const t = map.usages.find((u) => u.file === "tests/app.test.ts" && u.model);
    expect(t?.role).toBe("note");
    expect(t?.testRole).toBe("test-asserts");
    expect(fixRoleFor(t!)).toBe("test-asserts");
    expect(map.usages.find((u) => u.file === "src/app.ts" && u.model)?.role).toBe("breaks");
  });

  it("a PR that adds the retired model only in a test doesn't fail", async () => {
    const dir = await repo();
    git(dir, "checkout", "-q", "-b", "feature");
    await writeFile(join(dir, "tests/app.test.ts"), call("t"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "test only");
    const findings = findImpacts(await scanRepo(dir), FEED, "2026-11-23");
    expect(findings.some((f) => f.usage.file === "tests/app.test.ts")).toBe(true);
    const r = evaluatePr(findings, gitChangedLines(dir, "main"));
    expect(r.conclusion).not.toBe("failure");
    expect(r.introduced).toEqual([]);
  });

  it("the report lists it under 'Also in tests' and doesn't count it; the JSON puts it in alsoInTests", async () => {
    const dir = await repo();
    await writeFile(join(dir, "tests/app.test.ts"), call("t"));
    const map = await scanRepo(dir);
    const findings = findImpacts(map, FEED, "2026-11-23");
    const md = renderMarkdown(map, findings, "acme/app");
    expect(md).toMatch(/\| 🔴 Broken now \| 1 \| 1 \|/);
    expect(md).toMatch(/1 note in tests/);
    expect(md).toMatch(/<summary>Also in tests: notes \(1\)<\/summary>[\s\S]*tests\/app\.test\.ts/);
    expect(md.split("## Action needed")[1]?.split("<details>")[0]).not.toContain("tests/app.test.ts");
    const j = jsonReport(map, findings);
    expect(j.findings.map((f) => f.usage.file)).toEqual(["src/app.ts"]);
    expect(j.alsoInTests.map((f) => f.usage.file)).toEqual(["tests/app.test.ts"]);
  });

  it("isTestFile: test code and test settings, not examples", () => {
    expect(isTestFile("tests/app.test.ts", true)).toBe(true);
    expect(isTestFile("src/Acme.IntegrationTests/Chat.cs", true)).toBe(true);
    expect(isTestFile("config/testsettings.json", false)).toBe(true);
    expect(isTestFile("examples/demo.py", true)).toBe(false);
    expect(isTestFile("src/app.ts", false)).toBe(false);
  });
});
