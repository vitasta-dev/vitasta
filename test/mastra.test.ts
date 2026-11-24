import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Mastra agents' modelSettings (src/scan/mastra.ts), and a wrapper's options.temperature traced to its callers'
// object literals (src/scan/flow.ts)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-mastra-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const temps = async (files: Record<string, string>) =>
  ((await scanRepo(await repo(files))).usages as any[]).filter((u) => u.provider === "anthropic" && u.params?.includes("temperature")).map((u) => `${u.file}:${u.line}:${u.confidence}`);

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "app", dependencies: deps });
const model = `import { Agent } from "@mastra/core/agent";
export async function makeCall(prompt: string, options?: { temperature?: number }) {
  const agent = new Agent({ name: "a", instructions: "x", model: process.env.MODEL! });
  return agent.generate(prompt, {
    modelSettings: {
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
    },
  });
}
`;
const caller = `import { makeCall } from "./model";
export async function title(text: string) {
  return makeCall(text, { temperature: 0.4 });
}
export async function plain(text: string) {
  return makeCall(text, undefined);
}
`;

describe("Mastra modelSettings", () => {
  it("possible Anthropic settings, and the caller's literal through the wrapper", async () => {
    const t = await temps({ "package.json": pkg({ "@mastra/core": "1.51.0", "@ai-sdk/anthropic": "^3.0.9" }), "src/model.ts": model, "src/title.ts": caller });
    expect(t).toContain("src/model.ts:6:possible");
    expect(t).toContain("src/title.ts:3:possible");
    expect(t.some((x) => x.startsWith("src/title.ts:6"))).toBe(false);
  });
  it("not in a repo that can't reach Anthropic", async () => {
    expect(await temps({ "package.json": pkg({ "@mastra/core": "1.51.0", "@ai-sdk/openai": "^2.0.0" }), "src/model.ts": model, "src/title.ts": caller })).toEqual([]);
  });
  it("not without Mastra", async () => {
    expect(await temps({ "package.json": pkg({ "@ai-sdk/anthropic": "^3.0.9" }), "src/model.ts": model.replace("@mastra/core/agent", "./agent"), "src/title.ts": caller })).toEqual([]);
  });
});
