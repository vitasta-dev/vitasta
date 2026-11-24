import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v17-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
/** Lines where an Anthropic temperature is reported as a break */
const temps = async (files: Record<string, string>, file: string) =>
  (await scanRepo(await repo(files))).usages
    .filter((u: any) => u.file === file && u.provider === "anthropic" && u.role === "breaks" && u.params?.includes("temperature"))
    .map((u: any) => u.line);

describe("v17: Anthropic mining gaps", () => {
  it("Python: a name bound to clients of two providers resolves by the call", async () => {
    const f = "bench.py";
    const us = (await scanRepo(await repo({ [f]: [
      "import anthropic",
      "from google.generativeai import GenerativeModel",
      "",
      "def run(name, prompt):",
      "    if name.startswith('claude'):",
      "        model = anthropic.Anthropic()",
      "    else:",
      "        model = GenerativeModel(name)",
      "    if name.startswith('claude'):",
      "        return model.messages.create(model=name, max_tokens=100, temperature=1, messages=[{'role': 'user', 'content': prompt}])",
      "    return model.generate_content(prompt)",
      "",
    ].join("\n") }))).usages;
    const call = us.find((u: any) => u.file === f && u.provider === "anthropic" && u.kind === "sdk" && u.line === 10 && u.sdkCall);
    expect(call?.params).toEqual(expect.arrayContaining(["max_tokens", "temperature", "messages"]));
  });

  it("Python: a model name with one value per provider stays reported; the chosen call keeps its params", async () => {
    const f = "llm.py";
    const us = (await scanRepo(await repo({ [f]: [
      "import os",
      "from openai import OpenAI",
      "from anthropic import Anthropic",
      "ENGINE = os.getenv('ENGINE', 'openai')",
      "if ENGINE == 'openai':",
      "    MODEL_NAME = os.getenv('MODEL_NAME_OPENAI', 'gpt-4o-mini')",
      "elif ENGINE == 'claude':",
      "    MODEL_NAME = os.getenv('MODEL_NAME_CLAUDE', 'claude-sonnet-4-20250514')",
      "else:",
      "    MODEL_NAME = os.getenv('MODEL_NAME_LOCAL', 'llama-3.3-70b-instruct')",
      "",
      "def ask(prompt):",
      "    if ENGINE == 'openai':",
      "        client = OpenAI()",
      "        return client.chat.completions.create(model=MODEL_NAME, messages=[], temperature=0.2)",
      "    client = Anthropic()",
      "    return client.messages.create(model=MODEL_NAME, max_tokens=100, messages=[], temperature=0.2)",
      "",
    ].join("\n") }))).usages.filter((u: any) => u.file === f && u.role === "breaks");
    expect(us.find((u: any) => u.line === 6 && u.model === "gpt-4o-mini")).toBeTruthy();
    expect(us.find((u: any) => u.line === 8 && u.model === "claude-sonnet-4-20250514")).toBeTruthy();
    const call = us.find((u: any) => u.line === 17 && u.provider === "anthropic");
    expect(call?.params).toContain("temperature");
    expect(call?.model).toBeUndefined();
  });

  it("JS: a shorthand key on its own line in the body is sent; a destructured one isn't", async () => {
    const f = "lib/claude.ts";
    const t = await temps({ [f]: [
      "export async function askClaude(prompt: string, temperature: number) {",
      "  const body = {",
      "    model: 'claude-sonnet-4-5',",
      "    max_tokens: 100,",
      "    temperature,",
      "    messages: [{ role: 'user', content: prompt }],",
      "  }",
      "  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify(body) })",
      "  return res.json()",
      "}",
      "",
      "export async function askClaudeWith(opts: any) {",
      "  const {",
      "    temperature,",
      "    prompt,",
      "  } = opts",
      "  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 100, messages: [{ role: 'user', content: prompt }] }) })",
      "  return res.json()",
      "}",
      "",
    ].join("\n") }, f);
    expect(t).toContain(5);
    expect(t).not.toContain(14);
  });

  it("JS: an object method (name: async function) is a function; so is export default", async () => {
    const a = "services/api.js";
    const b = "api/proxy.ts";
    const files = {
      [a]: [
        "export const api = {",
        "  callOther: async function (key, prompt) {",
        "    return fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', temperature: 0.1 }) })",
        "  },",
        "  callAnthropic: async function (key, prompt, temperature) {",
        "    const payload = { model: 'claude-sonnet-4-5', max_tokens: 100, temperature: temperature, messages: [] }",
        "    return fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify(payload) })",
        "  },",
        "}",
        "",
      ].join("\n"),
      [b]: [
        "export default async function handler(req, res) {",
        "  const { provider } = req.body",
        "  let url = ''",
        "  let body = {}",
        "  if (provider === 'openai') {",
        "    url = 'https://api.openai.com/v1/chat/completions'",
        "    body = { model: 'gpt-4o', temperature: 0.5 }",
        "  } else if (provider === 'anthropic') {",
        "    url = 'https://api.anthropic.com/v1/messages'",
        "    body = {",
        "      model: 'claude-sonnet-4-5',",
        "      max_tokens: 100,",
        "      temperature: 0.2,",
        "    }",
        "  }",
        "  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) })",
        "  res.json(await r.json())",
        "}",
        "",
      ].join("\n"),
    };
    const ta = await temps(files, a);
    expect(ta).toContain(6);
    expect(ta).not.toContain(3);
    const tb = await temps(files, b);
    expect(tb).toContain(13);
    expect(tb).not.toContain(7);
  });

  it("JS: the branch that builds the body counts, not just the fetch options object", async () => {
    const f = "app.js";
    const t = await temps({ [f]: [
      "async function testConnection(endpoint, config) {",
      "  if (endpoint === 'openrouter') {",
      "    return fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: config.model }) })",
      "  } else if (endpoint === 'claude') {",
      "    const body = { model: config.model, max_tokens: 1, messages: [] }",
      "    body.temperature = 1",
      "    return fetch('https://api.anthropic.com/v1/messages', {",
      "      method: 'POST',",
      "      headers: { 'anthropic-version': '2023-06-01' },",
      "      body: JSON.stringify(body),",
      "    })",
      "  }",
      "}",
      "",
    ].join("\n") }, f);
    expect(t).toContain(6);
  });

  it("Python: '\"\"\"' inside an ordinary string doesn't hide the rest of the file", async () => {
    const f = "client.py";
    const t = await temps({ [f]: [
      "import requests",
      "",
      "def clean(text):",
      "    return text.replace('\"\"\"', '\"')",
      "",
      "class Client:",
      "    def ask_anthropic(self, prompt):",
      "        data = {'model': self.model, 'max_tokens': 100, 'messages': [{'role': 'user', 'content': prompt}]}",
      "        if self.temperature is not None:",
      "            data['temperature'] = self.temperature",
      "        r = requests.post('https://api.anthropic.com/v1/messages', headers={'anthropic-version': '2023-06-01'}, json=data)",
      "        return r.json()",
      "",
    ].join("\n") }, f);
    expect(t).toContain(10);
  });

  it("a generic name (url) holding the Anthropic endpoint doesn't make every url in the file Anthropic's", async () => {
    const f = "chat-client.ts";
    const t = await temps({ [f]: [
      "function openAiFields(r: any) {",
      "  const fields: Record<string, unknown> = {}",
      "  fields.temperature = r.temperature",
      "  return fields",
      "}",
      "",
      "const descriptors = {",
      "  compatible: {",
      "    build: (s: any, r: any) => {",
      "      return { url: `${s.base}/chat/completions`, body: { model: s.model, ...openAiFields(r) } }",
      "    },",
      "  },",
      "  claude: {",
      "    build: (s: any, r: any) => {",
      "      return { url: 'https://api.anthropic.com/v1/messages', body: { model: s.model, max_tokens: 100, temperature: r.temperature } }",
      "    },",
      "  },",
      "}",
      "",
    ].join("\n") }, f);
    expect(t).not.toContain(3);
    expect(t).toContain(15);
  });
});

