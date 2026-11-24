import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { canBlock } from "../src/check.js";
import { scanRepo } from "./helpers/legacy-scan.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 15's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s15r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

describe("clients pointed at another server", () => {
  const files = {
    "requirements.txt": "openai>=1.0\n",
    "app/clients.py": 'from openai import OpenAI\n\n\nclass App:\n    def __init__(self):\n        self.client = OpenAI(base_url="https://api.agentic.local/v1", api_key="x")\n\n\napp = App()\ndirect = OpenAI()\n',
    "app/agents.py": 'from .clients import app, direct\n\n\ndef make():\n    return app.client.beta.assistants.create(name="t", model="gpt-4o")\n\n\ndef real():\n    return direct.beta.assistants.create(name="t", model="gpt-4o")\n',
    "app/local.py": 'from openai import OpenAI\n\ngw = OpenAI(base_url="http://localhost:8080/v1")\nr = gw.beta.assistants.list()\n',
  };
  it("Python: a client built elsewhere with a gateway base_url, and a localhost one, are proxied and never fail a check", async () => {
    const us = await usages(files);
    const at = (f: string, l: number) => us.find((u) => u.file === f && u.line === l && /assistants/.test(u.op ?? ""));
    expect(at("app/agents.py", 5)?.proxy).toBe("api.agentic.local");
    expect(at("app/local.py", 4)?.proxy).toBe("localhost:8080");
    expect(canBlock({ usage: at("app/agents.py", 5), change: {}, status: "broken" } as any)).toBe(false);
    // a client built with no base URL is the provider's
    expect(at("app/agents.py", 9)?.proxy).toBeUndefined();
  });
  it("a client name also built without a base URL somewhere isn't treated as proxied", async () => {
    const us = await usages({ ...files, "app/other.py": "from openai import OpenAI\n\nclass Other:\n    def __init__(self):\n        self.client = OpenAI()\n" });
    expect(us.find((u) => u.file === "app/agents.py" && u.line === 5 && /assistants/.test(u.op ?? ""))?.proxy).toBeUndefined();
  });
  it("JS: a localhost baseURL is another server", async () => {
    const us = await usages({ "package.json": '{"dependencies":{"openai":"^4.0.0"}}\n', "a.ts": 'import OpenAI from "openai";\nconst c = new OpenAI({ baseURL: "http://127.0.0.1:4000/v1" });\nawait c.beta.assistants.list();\n' });
    expect(us.find((u) => u.file === "a.ts" && /assistants/.test(u.op ?? ""))?.proxy).toBe("127.0.0.1:4000");
  });
});

describe("settings passed in an options array", () => {
  it("PHP: $options['temperature'] in a provider class traces to the caller's ['temperature' => $t]", async () => {
    const us = await usages({
      "app/Ctl.php": "<?php\nclass Ctl\n{\n    public function __construct(private AnthropicProvider $p) {}\n    public function send(array $body)\n    {\n        $temperature = $body['temperature'] ?? 0.7;\n        return $this->p->chat([], ['temperature' => $temperature]);\n    }\n}\n",
      "app/AnthropicProvider.php": "<?php\nclass AnthropicProvider\n{\n    public function chat(array $messages, array $options = []): array\n    {\n        $payload = [\n            'model' => 'claude-sonnet-4-5',\n            'temperature' => $options['temperature'] ?? 1.0,\n            'messages' => $messages,\n        ];\n        $ch = curl_init('https://api.anthropic.com/v1/messages');\n        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));\n        return json_decode(curl_exec($ch), true);\n    }\n}\n",
    });
    const lines = us.filter((u) => u.file === "app/Ctl.php" && u.params?.includes("temperature") && u.op === "POST /v1/messages").map((u) => u.line);
    expect(lines).toContain(7);
  });
});

describe("model defaults in getters and switches", () => {
  const api = { "Api.java": 'import java.net.URI;\nimport java.net.http.HttpRequest;\nclass Api {\n    void send() { HttpRequest.newBuilder(URI.create("https://api.openai.com/v1/chat/completions")).POST(null).build(); }\n}\n' };
  it("Java: a preference getter's default under a model key, and a model-named method's switch returns", async () => {
    const us = await usages({
      ...api,
      "Settings.java": 'class Settings {\n    private static final String KEY_MODEL = "model";\n    String getModel() {\n        return prefs.getString(KEY_MODEL, "gpt-3.5-turbo");\n    }\n    String getDefaultModel(String p) {\n        switch (p) {\n            case "anthropic":\n                return "claude-3-5-haiku-20241022";\n            default:\n                return "gpt-4o-mini";\n        }\n    }\n    String pick(String p) {\n        return p.equals("a") ? "gpt-4o" : "gpt-4o-mini";\n    }\n}\n',
    });
    const lines = us.filter((u) => u.file === "Settings.java" && u.model).map((u) => u.line).sort((a, b) => a - b);
    expect(lines).toEqual([4, 9, 11]);
  });
  it("PHP: a model-named function's match arms; a match elsewhere and a map key don't count", async () => {
    const us = await usages({
      "Client.php": "<?php\nclass Client {\n    public function send() { $ch = curl_init('https://api.anthropic.com/v1/messages'); curl_exec($ch); }\n}\n",
      "Models.php": "<?php\nclass Models\n{\n    public static function defaultModel(string $p): string\n    {\n        return match ($p) {\n            'anthropic' => 'claude-sonnet-4-20250514',\n            default => 'gpt-4o',\n        };\n    }\n    public static function label(string $p): string\n    {\n        return match ($p) {\n            'a' => 'claude-sonnet-4-20250514',\n        };\n    }\n}\n",
    });
    expect(us.filter((u) => u.file === "Models.php" && u.model).map((u) => u.line).sort((a, b) => a - b)).toEqual([7, 8]);
  });
});

