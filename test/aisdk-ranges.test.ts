import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-aisdk-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const app = (model: string) => `import { generateText } from "ai";\nimport { anthropic } from "@ai-sdk/anthropic";\nexport const run = () => generateText({ model: anthropic("${model}"), temperature: 0.2, prompt: "hi" });\n`;

describe("@ai-sdk/anthropic sampling by installed release (ranges read from each release)", () => {
  const pkg = JSON.stringify({ name: "app", private: true, dependencies: { ai: "5.0.0", "@ai-sdk/anthropic": "2.0.101" } });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@ai-sdk/anthropic": { version: "2.0.101" } } });
  it("2.0.101 sends temperature for a claude-3 id (its claude-3/2/instant rule comes before the unknown-id rule)", async () => {
    const us = (await scanRepo(await repo({ "package.json": pkg, "package-lock.json": lock, "src/a.ts": app("claude-3-5-sonnet-20240620") }))).usages;
    expect(us.some((u: any) => u.params?.includes("temperature") && u.provider === "anthropic")).toBe(true);
  });
  it("2.0.101 drops temperature for claude-opus-5 (a model it rejects sampling for)", async () => {
    const us = (await scanRepo(await repo({ "package.json": pkg, "package-lock.json": lock, "src/a.ts": app("claude-opus-5") }))).usages;
    expect(us.some((u: any) => u.params?.includes("temperature") && u.provider === "anthropic")).toBe(false);
  });
});
