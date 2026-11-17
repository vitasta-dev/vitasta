import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePr } from "../src/check.js";
import { loadRepoConfig, safePattern } from "../src/config.js";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

describe("review fixes (16 Nov)", () => {
  it("refuses chained bounded repeats that backtrack", () => {
    expect(() => safePattern("^a{0,40}a{0,40}a{0,40}a{0,40}a{0,40}b$", "p")).toThrow(/repeats/);
    expect(safePattern("^acme-[a-z0-9.-]+$", "p")).toBeTruthy();
  });

  it("a PR changing the model line of a multi-line call is caught", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ml-"));
    await writeFile(join(dir, "multi.ts"), 'import OpenAI from "openai";\nconst c = new OpenAI();\nawait c.chat.completions.create({\n  messages: [],\n  model: "gpt-4-0613",\n});\n');
    const map = await scanRepo(dir);
    const feed = [{ id: "r", provider: "openai", type: "model_retirement", title: "t", effective: "2025-01-01", trigger: "date", selector: { models: ["gpt-4-0613"] }, sources: [] }] as unknown as ChangeRecord[];
    const findings = findImpacts(map, feed, "2026-11-16");
    expect(findings).toHaveLength(1);
    const r = evaluatePr(findings, new Map([["multi.ts", new Set([5])]]));
    expect(r.conclusion).toBe("failure");
  });

  it("YAML errors don't quote the file, warnings are one line, symlinked .github is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cfg-"));
    await writeFile(join(dir, ".vitasta.yml"), "ignore: [\n::error file=README.md,line=1::Injected\n");
    const cfg = await loadRepoConfig(dir);
    expect(cfg.warnings.join("\n")).not.toContain("Injected");
    expect(cfg.warnings.every((w) => !/[\r\n]/.test(w))).toBe(true);

    const repo = await mkdtemp(join(tmpdir(), "cfg2-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await mkdir(join(outside, "gh"));
    await writeFile(join(outside, "gh", "vitasta.yml"), "secret: from outside\n");
    await symlink(join(outside, "gh"), join(repo, ".github"));
    const cfg2 = await loadRepoConfig(repo);
    expect(cfg2.warnings.join(" ")).toMatch(/symlink/);
  });

  it("a malformed custom provider becomes a warning, not a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cfg3-"));
    await writeFile(join(dir, ".vitasta.yml"), "providers:\n  - id: acme\n    hosts: [api.acme.test]\n    packages: { ts: [1] }\n");
    const cfg = await loadRepoConfig(dir);
    expect(cfg.providers).toHaveLength(0);
    expect(cfg.warnings.join(" ")).toMatch(/packages/);
  });
});
