import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { annotationFor, evaluatePr, gitChangedLines, parseUnifiedDiff, workflowCommand } from "../src/check.js";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

const FEED: ChangeRecord[] = [
  {
    id: "sonnet4", provider: "anthropic", type: "model_retirement", title: "claude-sonnet-4-20250514 is retired",
    selector: { models: ["claude-sonnet-4-20250514"] }, effective: "2026-06-15", trigger: "date", replacement: "claude-sonnet-5-5", sources: [],
  },
];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vitasta-check-"));
  git(dir, "init", "-q", "-b", "main");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "^0.30.0" } }));
  await writeFile(
    join(dir, "src/old.ts"),
    `import Anthropic from "@anthropic-ai/sdk";\nconst c = new Anthropic();\nexport const a = () => c.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [] });\n`,
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("diff parsing", () => {
  it("collects added lines from a unified diff", () => {
    const d = parseUnifiedDiff(["+++ b/src/a.ts", "@@ -1,0 +2,3 @@", "+x", "+y", "+z", "+++ b/src/b.ts", "@@ -5 +5 @@", "+q"].join("\n"));
    expect([...d.get("src/a.ts")!]).toEqual([2, 3, 4]);
    expect([...d.get("src/b.ts")!]).toEqual([5]);
  });
});

describe("PR check", () => {
  it("fails a PR that adds a call to a retired model, and annotates that line", async () => {
    const dir = await repo();
    git(dir, "checkout", "-q", "-b", "feature");
    await writeFile(
      join(dir, "src/new.ts"),
      `import Anthropic from "@anthropic-ai/sdk";\nconst c = new Anthropic();\n\nexport const b = () => c.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [] });\n`,
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feature");

    const findings = findImpacts(await scanRepo(dir), FEED, "2026-11-13");
    const result = evaluatePr(findings, gitChangedLines(dir, "main"));
    expect(result.conclusion).toBe("failure");
    expect(result.introduced.map((f) => `${f.usage.file}:${f.usage.line}`)).toEqual(["src/new.ts:4"]);
    expect(result.existing.map((f) => `${f.usage.file}:${f.usage.line}`)).toEqual(["src/old.ts:3"]);

    const cmd = workflowCommand(annotationFor(result.introduced[0], true));
    expect(cmd).toMatch(/^::error file=src\/new.ts,line=4,title=claude-sonnet-4-20250514 is retired::/);
    expect(cmd).toContain("Move to: claude-sonnet-5-5.");
  });

  it("doesn't fail a PR for problems in code it didn't touch", async () => {
    const dir = await repo();
    git(dir, "checkout", "-q", "-b", "docs");
    await writeFile(join(dir, "README.md"), "# hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "docs");

    const findings = findImpacts(await scanRepo(dir), FEED, "2026-11-13");
    const result = evaluatePr(findings, gitChangedLines(dir, "main"));
    expect(result.conclusion).toBe("neutral");
    expect(result.introduced).toEqual([]);
    expect(result.existing).toHaveLength(1);
  });

  it("never fails a PR on a feed record nobody has checked yet, or on a weaker match than the policy allows", async () => {
    const dir = await repo();
    git(dir, "checkout", "-q", "-b", "feature");
    await writeFile(join(dir, "src/new.ts"), `import Anthropic from "@anthropic-ai/sdk";\nconst c = new Anthropic();\nexport const b = () => c.messages.create({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [] });\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "feature");
    const map = await scanRepo(dir);
    const changed = gitChangedLines(dir, "main");

    const pending = findImpacts(map, [{ ...FEED[0], pending: true }], "2026-11-13");
    const r1 = evaluatePr(pending, changed);
    expect(r1.conclusion).toBe("neutral");
    expect(r1.introduced).toHaveLength(1);
    const a = annotationFor(r1.introduced[0], true);
    expect(a.annotation_level).toBe("warning");
    expect(a.message).toContain("not yet double-checked");

    const unconfirmed = findImpacts(map, [{ ...FEED[0], unconfirmed: true }], "2026-11-13");
    expect(evaluatePr(unconfirmed, changed).conclusion).toBe("neutral");

    const findings = findImpacts(map, FEED, "2026-11-13");
    const weakest = findings.find((f) => f.usage.file === "src/new.ts")!.usage.confidence;
    expect(evaluatePr(findings, changed, ["broken", "urgent"], weakest).conclusion).toBe("failure");
    if (weakest !== "certain") expect(evaluatePr(findings, changed, ["broken", "urgent"], "certain").conclusion).toBe("neutral");
  });
});
