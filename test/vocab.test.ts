import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { callShapeUsages } from "../src/scan/vocab.js";
import { rubyClientUsages } from "../src/scan/rbclients.js";
import { phpClientUsages } from "../src/scan/phpclients.js";

// Layer 1 (23 Nov design): request fields on SDK params / options types, from the generated vocabulary
// (src/data/sdk-vocab), wherever the client is built
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-vocab-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const sampling = async (files: Record<string, string>) =>
  ((await scanRepo(await repo(files))).usages as any[]).filter((u) => u.params?.some((p: string) => ["temperature", "top_p", "top_k"].includes(p)));

describe("C#: params types from NuGet SDK metadata", () => {
  it("Anthropic.SDK MessageParameters: a property assigned later, with the local's default line", async () => {
    const cs = `using Anthropic.SDK.Messaging;\nnamespace App;\npublic class Chat\n{\n    private MessageParameters Prepare(decimal t0)\n    {\n        var parameters = new MessageParameters();\n        var temperature = Load("temperature", 0.0m);\n        parameters.Model = "claude-sonnet-4-5";\n        parameters.Temperature = temperature;\n        return parameters;\n    }\n}\n`;
    const us = await sampling({ "src/Chat.cs": cs });
    // both the assignment (10) and the local's default (8) are covered, by this rule or the param trace
    const t = us.filter((u) => u.file === "src/Chat.cs" && u.params.includes("temperature"));
    const lines = t.flatMap((u) => [u.line, ...(u.alsoLines ?? [])]);
    expect(lines).toEqual(expect.arrayContaining([8, 10]));
    expect(t.every((u) => u.provider === "anthropic" && u.op === "POST /v1/messages")).toBe(true);
  });
  it("global usings elsewhere in the repo resolve the type", async () => {
    const us = await sampling({
      "src/Using.cs": "global using Anthropic.SDK.Messaging;\n",
      "src/Chat.cs": "namespace App;\npublic class Chat\n{\n    public object P() => new MessageParameters { Model = \"claude-x\", TopP = 0.9m };\n}\n",
    });
    expect(us.find((u) => u.file === "src/Chat.cs")?.params).toEqual(["top_p"]);
  });
  it("OpenAI .NET ChatCompletionOptions initializer (wire names from its serializer)", async () => {
    const cs = "using OpenAI.Chat;\nclass A\n{\n    ChatCompletionOptions O() => new ChatCompletionOptions\n    {\n        Temperature = 0.2f,\n        MaxOutputTokenCount = 100,\n    };\n}\n";
    const us = await sampling({ "src/A.cs": cs });
    expect(us.find((u) => u.file === "src/A.cs")).toMatchObject({ provider: "openai", op: "POST /v1/chat/completions", line: 6, params: ["temperature"] });
  });
  it("a type name no using resolves isn't reported", async () => {
    const cs = "namespace App;\nclass MessageParameters { public decimal Temperature { get; set; } }\nclass B { void M() { var p = new MessageParameters(); p.Temperature = 1; } }\n";
    expect(await sampling({ "src/B.cs": cs })).toEqual([]);
  });
});

describe("Go: params structs from module-proxy source", () => {
  it("openai-go ChatCompletionNewParams literal", async () => {
    const go = `package ai\n\nimport (\n\t"github.com/openai/openai-go/v3"\n)\n\nfunc params() openai.ChatCompletionNewParams {\n\treturn openai.ChatCompletionNewParams{\n\t\tModel:       "gpt-4o",\n\t\tTemperature: openai.Float(0.3),\n\t}\n}\n`;
    const us = await sampling({ "go.mod": "module x\n", "ai/p.go": go });
    expect(us.find((u) => u.file === "ai/p.go")).toMatchObject({ provider: "openai", op: "POST /v1/chat/completions", line: 10, params: ["temperature"] });
  });
  it("anthropic-sdk-go MessageNewParams: a field assigned on a variable", async () => {
    const go = `package ai\n\nimport "github.com/anthropics/anthropic-sdk-go"\n\nfunc build(t float64) anthropic.MessageNewParams {\n\tp := anthropic.MessageNewParams{MaxTokens: 100}\n\tp.TopK = anthropic.Int(5)\n\treturn p\n}\n`;
    const us = await sampling({ "go.mod": "module x\n", "ai/b.go": go });
    expect(us.find((u) => u.file === "ai/b.go")).toMatchObject({ provider: "anthropic", op: "POST /v1/messages", line: 7, params: ["top_k"] });
  });
});

