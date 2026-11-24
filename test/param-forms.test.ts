import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-forms-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const FILES: Record<string, string> = {
  "a.py": "import anthropic\nc = anthropic.Anthropic()\nc.messages.create(model=\"claude-sonnet-4-5\", max_tokens=10, temperature=0.2, top_p=0.9, messages=[])\n",
  "a.go": "package main\nimport \"github.com/anthropics/anthropic-sdk-go\"\nfunc f(client anthropic.Client) {\n\tclient.Messages.New(ctx, anthropic.MessageNewParams{\n\t\tModel:       \"claude-sonnet-4-5\",\n\t\tMaxTokens:   10,\n\t\tTemperature: anthropic.Float(0.2),\n\t\tTopP:        anthropic.Float(0.9),\n\t})\n}\n",
  "A.java": "import com.anthropic.client.AnthropicClient;\nimport com.anthropic.models.messages.MessageCreateParams;\nclass A { void f(AnthropicClient client) {\n  MessageCreateParams params = MessageCreateParams.builder().model(\"claude-sonnet-4-5\").maxTokens(10L).temperature(0.2).topP(0.9).build();\n  client.messages().create(params);\n} }\n",
  "A.cs": "using Anthropic;\nclass A { async Task F(AnthropicClient client) {\n  var p = new MessageCreateParams { Model = \"claude-sonnet-4-5\", MaxTokens = 10, Temperature = 0.2, TopP = 0.9 };\n  await client.Messages.Create(p);\n} }\n",
  "a.rb": "require \"anthropic\"\nclient = Anthropic::Client.new\nclient.messages.create(model: \"claude-sonnet-4-5\", max_tokens: 10, temperature: 0.2, top_p: 0.9, messages: [])\n",
  "a.php": "<?php\n$client = Anthropic::client($key);\n$client->messages()->create(['model' => 'claude-sonnet-4-5', 'max_tokens' => 10, 'temperature' => 0.2, 'top_p' => 0.9, 'messages' => []]);\n",
  "a.ts": "import Anthropic from \"@anthropic-ai/sdk\";\nconst c = new Anthropic();\nexport const f = () => c.messages.create({ model: \"claude-sonnet-4-5\", max_tokens: 10, top_p: 0.9, temperature: 0.2, messages: [] });\n"
};

describe("request settings in each language's own spelling", () => {
  it("temperature and top_p in TS, Python, Go, Java, C#, Ruby and PHP Anthropic calls", async () => {
    const us = (await scanRepo(await repo(FILES))).usages.filter((u: any) => u.provider === "anthropic");
    for (const f of Object.keys(FILES)) {
      const ps = new Set(us.filter((u: any) => u.file === f).flatMap((u: any) => u.params ?? []));
      expect([f, ps.has("temperature"), ps.has("top_p")]).toEqual([f, true, true]);
    }
  });
  it("C#: a second typed Stripe options object setting the same field in a file is its own place", async () => {
    const us = (await scanRepo(await repo({ "C.cs": "using Stripe;\npublic class C {\n    public async Task A() {\n        var options = new SetupIntentCreateOptions\n        {\n            PaymentMethodTypes = [\"us_bank_account\"],\n        };\n        await adapter.CreateSetupIntentAsync(options);\n    }\n    public async Task B() {\n        var options = new SetupIntentCreateOptions\n        {\n            PaymentMethodTypes = [\"card\"],\n        };\n        await adapter.CreateSetupIntentAsync(options);\n    }\n}\n" }))).usages;
    expect(us.filter((u: any) => u.params?.includes("payment_method_types")).map((u: any) => u.line)).toEqual([6, 13]);
  });
});
