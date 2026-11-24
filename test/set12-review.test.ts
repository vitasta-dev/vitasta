import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 12's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s12r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

const provider = (cls: string, url: string) => `<?php
namespace App\\Providers;

class ${cls}
{
    public function generate(string $model, string $prompt): array
    {
        $body = $this->buildBody($model, $prompt);
        return $this->post('${url}', $body);
    }

    private function buildBody($model, $prompt, $temperature = 0.7): array
    {
        return ['model' => $model, 'max_tokens' => 512, 'temperature' => $temperature, 'messages' => []];
    }
}
`;

describe("precision: the same method name in each provider's class", () => {
  it("only the Anthropic class's own default is Anthropic's", async () => {
    const us = await usages({
      "src/AnthropicAi.php": provider("AnthropicAi", "https://api.anthropic.com/v1/messages"),
      "src/OpenAi.php": provider("OpenAi", "https://api.openai.com/v1/chat/completions"),
      "src/XAi.php": provider("XAi", "https://api.x.ai/v1/chat/completions"),
    });
    const files = [...new Set(us.filter((u) => u.provider === "anthropic" && u.params?.includes("temperature")).map((u) => u.file))];
    expect(files).toEqual(["src/AnthropicAi.php"]);
  });
});

describe("model defaults", () => {
  it("C# fallbacks and a property default; Java provider-named factories", async () => {
    const us = await usages({
      "cs/Chat.cs": 'public class Chat\n{\n    public string Model { get; set; } = "gpt-4o-mini";\n    public string Pick(string model) => model ?? "gpt-4o-mini";\n}\n',
      "src/main/java/a/Generators.java": 'package a;\npublic final class Generators {\n    public static AnthropicGenerator sonnet() {\n        return new AnthropicGenerator("claude-3-5-sonnet-20241022", 4096);\n    }\n}\n',
    });
    const at = us.filter((u) => u.model).map((u) => `${u.file.split("/").pop()}:${u.line}`);
    expect(at).toEqual(expect.arrayContaining(["Chat.cs:3", "Chat.cs:4", "Generators.java:4"]));
  });
});

describe("Feign client interfaces", () => {
  it("@RequestLine(\"POST /assistants\") on a base URL with /v1", async () => {
    const us = await usages({
      "src/main/java/c/Api.java": 'package c;\nimport feign.RequestLine;\npublic interface Api {\n    @RequestLine("POST /assistants")\n    Object create(Object r);\n    @RequestLine("POST /audio/translations")\n    Object tr(Object f);\n}\n',
      "src/main/java/c/Builder.java": 'package c;\npublic class Builder { private String baseUrl = "https://api.openai.com/v1/"; }\n',
    });
    const ops = us.filter((u) => u.provider === "openai").map((u) => `${u.line} ${u.op}`);
    expect(ops).toContain("4 POST /v1/assistants");
    expect(ops).toContain("6 POST /v1/audio/translations");
  });
});

describe("a config literal that sets a Claude model and a sampling setting", () => {
  it("each sampling key next to the Claude model; not next to another provider's", async () => {
    const us = await usages({ "app/models.py": 'MODELS = {\n    "a": {"model": "claude-sonnet-4-5", "temperature": 0.2},\n    "b": {"model": "gpt-4o", "temperature": 0.9},\n}\n' });
    const at = us.filter((u) => u.provider === "anthropic" && u.params?.includes("temperature")).map((u) => u.line);
    expect(at).toEqual([2]);
  });
});

describe("where the PHP provider-class finding lands", () => {
  it("the default's line, with the body line that sends it, both in the one finding's lines", async () => {
    const pad = Array.from({ length: 20 }, (_, i) => `            'opt${i}' => $this->o${i},`).join("\n");
    const src = `<?php\nnamespace App;\n\nclass AnthropicAi\n{\n    public function generate($m, $p): array\n    {\n        $body = $this->buildBody($m, $p);\n        return $this->client->post('https://api.anthropic.com/v1/messages', ['json' => $body]);\n    }\n\n    private function buildBody($m, $p, $temperature = 0.7): array\n    {\n        $body = [\n            'model' => $m,\n${pad}\n        ];\n        $body['temperature'] = $temperature;\n        return $body;\n    }\n}\n`;
    const us = await usages({ "src/AnthropicAi.php": src });
    const lines = us.filter((u) => u.provider === "anthropic" && u.params?.includes("temperature")).flatMap((u) => [u.line, ...(u.alsoLines ?? [])]);
    const bodyLine = src.split("\n").findIndex((l) => l.includes("$body['temperature']")) + 1;
    expect(lines).toContain(12);
    expect(lines).toContain(bodyLine);
  });
});
