import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-fix2-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const handler = (check: string) => [
  'import OpenAI from "openai";',
  'import { CACHING_MODELS } from "@acme/types";',
  "export class Handler {",
  '  client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: "k" });',
  "  async complete(modelId: string, temperature: number) {",
  `    if (${check}) { /* cache breakpoints */ }`,
  "    return this.client.chat.completions.create({",
  "      model: modelId,",
  "      temperature,",
  '      messages: [{ role: "user", content: "hi" }],',
  "    });",
  "  }",
  "}",
].join("\n");
const types = {
  "packages/types/package.json": JSON.stringify({ name: "@acme/types" }),
  "packages/types/src/index.ts": 'export * from "./models";\n',
  "packages/types/src/models.ts": 'export const CACHING_MODELS = new Set([\n  "anthropic/claude-3-5-sonnet",\n  "google/gemini-2.5-pro",\n]);\n',
};

describe("gateways: a Claude model shown reaching the request", () => {
  it("the request's model tested against a set of Claude ids from a workspace package", async () => {
    const us = (await scanRepo(await repo({ ...types, "src/handler.ts": handler("CACHING_MODELS.has(modelId)") }))).usages;
    const a = us.find((u: any) => u.file === "src/handler.ts" && u.provider === "anthropic");
    expect(a).toMatchObject({ op: "POST /v1/messages", via: "openrouter", confidence: "possible", params: ["temperature"] });
  });
  it("a prefix test on the model counts; a gateway call with no sign of Claude doesn't", async () => {
    const yes = (await scanRepo(await repo({ "src/handler.ts": handler('modelId.startsWith("anthropic/")') }))).usages;
    expect(yes.some((u: any) => u.provider === "anthropic")).toBe(true);
    const no = (await scanRepo(await repo({ "src/handler.ts": handler('modelId.startsWith("google/")') }))).usages;
    expect(no.some((u: any) => u.provider === "anthropic")).toBe(false);
  });
});
