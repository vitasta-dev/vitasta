import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Documented SDK and framework calls in Ruby, PHP, C#, Java and Go (ruby-openai, the anthropic gem, openai-php and its
// Laravel facade, Anthropic PHP, OpenAI .NET, Anthropic.SDK, Microsoft.Extensions.AI, Spring AI, go-openai, a raw Go
// request struct)
const FILES: Record<string, string> = {
  "As.cs": "using Anthropic.SDK;\nusing Anthropic.SDK.Messaging;\nclass B { async Task F(AnthropicClient client) {\n  var p = new MessageParameters { Model = \"claude-sonnet-4-5\", MaxTokens = 100, Temperature = 1.0m, Messages = msgs };\n  await client.Messages.GetClaudeMessageAsync(p);\n} }\n",
  "Me.cs": "using Microsoft.Extensions.AI;\nusing Anthropic;\nclass C { async Task F() {\n  IChatClient chat = new AnthropicClient().AsIChatClient(\"claude-sonnet-4-5\");\n  var options = new ChatOptions { Temperature = 0.3f, TopP = 0.8f, TopK = 40 };\n  await chat.GetResponseAsync(messages, options);\n} }\n",
  "Oa.cs": "using OpenAI.Chat;\nusing OpenAI.Assistants;\nclass A { void F() {\n  ChatClient client = new(\"gpt-4o\", key);\n  var opts = new ChatCompletionOptions { Temperature = 0.2f, TopP = 0.9f };\n  client.CompleteChat(messages, opts);\n  AssistantClient ac = openAIClient.GetAssistantClient();\n  ac.CreateAssistant(\"gpt-4o\");\n} }\n",
  "Sp.java": "import org.springframework.ai.anthropic.AnthropicChatOptions;\nclass S { Object f() {\n  return AnthropicChatOptions.builder().model(\"claude-sonnet-4-5\").temperature(0.4).topP(0.9).build();\n} }\n",
  "an.php": "<?php\nuse Anthropic\\Client;\n$client = new Client(apiKey: getenv('KEY'));\n$m = $client->messages->create(maxTokens: 100, messages: [], model: 'claude-sonnet-4-5', temperature: 0.2);\n",
  "application.properties": "spring.ai.anthropic.api-key=${KEY}\nspring.ai.anthropic.chat.options.model=claude-sonnet-4-5\nspring.ai.anthropic.chat.options.temperature=0.7\n",
  "go1.go": "package main\nimport openai \"github.com/sashabaranov/go-openai\"\nfunc f(c *openai.Client) {\n\tc.CreateChatCompletion(ctx, openai.ChatCompletionRequest{\n\t\tModel:       openai.GPT4o,\n\t\tTemperature: 0.2,\n\t})\n\tc.ListAssistants(ctx, nil, nil, nil, nil)\n}\n",
  "go2.go": "package main\nimport (\"bytes\"; \"encoding/json\"; \"net/http\")\ntype messagesRequest struct {\n\tModel       string  `json:\"model\"`\n\tMaxTokens   int     `json:\"max_tokens\"`\n\tTemperature float64 `json:\"temperature,omitempty\"`\n}\nfunc send(cfg Config) {\n\treq := messagesRequest{Model: cfg.Model, MaxTokens: 1024}\n\treq.Temperature = cfg.Temperature\n\tb, _ := json.Marshal(req)\n\thttp.Post(\"https://api.anthropic.com/v1/messages\", \"application/json\", bytes.NewReader(b))\n}\n",
  "op.php": "<?php\n$client = OpenAI::client(getenv('KEY'));\n$r = $client->chat()->create(['model' => 'gpt-4o', 'temperature' => 0.2, 'messages' => []]);\n$a = $client->assistants()->list(['limit' => 10]);\n$t = OpenAI::threads()->runs()->create('thread_1', ['assistant_id' => 'asst_1']);\n",
  "ra.rb": "require \"anthropic\"\nclient = Anthropic::Client.new(access_token: ENV[\"KEY\"])\nclient.messages(parameters: { model: \"claude-sonnet-4-5\", max_tokens: 100, temperature: 0.2, messages: [] })\n",
  "ro.rb": "require \"openai\"\nclient = OpenAI::Client.new(access_token: ENV[\"OPENAI_KEY\"])\nresp = client.chat(\n  parameters: {\n    model: \"gpt-4o\",\n    messages: [{ role: \"user\", content: \"hi\" }],\n    temperature: 0.7,\n  }\n)\nclient.assistants.list\nclient.runs.create(thread_id: tid, parameters: { assistant_id: aid })\n"
};
const EXPECT: Record<string, string[]> = {
  "ro.rb": [
    "7:openai:POST /v1/chat/completions:temperature",
    "10:openai:* /v1/assistants:",
    "11:openai:* /v1/threads:assistant_id"
  ],
  "ra.rb": [
    "3:anthropic:POST /v1/messages:temperature"
  ],
  "op.php": [
    "3:openai:POST /v1/chat/completions:temperature",
    "4:openai:* /v1/assistants:limit",
    "5:openai:* /v1/threads:assistant_id"
  ],
  "an.php": [
    "4:anthropic:POST /v1/messages:temperature"
  ],
  "Oa.cs": [
    "5:openai:POST /v1/chat/completions:temperature",
    "5:openai:POST /v1/chat/completions:top_p",
    "8:openai:* /v1/assistants:"
  ],
  "As.cs": [
    "4:anthropic:POST /v1/messages:temperature"
  ],
  "Me.cs": [
    "5:anthropic:POST /v1/messages:temperature",
    "5:anthropic:POST /v1/messages:top_k"
  ],
  "Sp.java": [
    "3:anthropic:POST /v1/messages:temperature",
    "3:anthropic:POST /v1/messages:top_p"
  ],
  "application.properties": [
    "3:anthropic:POST /v1/messages:temperature"
  ],
  "go1.go": [
    "6:openai:POST /v1/chat/completions:temperature",
    "8:openai:* /v1/assistants:"
  ],
  "go2.go": [
    "10:anthropic:POST /v1/messages:temperature"
  ]
};

describe("SDK calls in Ruby, PHP, C#, Java and Go", () => {
  it("each documented call and request object is read with its operation and settings", async () => {
    const d = await mkdtemp(join(tmpdir(), "vitasta-sdk5-"));
    for (const [p, t] of Object.entries(FILES)) {
      await mkdir(dirname(join(d, p)), { recursive: true });
      await writeFile(join(d, p), t);
    }
    const us = (await scanRepo(d)).usages;
    for (const [f, want] of Object.entries(EXPECT)) {
      const got = us.filter((u: any) => u.file === f && u.op).map((u: any) => `${u.line}:${u.provider}:${u.op}:${u.params?.[0] ?? ""}`);
      for (const w of want) expect([f, got.includes(w)]).toEqual([f, true]);
    }
  });
});