describe("a base URL built from the app's settings plus a version path", () => {
  it("is a configured gateway: proxied where the client is used, in another module or the same file", async () => {
    const us = await usages({
      "requirements.txt": "openai>=1.0\n",
      "app/core.py": "from openai import OpenAI\n\n\nclass App:\n    def __init__(self, config):\n        self.config = config\n        self.client = OpenAI(base_url=f\"{self.config['gateway_url']}/v1\", api_key=\"x\")\n",
      "app/agents.py": 'def make(app):\n    return app.client.beta.assistants.create(name="t", model="gpt-4o")\n',
      "app/local.py": 'from openai import OpenAI\n\n\ndef local(settings):\n    gw = OpenAI(base_url=settings.GATEWAY + "/v1")\n    return gw.beta.assistants.list()\n',
    });
    const at = (f: string, l: number) => us.find((u) => u.file === f && u.line === l && /assistants/.test(u.op ?? ""));
    expect(at("app/agents.py", 2)?.proxy).toBe("configured gateway_url");
    expect(at("app/local.py", 6)?.proxy).toBe("configured GATEWAY");
  });
  it("a provider host in the value, or a plain env value with no path added, isn't", async () => {
    const us = await usages({
      "requirements.txt": "openai>=1.0\n",
      "a.py": 'import os\nfrom openai import OpenAI\n\nc = OpenAI(base_url=f"https://api.openai.com/{os.environ[\'V\']}")\nc.beta.assistants.list()\nd = OpenAI(base_url=os.getenv("OPENAI_BASE_URL"))\nd.beta.assistants.list()\n',
    });
    expect(us.filter((u) => u.file === "a.py" && /assistants/.test(u.op ?? "") && u.proxy)).toEqual([]);
  });
});

describe("Claude through a gateway, PHP and Go", () => {
  const goFile = (model: string) => `package llm\n\nimport (\n\t"bytes"\n\t"encoding/json"\n\t"net/http"\n)\n\nconst defaultTemperature = 1.0\nconst defaultModel = "${model}"\n\nfunc Ask(p string) (*http.Response, error) {\n\tbody, _ := json.Marshal(map[string]any{\n\t\t"model":       defaultModel,\n\t\t"temperature": defaultTemperature,\n\t})\n\treturn http.Post("https://openrouter.ai/api/v1/chat/completions", "application/json", bytes.NewReader(body))\n}\n`;
  it("Go: a map body with a Claude model constant, the temperature constant's line included", async () => {
    const us = await usages({ "go.mod": "module x\n", "llm/or.go": goFile("anthropic/claude-3-5-sonnet") });
    const f = us.find((u) => u.provider === "anthropic" && u.op === "POST /v1/messages" && u.params?.includes("temperature"));
    expect(f?.line).toBe(15);
    expect(f?.alsoLines).toContain(9);
  });
  it("Go: a non-Claude model through the gateway stays the gateway's", async () => {
    const us = await usages({ "go.mod": "module x\n", "llm/or.go": goFile("openai/gpt-4o") });
    expect(us.filter((u) => u.provider === "anthropic" && u.params?.includes("temperature"))).toEqual([]);
  });
  it("PHP: an OpenRouter body whose model is a settings class constant holding a Claude id", async () => {
    const us = await usages({
      "app/Settings.php": "<?php\nclass Settings\n{\n    public const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';\n}\n",
      "app/Or.php": "<?php\nclass Or_\n{\n    public function chat(array $messages, array $options = []): array\n    {\n        $payload = ['model' => Settings::DEFAULT_MODEL, 'temperature' => $options['temperature'] ?? 0.7, 'messages' => $messages];\n        $ch = curl_init('https://openrouter.ai/api/v1/chat/completions');\n        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));\n        return json_decode(curl_exec($ch), true);\n    }\n}\n",
    });
    const f = us.find((u) => u.provider === "anthropic" && u.file === "app/Or.php" && u.params?.includes("temperature"));
    expect(f?.reason).toMatch(/Settings::DEFAULT_MODEL is anthropic\/claude-sonnet-4/);
  });
});

