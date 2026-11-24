import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Category 4 of the blind OpenAI-compatible gateways (OpenRouter, GitHub Copilot) carrying a Claude
// model the repo offers in a seed, default or model list elsewhere (src/scan/gateways.ts)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-gw-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const claudeTemps = async (files: Record<string, string>) =>
  ((await scanRepo(await repo(files))).usages as any[]).filter((u) => u.provider === "anthropic" && u.params?.includes("temperature")).map((u) => `${u.file}:${u.line}`);

const llm = (model: string) => `export async function complete(prompt: string, model: string) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ ${model}, messages: [{ role: "user", content: prompt }], temperature: 0.7 }),
  });
  return res.json();
}
`;
const models = (id: string) => JSON.stringify({ default: "openai/gpt-4o-mini", options: [{ id: "openai/gpt-4o-mini" }, { id }] }, null, 1);

describe("gateways with a Claude model the repo offers elsewhere", () => {
  it("OpenRouter: a model list in config/models.json with an anthropic/claude id", async () => {
    expect(await claudeTemps({ "src/llm.ts": llm("model"), "config/models.json": models("anthropic/claude-sonnet-4.5") })).toEqual(["src/llm.ts:2"]);
  });
  it("Copilot chat/completions: a raw request, the Claude id in the file's model list", async () => {
    const t = await claudeTemps({
      "src/copilot.ts": 'export const COPILOT_MODELS = ["gpt-4o", "claude-sonnet-4"];\nexport async function chat(token: string, model: string) {\n  return fetch("https://api.githubcopilot.com/chat/completions", {\n    method: "POST",\n    body: JSON.stringify({ model, messages: [], temperature: 0.1 }),\n  });\n}\n',
    });
    expect(t).toEqual(["src/copilot.ts:5"]);
  });
  it("not when the repo offers no Claude model", async () => {
    expect(await claudeTemps({ "src/llm.ts": llm("model"), "config/models.json": models("mistralai/mistral-large") })).toEqual([]);
  });
  it("not when the request's model is another provider's literal", async () => {
    expect(await claudeTemps({ "src/llm.ts": llm('model: "openai/gpt-4o-mini"'), "config/models.json": models("anthropic/claude-sonnet-4.5") })).toEqual([]);
  });
});
