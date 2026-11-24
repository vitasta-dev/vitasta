import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v15b-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const sampling = (us: any[], file: string) => us.filter((u) => u.file === file && u.provider === "anthropic" && u.role === "breaks" && u.params?.some((p: string) => ["temperature", "top_p", "top_k"].includes(p))).map((u) => `${u.line} ${u.params.filter((p: string) => ["temperature", "top_p", "top_k"].includes(p)).join(",")}`);

describe("v15b: sampling settings in code that sends to Anthropic's Messages API", () => {
  it("Go: a struct body in a function that posts to a URL constant", async () => {
    const d = await repo({ "llm/claude.go": "package llm\n\nconst anthropicURL = \"https://api.anthropic.com/v1/messages\"\n\ntype req struct {\n\tModel       string  `json:\"model\"`\n\tTemperature float64 `json:\"temperature\"`\n}\n\nfunc (c *Client) Ask(p string) error {\n\tbody := req{\n\t\tModel:       \"claude-sonnet-4-5\",\n\t\tTemperature: 0.2,\n\t}\n\tb, _ := json.Marshal(body)\n\t_, err := http.Post(anthropicURL, \"application/json\", bytes.NewReader(b))\n\treturn err\n}\n" });
    const s = sampling((await scanRepo(d)).usages, "llm/claude.go");
    expect(s).toContain("13 temperature");
    expect(s.join(" ")).not.toMatch(/^7 /m);
  });
  it("Python: a dict posted with requests, and body[\"top_p\"] = …", async () => {
    const d = await repo({ "ai.py": "import requests\n\ndef ask(prompt, top_p=None):\n    data = {\n        \"model\": \"claude-3-5-sonnet-20241022\",\n        \"temperature\": 0.5,\n        \"messages\": [{\"role\": \"user\", \"content\": prompt}],\n    }\n    if top_p:\n        data[\"top_p\"] = top_p\n    return requests.post(\"https://api.anthropic.com/v1/messages\", json=data)\n" });
    const s = sampling((await scanRepo(d)).usages, "ai.py");
    expect(s).toContain("6 temperature");
    expect(s).toContain("10 top_p");
  });
  it("JS: a fetch body in a function with a destructured parameter", async () => {
    const d = await repo({ "lib/ai.js": "export async function callAnthropic({\n  prompt,\n  model,\n}) {\n  const url = \"https://api.anthropic.com/v1/messages\";\n  const res = await fetch(url, {\n    method: \"POST\",\n    body: JSON.stringify({\n      model,\n      temperature: 0.3,\n      messages: [{ role: \"user\", content: prompt }],\n    }),\n  });\n  return res.json();\n}\n" });
    // (reported on the fetch call or on the key)
    expect(sampling((await scanRepo(d)).usages, "lib/ai.js").join(" ")).toMatch(/(^|\s)(6|10) temperature/);
  });
  it("Go: a params helper the sending function calls (buildParams → Messages.New)", async () => {
    const d = await repo({ "go.mod": "module x\nrequire github.com/anthropics/anthropic-sdk-go v1.2.0\n", "provider.go": "package p\n\nimport \"github.com/anthropics/anthropic-sdk-go\"\n\nfunc (p *P) buildParams(o Opts) anthropic.MessageNewParams {\n\tparams := anthropic.MessageNewParams{Model: o.Model, MaxTokens: 1024}\n\tif o.Temp != nil {\n\t\tparams.Temperature = anthropic.Float(*o.Temp)\n\t}\n\treturn params\n}\n\nfunc (p *P) Chat(o Opts) error {\n\t_, err := p.client.Messages.New(ctx, p.buildParams(o))\n\treturn err\n}\n" });
    expect(sampling((await scanRepo(d)).usages, "provider.go")).toContain("8 temperature");
  });
  it("Go: langchaingo with an Anthropic model and llms.WithTemperature", async () => {
    const d = await repo({ "pkg/providers/anthropic/anthropic.go": "package anthropic\n\nimport \"github.com/tmc/langchaingo/llms/anthropic\"\n\nfunc New() (*Provider, error) {\n\tllm, err := anthropic.New(anthropic.WithModel(\"claude-3-5-sonnet-latest\"))\n\treturn &Provider{llm: llm, opts: []llms.CallOption{llms.WithTemperature(0.2), llms.WithTopP(0.9)}}, err\n}\n" });
    const s = sampling((await scanRepo(d)).usages, "pkg/providers/anthropic/anthropic.go");
    expect(s.join(" ")).toMatch(/7 temperature/);
    expect(s.join(" ")).toMatch(/top_p/);
  });
  it("PHP: $body['temperature'] = … in a function sending to Anthropic", async () => {
    const d = await repo({ "src/AiClient.php": "<?php\nclass AiClient {\n  private function sendAnthropicRequest($prompt, $temperature) {\n    $body = ['model' => 'claude-sonnet-4-5', 'messages' => [['role' => 'user', 'content' => $prompt]]];\n    $body['temperature'] = $temperature;\n    return $this->http->post('https://api.anthropic.com/v1/messages', ['json' => $body]);\n  }\n}\n" });
    expect(sampling((await scanRepo(d)).usages, "src/AiClient.php")).toContain("5 temperature");
  });
  it("negatives: the OpenAI function next door, a log message, a retrieval top_k, a parameter copy", async () => {
    const d = await repo({ "llm.ts": "export async function callOpenAI(prompt: string) {\n  return fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', temperature: 0.9, messages: [] }) });\n}\nexport async function callClaude(prompt: string, docs: any) {\n  const hits = docs.search(prompt, { top_k: 5 });\n  console.log(`Using temperature=${0.3} for ${hits.length}`);\n  return fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-4-5', temperature: 0.3, messages: [] }) });\n}\n",
      "Claude.java": "class ClaudeClient {\n  private final double temperature;\n  ClaudeClient(double temperature) {\n    this.temperature = temperature;\n  }\n  String url() { return \"https://api.anthropic.com/v1/messages\"; }\n}\n" });
    const us = (await scanRepo(d)).usages;
    const s = sampling(us, "llm.ts");
    expect(s.join(" ")).not.toMatch(/(^|\s)2 /);
    expect(s.join(" ")).not.toMatch(/(^|\s)6 /);
    expect(s.join(" ")).not.toMatch(/5 top_k/);
    expect(s.join(" ")).toMatch(/7 temperature/);
    expect(sampling(us, "Claude.java").join(" ")).not.toMatch(/(^|\s)4 /);
  });
  it("negatives: a telemetry record copying the request, a request translated for another API, a logged getter", async () => {
    const d = await repo({
      "providers/anthropic/mapper.go": "package anthropic\n\nfunc toGeneration(req Req) Generation {\n\tmaxTokens, temperature, topP := controls(req)\n\treturn Generation{\n\t\tMaxTokens:   maxTokens,\n\t\tTemperature: temperature,\n\t\tTopP:        topP,\n\t}\n}\n\nfunc controls(req Req) (int, float64, float64) {\n\treturn req.MaxTokens, req.Temperature, req.TopP\n}\n",
      "translate/anthropic.go": "package translate\n\nfunc ToOpenAI(req AnthropicRequest) ChatRequest {\n\tresult := ChatRequest{}\n\tresult.Temperature = req.Temperature\n\tresult.TopP = req.TopP\n\treturn result\n}\n",
      "ClaudeService.java": "import com.anthropic.models.messages.MessageCreateParams;\n\nclass ClaudeService {\n  String ask(String p) {\n    MessageCreateParams params = MessageCreateParams.builder().model(\"claude-sonnet-4-5\").maxTokens(100).build();\n    log.info(\"t={}\", params.temperature());\n    return client.messages().create(params).toString();\n  }\n}\n",
    });
    const us = (await scanRepo(d)).usages;
    expect(sampling(us, "providers/anthropic/mapper.go")).toEqual([]);
    expect(sampling(us, "translate/anthropic.go")).toEqual([]);
    expect(sampling(us, "ClaudeService.java")).toEqual([]);
  });
  it("a parameter passed straight into messages.create is still sent", async () => {
    const d = await repo({ "bot.py": "import anthropic\n\nclient = anthropic.Anthropic()\n\ndef ask(p, temperature=0.7):\n    return client.messages.create(\n        model=\"claude-sonnet-4-5\",\n        max_tokens=100,\n        temperature=temperature,\n        messages=[{\"role\": \"user\", \"content\": p}],\n    )\n" });
    expect(sampling((await scanRepo(d)).usages, "bot.py").join(" ")).toMatch(/temperature/);
  });
  it("negatives: a converter named for two providers, a validation schema, a local read from a getter", async () => {
    const d = await repo({
      "convert.go": "package convert\n\nfunc AnthropicRequestToOpenAI(req AnthropicRequest) ChatRequest {\n\tresult := ChatRequest{}\n\tresult.Temperature = req.Temperature\n\treturn result\n}\n",
      "src/providers/anthropic.ts": "import Anthropic from '@anthropic-ai/sdk';\nimport { z } from 'zod';\n\nexport const Schema = z.object({\n  temperature: z.number().min(0).max(1).optional(),\n});\n\nexport async function run(c: Anthropic, p: string) {\n  return c.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: p }] });\n}\n",
      "providers/anthropic/Adapter.java": "class Adapter {\n  Generation map(Request request) {\n    Double temperature = request.temperature().orElse(null);\n    return client.messages().create(params);\n  }\n}\n",
    });
    const us = (await scanRepo(d)).usages;
    expect(sampling(us, "convert.go")).toEqual([]);
    expect(sampling(us, "src/providers/anthropic.ts")).toEqual([]);
    expect(sampling(us, "providers/anthropic/Adapter.java")).toEqual([]);
  });
});
