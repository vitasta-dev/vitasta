import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v14c-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const params = (us: any[], file: string) => us.filter((u) => u.file === file && u.params?.length).map((u) => `${u.line} ${u.provider} ${u.op} ${u.params.join(",")}`);

describe("v14c: Anthropic sampling params (pattern 2)", () => {
  it("raw HTTP to /v1/messages through a transport that sets anthropic-version", async () => {
    const d = await repo({
      "src/transport.ts": "export const httpRequest = (o: any) => fetch('https://api.anthropic.com' + o.url, { method: 'POST', headers: { 'anthropic-version': '2023-06-01', 'x-api-key': key }, body: JSON.stringify(o.body) });\n",
      "src/chat.ts": "import { httpRequest } from './transport';\nexport const chat = (temperature: number, top_p: number, top_k: number) => httpRequest({\n  url: '/v1/messages',\n  body: { model: 'claude-sonnet-4-5', temperature, top_p, top_k, messages: [] },\n});\n",
    });
    const p = params((await scanRepo(d)).usages, "src/chat.ts").join("\n");
    expect(p).toMatch(/anthropic POST \/v1\/messages .*temperature/);
    expect(p).toMatch(/top_p/);
  });

  it("Go: anthropic-sdk-go MessageNewParams with Temperature, through a wrapper", async () => {
    const d = await repo({
      "go.mod": "module x\nrequire github.com/anthropics/anthropic-sdk-go v1.2.0\n",
      "llm/claude.go": "package llm\n\nimport \"github.com/anthropics/anthropic-sdk-go\"\n\nfunc params(model string) anthropic.MessageNewParams {\n\treturn anthropic.MessageNewParams{\n\t\tModel:       anthropic.Model(model),\n\t\tMaxTokens:   1024,\n\t\tTemperature: anthropic.Float(0),\n\t\tTopP:        anthropic.Float(0.9),\n\t}\n}\n",
    });
    const p = params((await scanRepo(d)).usages, "llm/claude.go").join("\n");
    expect(p).toMatch(/anthropic POST \/v1\/messages .*temperature/);
    expect(p).toMatch(/top_p/);
  });

  it("Ruby: an endpoint builder merging temperature and top_p into a payload posted to /v1/messages", async () => {
    const d = await repo({
      "Gemfile": "gem 'faraday'\n",
      "lib/anthropic_client.rb": "class AnthropicClient\n  API = 'https://api.anthropic.com'\n  def complete(prompt, temperature: 0.7, top_p: 0.9)\n    payload = { model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }\n    payload = payload.merge(temperature: temperature, top_p: top_p)\n    conn.post('/v1/messages', payload.to_json)\n  end\nend\n",
    });
    const p = params((await scanRepo(d)).usages, "lib/anthropic_client.rb").join("\n");
    expect(p).toMatch(/anthropic POST \/v1\/messages .*temperature/);
    expect(p).toMatch(/top_p/);
  });

  it("TS: messages.create with temperature from a helper spread in", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"@anthropic-ai/sdk":"^0.40.0"}}',
      "src/ask.ts": "import Anthropic from '@anthropic-ai/sdk';\nconst client = new Anthropic();\nfunction getModelParams(o: any) {\n  return { temperature: o.temperature, top_p: o.topP };\n}\nexport const ask = (o: any) => client.messages.create({\n  model: o.model,\n  max_tokens: 100,\n  ...getModelParams(o),\n  messages: [],\n});\n",
    });
    const p = params((await scanRepo(d)).usages, "src/ask.ts").join("\n");
    expect(p).toMatch(/anthropic POST \/v1\/messages .*temperature/);
    expect(p).toMatch(/top_p/);
  });

  it("LangChain: new ChatAnthropic({ temperature, topP, topK }) and an llmConfig object handed to it", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"@langchain/anthropic":"^0.3.0"}}',
      "src/lc.ts": "import { ChatAnthropic } from '@langchain/anthropic';\nexport const a = new ChatAnthropic({ model: 'claude-sonnet-4-5', temperature: 0.2, topP: 0.9, topK: 40 });\nconst llmConfig = { model: 'claude-sonnet-4-5', temperature: 0.5, topP: 0.8 };\nexport const b = new ChatAnthropic(llmConfig);\n",
    });
    const p = params((await scanRepo(d)).usages, "src/lc.ts").join("\n");
    expect(p).toMatch(/2 anthropic POST \/v1\/messages .*temperature/);
    expect(p).toMatch(/top_p|topP/);
    expect(p).toMatch(/3 anthropic POST \/v1\/messages .*temperature/);
  });
});