describe("v17: provider-named functions with a signature over several lines", () => {
  it("Java: buildAnthropicBody(String model,\n String system) builds the Anthropic body", async () => {
    const f = "src/main/java/app/Llm.java";
    const t = await temps({ [f]: [
      "public final class Llm {",
      "  private static final String OPENAI = \"https://api.openai.com/v1/chat/completions\";",
      "  private static final String ANTHROPIC = \"https://api.anthropic.com/v1/messages\";",
      "  private JsonObject buildOpenAiBody(String model) {",
      "    JsonObject b = new JsonObject();",
      "    b.addProperty(\"temperature\", temperature);",
      "    return b;",
      "  }",
      "  private JsonObject buildAnthropicBody(String model,",
      "                                       String system) {",
      "    JsonObject b = new JsonObject();",
      "    b.addProperty(\"model\", model);",
      "    b.addProperty(\"temperature\", temperature);",
      "    return b;",
      "  }",
      "}",
      "",
    ].join("\n") }, f);
    expect(t).toContain(13);
    expect(t).not.toContain(6);
  });
});

describe("v17: AI SDK sampling settings by the installed @ai-sdk/anthropic release", () => {
  const lock = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/@ai-sdk/anthropic": { version: v } } });
  const manifest = (range: string) => JSON.stringify({ dependencies: { ai: "^5.0.0", "@ai-sdk/anthropic": range } });
  const runtimeFile = [
    "import { generateText } from 'ai'",
    "import { createAnthropic } from '@ai-sdk/anthropic'",
    "import { createOpenAI } from '@ai-sdk/openai'",
    "",
    "export function getModel(c: { provider: string; model: string; key: string }) {",
    "  switch (c.provider) {",
    "    case 'anthropic': return createAnthropic({ apiKey: c.key })(c.model)",
    "    default: return createOpenAI({ apiKey: c.key })(c.model)",
    "  }",
    "}",
    "",
    "export async function reply(c: any, prompt: string) {",
    "  const r = await generateText({",
    "    model: getModel(c),",
    "    prompt,",
    "    temperature: 0.4,",
    "  })",
    "  return r.text",
    "}",
    "",
  ].join("\n");
  const staticFile = (model: string) => [
    "import { generateText } from 'ai'",
    "import { anthropic } from '@ai-sdk/anthropic'",
    "",
    "export async function reply(prompt: string) {",
    "  const r = await generateText({",
    `    model: anthropic('${model}'),`,
    "    prompt,",
    "    temperature: 0.4,",
    "  })",
    "  return r.text",
    "}",
    "",
  ].join("\n");
  const at = async (files: Record<string, string>, file: string) =>
    (await scanRepo(await repo(files))).usages
      .filter((u: any) => u.file === file && u.provider === "anthropic" && u.params?.includes("temperature"))
      .map((u: any) => `${u.line} ${u.role}`);

  it("a model picked at runtime, before the drop logic (2.0.57): a break, with the wiring named", async () => {
    const us = (await scanRepo(await repo({ "lib/ai.ts": runtimeFile, "package.json": manifest("2.0.57"), "package-lock.json": lock("2.0.57") }))).usages;
    const u = us.find((x: any) => x.file === "lib/ai.ts" && x.params?.includes("temperature"));
    expect(u?.role).toBe("breaks");
    expect(u?.line).toBe(16);
    expect(u?.reason).toMatch(/getModel → createAnthropic/);
  });
  it("a model picked at runtime on a release with the drop logic: a note", async () => {
    expect(await at({ "lib/ai.ts": runtimeFile, "package.json": manifest("^4.0.0"), "package-lock.json": lock("4.0.106") }, "lib/ai.ts")).toEqual(["16 recorded"]);
  });
  it("a model picked at runtime with no manifest naming @ai-sdk/anthropic: not a finding", async () => {
    expect(await at({ "lib/ai.ts": runtimeFile }, "lib/ai.ts")).toEqual([]);
  });
  it("a known model the release drops sampling for: not a finding; one that takes sampling: sent", async () => {
    expect(await at({ "lib/ai.ts": staticFile("claude-opus-5-5"), "package.json": manifest("^4.0.0"), "package-lock.json": lock("4.0.106") }, "lib/ai.ts")).toEqual([]);
    expect(await at({ "lib/ai.ts": staticFile("claude-sonnet-4-5"), "package.json": manifest("^4.0.0"), "package-lock.json": lock("4.0.106") }, "lib/ai.ts")).toEqual(["8 breaks"]);
  });
  it("a manifest minimum whose later releases disagree, or a major not read: a note", async () => {
    // 3.0.70 sends sampling for claude-opus-5-5 (not in its list, no fallback); later 3.x releases drop it
    expect(await at({ "lib/ai.ts": staticFile("claude-opus-5-5"), "package.json": manifest("^3.0.70") }, "lib/ai.ts")).toEqual(["8 recorded"]);
    expect(await at({ "lib/ai.ts": staticFile("claude-opus-5-5"), "package.json": manifest("^0.0.30"), "package-lock.json": lock("0.0.30") }, "lib/ai.ts")).toEqual(["8 recorded"]);
  });
});