describe("Java: params builders from Maven -sources.jar", () => {
  it("anthropic-java MessageCreateParams.builder() chain", async () => {
    const java = `package app;\n\nimport com.anthropic.models.messages.MessageCreateParams;\n\nclass Ask {\n    MessageCreateParams p() {\n        return MessageCreateParams.builder()\n            .model("claude-sonnet-4-5")\n            .maxTokens(1024)\n            .temperature(0.2)\n            .build();\n    }\n}\n`;
    const us = await sampling({ "src/main/java/app/Ask.java": java });
    expect(us.find((u) => u.file.endsWith("Ask.java"))).toMatchObject({ provider: "anthropic", op: "POST /v1/messages", line: 10, params: ["temperature"] });
  });
  it("openai-java ChatCompletionCreateParams through a wildcard import", async () => {
    const java = `package app;\nimport com.openai.models.chat.completions.*;\nclass C {\n    Object p() { return ChatCompletionCreateParams.builder().model("gpt-4o").topP(0.9).build(); }\n}\n`;
    const us = await sampling({ "src/C.java": java });
    expect(us.find((u) => u.file === "src/C.java")).toMatchObject({ provider: "openai", op: "POST /v1/chat/completions", line: 4, params: ["top_p"] });
  });
});

describe("layer 4: call shapes from the vocabulary where the receiver isn't known", () => {
  const run = (rel: string, lang: string, source: string) => callShapeUsages([{ rel, lang, source }] as any, []).map((u) => [u.line, u.op, u.sdkCall, u.confidence, u.provider]);
  it("C#, Java and Go chains, possible, only with the SDK imported", () => {
    expect(run("X.cs", "cs", "using Anthropic.SDK;\nclass X { async Task A(object c, object p) { await c.Messages.GetClaudeMessageAsync(p); } }\n")).toEqual([[2, "POST /v1/messages", "Messages.GetClaudeMessageAsync", "possible", "anthropic"]]);
    expect(run("Y.java", "java", "package a;\nimport com.anthropic.client.AnthropicClient;\nclass Y { void a(Object client) { client.messages().create(p); } }\n")).toEqual([[3, "POST /v1/messages", "messages().create", "possible", "anthropic"]]);
    expect(run("a.go", "go", 'package a\nimport "github.com/openai/openai-go/v3"\nfunc a(c openai.Client) { c.Chat.Completions.New(ctx, p) }\n')).toEqual([[3, "POST /v1/chat/completions", "Chat.Completions.New", "possible", "openai"]]);
    expect(run("Z.cs", "cs", "class Z { void a() { x.Messages.GetClaudeMessageAsync(p); } }\n")).toEqual([]);
  });
});

