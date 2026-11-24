import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COST_LIMITS, isHeavySource } from "../src/scan/costguard.js";
import { scanRepo } from "../src/scan/index.js";

describe("per-file cost guard", () => {
  it("is decided by size, line count and the longest line", () => {
    expect(isHeavySource("a\nb\n")).toBe(false);
    expect(isHeavySource("x".repeat(COST_LIMITS.bytes + 1))).toBe(true);
    expect(isHeavySource("\n".repeat(COST_LIMITS.lines + 1))).toBe(true);
    expect(isHeavySource(`a\n${"y".repeat(COST_LIMITS.longestLine + 1)}\nb`)).toBe(true);
    expect(isHeavySource(`a\n${"y".repeat(COST_LIMITS.longestLine)}\nb`)).toBe(false);
  });
  it("a heavy file keeps its per-file findings, is named in a warning, and skips the newer passes", async () => {
    const d = await mkdtemp(join(tmpdir(), "vitasta-guard-"));
    const pad = "// filler\n".repeat(COST_LIMITS.lines + 10);
    // a path constant in a forwarding folder (wrapper paths, a newer pass) and a model id (a per-file analyzer)
    const relay = 'class Relay\n{\n    const string Upstream = "https://api.openai.com/v1";\n    string Model = "gpt-4o";\n    const string AssistantsPath = "/assistants";\n}\n';
    // (the same file, small: the path is found)
    const small = await mkdtemp(join(tmpdir(), "vitasta-guard-"));
    await writeFile(join(small, "relay.cs"), relay);
    expect(((await scanRepo(small)).usages as any[]).some((u) => /assistants/.test(u.op ?? ""))).toBe(true);
    await writeFile(join(d, "relay.cs"), relay + pad);
    const warns: string[] = [];
    const us = (await scanRepo(d, { onWarn: (w) => warns.push(w) })).usages as any[];
    expect(us.some((u) => u.provider === "openai" && u.line === 4)).toBe(true);
    expect(warns.some((w) => /very large file.*relay\.cs/.test(w))).toBe(true);
    expect(us.filter((u) => /assistants/.test(u.op ?? ""))).toEqual([]);
  });
});