describe("v14c: precision (set 5 wrong calls)", () => {
  const breaks = (us: any[], file: string) => us.filter((u) => u.file === file && u.role === "breaks");
  it("a .env version line no code reads is a copy for users; one the code reads still breaks", async () => {
    const d = await repo({
      ".env": "FACEBOOK_GRAPH_VERSION=v3.0\nWA_VERSION=v18.0\n",
      "src/wa.ts": "export const url = `https://graph.facebook.com/${process.env.WA_VERSION}/me`;\n",
    });
    const us = (await scanRepo(d)).usages.filter((u: any) => u.file === ".env" && u.apiVersion);
    expect(us.find((u: any) => u.line === 1)?.role).toBe("users-copy");
    expect(us.find((u: any) => u.line === 2)?.role).toBe("breaks");
  });

  it("AnthropicVertex calls aren't reported under /v1/messages; a plain client in the same repo still is", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"@anthropic-ai/sdk":"^0.40.0","@anthropic-ai/vertex-sdk":"^0.7.0"}}',
      "src/vertex.ts": "import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';\nconst client = new AnthropicVertex({ region: 'us-east5', projectId: 'p' });\nexport const go = () => client.messages.create({ model: 'claude-sonnet-4-5@20250929', max_tokens: 10, temperature: 0.2, top_p: 0.9, messages: [] });\n",
      "src/plain.ts": "import Anthropic from '@anthropic-ai/sdk';\nconst client = new Anthropic();\nexport const go = () => client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 10, temperature: 0.2, top_p: 0.9, messages: [] });\n",
    });
    const us = (await scanRepo(d)).usages;
    expect(us.filter((u: any) => u.file === "src/vertex.ts" && u.op === "POST /v1/messages")).toEqual([]);
    expect(params(us, "src/plain.ts").join(" ")).toMatch(/temperature/);
  });

  it("the Anthropic SDK pointed at another host (an Anthropic-compatible API) isn't Anthropic", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"@anthropic-ai/sdk":"^0.40.0"}}',
      "src/minimax.ts": "import Anthropic from '@anthropic-ai/sdk';\nconst client = new Anthropic({ apiKey: key, baseURL: 'https://api.minimax.io/anthropic' });\nexport const go = () => client.messages.create({ model: 'MiniMax-M2', max_tokens: 10, temperature: 0.2, top_p: 0.9, messages: [] });\n",
      "src/real.ts": "import Anthropic from '@anthropic-ai/sdk';\nconst client = new Anthropic({ baseURL: 'https://api.anthropic.com' });\nexport const go = () => client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 10, temperature: 0.2, top_p: 0.9, messages: [] });\n",
    });
    const us = (await scanRepo(d)).usages;
    expect(us.filter((u: any) => u.file === "src/minimax.ts" && u.provider === "anthropic" && u.op)).toEqual([]);
    expect(breaks(us, "src/real.ts").length).toBeGreaterThan(0);
  });
});

describe("v14c: request-body negatives (corpus check)", () => {
  it("a name resolves to its nearest definition: another function's `request` (an OpenAI one) isn't followed; a parameter default isn't a body", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"@anthropic-ai/sdk":"^0.40.0"}}',
      "emit.mjs": "async function openaiOne(sdk, client) {\n  const request = {\n    model: 'gpt-5',\n    temperature: 0.2,\n    top_p: 0.9,\n  };\n  await sdk.openai.responses.create(client, request);\n}\nasync function anthropicOne(sdk, client) {\n  const request = {\n    model: 'claude-sonnet-4-5',\n    max_tokens: 10,\n    messages: [],\n  };\n  await sdk.anthropic.messages.create(client, request);\n}\nexport const gen = async (prompt, temperature = 0.7) => client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1, temperature, messages: [] });\n",
    });
    const p = params((await scanRepo(d)).usages, "emit.mjs");
    expect(p.join(" ")).not.toMatch(/^[3-5] /m);
    expect(p.filter((x) => /^(3|4|5|17) /.test(x) && !/^17 /.test(x))).toEqual([]);
  });

  it("a file importing the plain client next to AnthropicVertex / AnthropicBedrock still reports its calls", async () => {
    const d = await repo({
      "requirements.txt": "anthropic==0.40.0\n",
      "loop.py": "from anthropic import (\n    Anthropic,\n    AnthropicBedrock,\n    AnthropicVertex,\n)\n\ndef call(anthropic_client: Anthropic, model):\n    return anthropic_client.beta.messages.create(model=model, max_tokens=10, temperature=0.3, messages=[])\n",
    });
    const us = (await scanRepo(d)).usages.filter((u: any) => u.file === "loop.py" && u.op);
    expect(us.length).toBeGreaterThan(0);
  });
});