describe("URLs held in constants and configured bases", () => {
  it("Java: a request whose URL is a class constant lists the constant's line", async () => {
    const us = await usages({ "AssistantClient.java": "package com.x;\n\nimport java.net.URI;\nimport java.net.http.HttpClient;\nimport java.net.http.HttpRequest;\nimport java.net.http.HttpResponse;\n\npublic class AssistantClient {\n    private static final String THREADS_URL = \"https://api.openai.com/v1/threads\";\n    private static final String RUNS_SUFFIX = \"/runs\";\n    private final HttpClient http = HttpClient.newHttpClient();\n\n    public String createThread(String key) throws Exception {\n        HttpRequest req = HttpRequest.newBuilder()\n                .uri(URI.create(THREADS_URL))\n                .header(\"Authorization\", \"Bearer \" + key)\n                .header(\"OpenAI-Beta\", \"assistants=v2\")\n                .POST(HttpRequest.BodyPublishers.ofString(\"{}\"))\n                .build();\n        return http.send(req, HttpResponse.BodyHandlers.ofString()).body();\n    }\n\n    public String run(String key, String threadId) throws Exception {\n        HttpRequest req = HttpRequest.newBuilder()\n                .uri(URI.create(THREADS_URL + \"/\" + threadId + RUNS_SUFFIX))\n                .POST(HttpRequest.BodyPublishers.ofString(\"{}\"))\n                .build();\n        return http.send(req, HttpResponse.BodyHandlers.ofString()).body();\n    }\n}\n" });
    const f = us.find((u) => u.file === "AssistantClient.java" && u.op === "POST /v1/threads");
    expect([f?.line, ...(f?.alsoLines ?? [])]).toContain(9);
  });
  it("Go: a Terraform provider's APIURL default, a joined path, and a marshalled Prompt field", async () => {
    const us = await usages({ "go.mod": "module example.com/tf\n", "internal/provider/provider.go": "package provider\n\nimport \"github.com/hashicorp/terraform-plugin-sdk/v2/helper/schema\"\n\ntype Client struct {\n\tAPIURL string\n\tAPIKey string\n}\n\nfunc Provider() *schema.Provider {\n\treturn &schema.Provider{\n\t\tSchema: map[string]*schema.Schema{\n\t\t\t\"api_url\": {Type: schema.TypeString, Optional: true, Default: \"https://api.openai.com/v1\"},\n\t\t},\n\t}\n}\n", "internal/provider/resource_translation.go": "package provider\n\nimport (\n\t\"bytes\"\n\t\"mime/multipart\"\n\t\"net/http\"\n)\n\nfunc resourceTranslationCreate(c *Client, file []byte) error {\n\tvar buf bytes.Buffer\n\tw := multipart.NewWriter(&buf)\n\tw.WriteField(\"model\", \"whisper-1\")\n\tw.Close()\n\treq, _ := http.NewRequest(\"POST\", c.APIURL+\"/audio/translations\", &buf)\n\treq.Header.Set(\"Content-Type\", w.FormDataContentType())\n\t_, err := http.DefaultClient.Do(req)\n\treturn err\n}\n", "internal/provider/resource_response.go": "package provider\n\nimport (\n\t\"bytes\"\n\t\"encoding/json\"\n\t\"net/http\"\n)\n\ntype PromptConfig struct {\n\tID      string `json:\"id\"`\n\tVersion string `json:\"version,omitempty\"`\n}\n\ntype ResponseRequest struct {\n\tModel  string        `json:\"model\"`\n\tInput  string        `json:\"input\"`\n\tPrompt *PromptConfig `json:\"prompt,omitempty\"`\n}\n\nfunc resourceResponseCreate(c *Client, promptID string) error {\n\tapiReqData := ResponseRequest{Model: \"gpt-4.1\", Input: \"hi\"}\n\tif promptID != \"\" {\n\t\tapiReqData.Prompt = &PromptConfig{ID: promptID}\n\t}\n\tbody, _ := json.Marshal(apiReqData)\n\treq, _ := http.NewRequest(\"POST\", c.APIURL+\"/responses\", bytes.NewReader(body))\n\t_, err := http.DefaultClient.Do(req)\n\treturn err\n}\n" });
    expect(us.some((u) => u.file === "internal/provider/resource_translation.go" && u.line === 14 && /audio\/translations/.test(u.op ?? ""))).toBe(true);
    //
    expect(us.some((u) => u.file === "internal/provider/resource_response.go" && u.line === 23 && u.op === "POST /v1/responses" && u.params?.includes("prompt") && u.alsoLines?.includes(17))).toBe(true);
    expect(us.some((u) => u.file === "internal/provider/resource_response.go" && u.line === 23 && u.params?.includes("prompt"))).toBe(true);
  });
  it("Go: a joined path where the package sets no provider base isn't an operation", async () => {
    const us = await usages({ "go.mod": "module x\n", "svc/a.go": "package svc\n\nimport \"net/http\"\n\ntype C struct {\n\tAPIURL string\n}\n\nfunc (c *C) T() {\n\thttp.NewRequest(\"POST\", c.APIURL+\"/audio/translations\", nil)\n}\n" });
    expect(us.filter((u) => /audio\/translations/.test(u.op ?? ""))).toEqual([]);
  });
});