describe("layer 2, Ruby: clients built in another method, class, mixin or initializer", () => {
  const run = (files: Record<string, string>) =>
    rubyClientUsages(Object.entries(files).map(([rel, source]) => ({ rel, lang: "rb", source })) as any, []).map((u) => [u.file, u.line, u.op, u.params?.[0] ?? null]);
  it("a memoized client in an included module, used in another file", () => {
    const r = run({
      "app/models/concerns/llm.rb": "module Llm\n  def client\n    @client ||= Anthropic::Client.new(api_key: ENV['K'])\n  end\nend\n",
      "app/services/s.rb": "class S\n  include Llm\n  def go(t)\n    client.messages.create(\n      model: 'claude-x',\n      top_k: 5,\n    )\n  end\nend\n",
    });
    expect(r).toEqual(expect.arrayContaining([["app/services/s.rb", 4, "POST /v1/messages", null], ["app/services/s.rb", 6, "POST /v1/messages", "top_k"]]));
  });
  it("a constant from an initializer (ruby-openai), parameters hash keys, and a resource call", () => {
    const r = run({
      "config/initializers/openai.rb": "OPENAI = OpenAI::Client.new(access_token: ENV['T'])\n",
      "app/h.rb": "class H\n  def go\n    OPENAI.chat(parameters: { model: 'gpt-4o', temperature: 0.2 })\n    OPENAI.assistants.list\n  end\nend\n",
    });
    expect(r).toEqual(expect.arrayContaining([["app/h.rb", 3, "POST /v1/chat/completions", "temperature"], ["app/h.rb", 4, "GET /v1/assistants", null]]));
  });
  it("a parent class's client", () => {
    const r = run({
      "app/base.rb": "class Base\n  def initialize\n    @llm = OpenAI::Client.new\n  end\nend\n",
      "app/child.rb": "class Child < Base\n  def go\n    @llm.chat.completions.create(model: 'gpt-4o', top_p: 0.5)\n  end\nend\n",
    });
    expect(r).toEqual(expect.arrayContaining([["app/child.rb", 3, "POST /v1/chat/completions", "top_p"]]));
  });
  it("a name that holds no client isn't followed", () => {
    expect(run({ "a.rb": "class A\n  def go\n    client.messages.create(model: 'x')\n  end\nend\n" })).toEqual([]);
  });
});

describe("layer 2, PHP: clients from makers, typed constructor parameters and facades", () => {
  const run = (files: Record<string, string>) =>
    phpClientUsages(Object.entries(files).map(([rel, source]) => ({ rel, lang: "php", source })) as any, []).map((u) => [u.file, u.line, u.op, u.params?.[0] ?? null]);
  it("a client made in the constructor (OpenAI::client), array keys as wire names", () => {
    const php = "<?php\nnamespace App;\nuse OpenAI;\nclass Ai\n{\n    public function __construct()\n    {\n        $this->client = OpenAI::client('k');\n    }\n    public function ask()\n    {\n        return $this->client->chat()->create([\n            'model' => 'gpt-4o',\n            'temperature' => 0.2,\n        ]);\n    }\n}\n";
    expect(run({ "app/Ai.php": php })).toEqual(expect.arrayContaining([["app/Ai.php", 12, "POST /v1/chat/completions", null], ["app/Ai.php", 14, "POST /v1/chat/completions", "temperature"]]));
  });
  it("a promoted typed parameter (Anthropic\\Client), named arguments through the params type", () => {
    const php = "<?php\nnamespace App;\nuse Anthropic\\Client;\nclass C\n{\n    public function __construct(private Client $anthropic) {}\n    public function go()\n    {\n        return $this->anthropic->messages->create(maxTokens: 100, topK: 5, messages: [], model: 'x');\n    }\n}\n";
    expect(run({ "app/C.php": php })).toEqual(expect.arrayContaining([["app/C.php", 9, "POST /v1/messages", "top_k"], ["app/C.php", 9, "POST /v1/messages", "max_tokens"]]));
  });
  it("the Laravel facade, and a parent class's client", () => {
    const facade = "<?php\nnamespace App;\nuse OpenAI\\Laravel\\Facades\\OpenAI;\nclass F\n{\n    public function run() { OpenAI::assistants()->list(['limit' => 10]); }\n}\n";
    const base = "<?php\nnamespace App;\nuse OpenAI;\nclass Base\n{\n    protected function llm(): \\OpenAI\\Client { return OpenAI::client('k'); }\n}\n";
    const child = "<?php\nnamespace App;\nclass Child extends Base\n{\n    public function go() { return $this->llm()->chat()->create(['top_p' => 0.5]); }\n}\n";
    const r = run({ "app/F.php": facade, "app/Base.php": base, "app/Child.php": child });
    expect(r).toEqual(expect.arrayContaining([["app/F.php", 6, "GET /v1/assistants", null], ["app/Child.php", 5, "POST /v1/chat/completions", "top_p"]]));
  });
});

