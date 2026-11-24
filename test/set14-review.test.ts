import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { canBlock } from "../src/check.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 14's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s14r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];
const at = (us: any[], file: string, op: RegExp, param?: string) =>
  us.filter((u) => u.file === file && op.test(u.op ?? "") && (!param || u.params?.includes(param))).map((u) => u.line).sort((a, b) => a - b);

const GW_PROXY = [
  "package proxy",
  "",
  'import "github.com/gin-gonic/gin"',
  "",
  'const openAIUpstream = "https://api.openai.com/v1"',
  "",
  "func Register(r *gin.Engine) {",
  '\tr.Any("/v1/assistants", openAIFamilyProxy("/assistants"))',
  '\tr.Any("/v1/assistants/:id/*rest", func(c *gin.Context) { forward(c, "/assistants/"+c.Param("id")+c.Param("rest")) })',
  '\tr.POST("/v1/evals", openAIFamilyProxy("/evals"))',
  "}",
  "",
  "func openAIFamilyProxy(path string) gin.HandlerFunc {",
  "\treturn func(c *gin.Context) { forward(c, path) }",
  "}",
  "",
  "func forward(c *gin.Context, path string) {",
  "\treq, _ := http.NewRequest(c.Request.Method, openAIUpstream+path, c.Request.Body)",
  "\thttp.DefaultClient.Do(req)",
  "}",
  "",
].join("\n");

describe("gateways", () => {
  it("Go: routes and paths in a forwarding package are the upstream's operations", async () => {
    const us = await usages({ "proxy/openai.go": GW_PROXY });
    expect(at(us, "proxy/openai.go", /assistants/)).toContain(8);
    expect(at(us, "proxy/openai.go", /evals/)).toContain(10);
  });
  it("Go: the struct a converter returns, in another package, is the body sent to a versioned path", async () => {
    const us = await usages({
      "go.mod": "module example.com/gw\n",
      "relay/claude.go": [
        "package relay",
        "",
        'import (\n\t"bytes"\n\t"encoding/json"\n\t"net/http"\n\n\t"example.com/gw/relay/dto"\n)',
        "",
        "func ConvertToClaude(req *dto.OpenAIRequest) *dto.ClaudeRequest {",
        "\treturn &dto.ClaudeRequest{Model: req.Model, Temperature: req.Temperature}",
        "}",
        "",
        "func SendClaude(base string, req *dto.OpenAIRequest) (*http.Response, error) {",
        "\tbody, _ := json.Marshal(ConvertToClaude(req))",
        '\tr, _ := http.NewRequest("POST", base+"/v1/messages", bytes.NewReader(body))',
        '\tr.Header.Set("anthropic-version", "2023-06-01")',
        "\treturn http.DefaultClient.Do(r)",
        "}",
        "",
      ].join("\n"),
      "relay/dto/claude.go": "package dto\n\ntype ClaudeRequest struct {\n\tModel       string   `json:\"model\"`\n\tTemperature *float64 `json:\"temperature,omitempty\"`\n\tTopP        *float64 `json:\"top_p,omitempty\"`\n}\n\ntype OpenAIRequest struct {\n\tModel       string   `json:\"model\"`\n\tTemperature *float64 `json:\"temperature,omitempty\"`\n}\n",
    });
    expect(at(us, "relay/dto/claude.go", /^POST \/v1\/messages$/, "temperature")).toEqual([5]);
    expect(at(us, "relay/dto/claude.go", /^POST \/v1\/messages$/, "top_p")).toEqual([6]);
    // the OpenAI-side struct isn't what's sent to Claude
    expect(at(us, "relay/dto/claude.go", /^POST \/v1\/messages$/).filter((l) => l > 7)).toEqual([]);
  });
  it("a path in a package that doesn't forward isn't a route", async () => {
    const us = await usages({ "web/routes.go": 'package web\n\nfunc Register(r *gin.Engine) {\n\tr.GET("/assistants", list)\n}\n' });
    expect(us.filter((u) => u.provider === "openai")).toEqual([]);
  });
});

describe("PHP", () => {
  const api = "<?php\nfunction get_api_base_url() {\n    return get_option('ai_api_base', 'https://api.openai.com/v1');\n}\n\nfunction get_threads_api_url() {\n    return get_api_base_url() . '/threads';\n}\n\nfunction get_responses_api_url() {\n    return get_api_base_url() . '/responses';\n}\n";
  it("a path joined to a base the folder sets is that operation", async () => {
    const us = await usages({ "includes/api.php": api });
    expect(at(us, "includes/api.php", /threads/)).toEqual([7]);
  });
  it("a hand-built Responses prompt object is the prompt parameter", async () => {
    const us = await usages({
      "includes/api.php": api,
      "includes/chat.php": "<?php\nfunction respond($key, $prompt_id) {\n    $payload = ['model' => 'gpt-4.1'];\n    $payload['prompt'] = ['id' => $prompt_id];\n    return wp_remote_post(get_responses_api_url(), ['body' => wp_json_encode($payload)]);\n}\n",
    });
    expect(at(us, "includes/chat.php", /^POST \/v1\/responses$/, "prompt")).toEqual([4]);
  });
  it("a prompt string isn't a prompt object", async () => {
    const us = await usages({ "a.php": "<?php\n$payload = ['prompt' => 'hello'];\nwp_remote_post('https://api.openai.com/v1/responses', ['body' => $payload]);\n" });
    expect(us.filter((u) => u.reason?.includes("prompt object"))).toEqual([]);
  });
  it("the array a curl POST sends gives the request's params", async () => {
    const us = await usages({
      "php/intent.php": "<?php\nfunction create_intent($amount) {\n    $params = [\n        'amount' => $amount,\n        'currency' => 'usd',\n        'payment_method_types' => ['card'],\n    ];\n    $params['metadata'] = ['a' => 1];\n    $ch = curl_init('https://api.stripe.com/v1/payment_intents');\n    curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params));\n    return curl_exec($ch);\n}\n",
    });
    expect(at(us, "php/intent.php", /^POST \/v1\/payment_intents$/, "payment_method_types")).toEqual([6]);
    expect(at(us, "php/intent.php", /^POST \/v1\/payment_intents$/, "metadata")).toEqual([8]);
    // nested keys aren't the request's own
    expect(at(us, "php/intent.php", /^POST /, "a")).toEqual([]);
  });
  it("an array in another function isn't the body", async () => {
    const us = await usages({
      "p.php": "<?php\nfunction a() {\n    $params = ['payment_method_types' => ['card']];\n    return $params;\n}\nfunction b($params) {\n    $ch = curl_init('https://api.stripe.com/v1/payment_intents');\n    curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params));\n}\n",
    });
    expect(at(us, "p.php", /^POST /, "payment_method_types")).toEqual([]);
  });
});

describe("google-ads library default", () => {
  it("get_service without a version uses the locked library's API version", async () => {
    const us = await usages({
      "pyproject.toml": '[tool.poetry.dependencies]\ngoogle-ads = "^35.0.0"\n',
      "poetry.lock": '[[package]]\nname = "google-ads"\nversion = "35.0.0"\n',
      "report.py": 'from google.ads.googleads.client import GoogleAdsClient\nclient = GoogleAdsClient.load_from_storage()\n\ndef run():\n    svc = client.get_service("GoogleAdsService")\n',
    });
    expect(us.some((u) => u.provider === "googleads" && u.file === "report.py")).toBe(true);
  });
  it("an explicit version isn't the library default", async () => {
    const us = await usages({
      "poetry.lock": '[[package]]\nname = "google-ads"\nversion = "35.0.0"\n',
      "report.py": 'from google.ads.googleads.client import GoogleAdsClient\nclient = GoogleAdsClient.load_from_storage()\nsvc = client.get_service("GoogleAdsService", version="v26")\n',
    });
    expect(us.filter((u) => u.provider === "googleads" && u.reason?.includes("default"))).toEqual([]);
  });
});

describe("tracing stops on keyword literals", () => {
  it("Python: `x if c else None` doesn't link through an annotation's `| None =`", async () => {
    const us = await usages({
      "requirements.txt": "langchain-anthropic>=0.3\n",
      "app/lc.py": "from langchain_anthropic import ChatAnthropic\n\n\ndef _limit(request, user) -> None:\n    return None\n\n\ndef chat(model: str, fast: bool = False):\n    budget: int | None = 1024\n    temperature = 0.2 if fast else None\n    return ChatAnthropic(model=model, temperature=temperature)\n",
    });
    const t = us.filter((u) => u.params?.includes("temperature")).map((u) => u.line).sort((a, b) => a - b);
    expect(t).toEqual([10, 11]);
    expect(us.some((u) => /← None/.test(u.reason ?? ""))).toBe(false);
  });
});

describe("capability-gated settings", () => {
  it("a setting sent only when a check names it is possible and never fails a check", async () => {
    const us = await usages({
      "requirements.txt": "langchain-anthropic>=0.3\n",
      "app/lc.py": "from langchain_anthropic import ChatAnthropic\nfrom .caps import takes_temperature\n\n\ndef chat(model: str):\n    return ChatAnthropic(model=model, temperature=0 if takes_temperature(model) else None)\n",
      "app/caps.py": "def takes_temperature(model: str) -> bool:\n    return True\n",
      "web/a.ts": 'import { ChatAnthropic } from "@langchain/anthropic";\nexport const llm = (m: string) => new ChatAnthropic({ model: m, temperature: supportsTemperature(m) ? 0.2 : undefined });\n',
      "package.json": '{"dependencies":{"@langchain/anthropic":"^0.3.0"}}\n',
    });
    const py = us.find((u) => u.file === "app/lc.py" && u.params?.includes("temperature"));
    expect(py?.gated).toMatch(/takes_temperature/);
    expect(py?.confidence).toBe("possible");
    const ts = us.find((u) => u.file === "web/a.ts" && u.params?.includes("temperature"));
    expect(ts?.gated).toMatch(/supportsTemperature/);
    expect(canBlock({ usage: py, change: {}, status: "broken" } as any)).toBe(false);
  });
  it("a check that doesn't name the setting isn't a gate", async () => {
    const us = await usages({
      "requirements.txt": "langchain-anthropic>=0.3\n",
      "app/lc.py": "from langchain_anthropic import ChatAnthropic\n\n\ndef chat(model: str):\n    return ChatAnthropic(model=model, temperature=0 if is_fast(model) else None)\n",
    });
    expect(us.filter((u) => u.gated)).toEqual([]);
  });
});

describe("base joins and forwarding folders (dev-key check, 24 Nov)", () => {
  it("another host's client next to an OpenAI client: its own endpoint + path isn't OpenAI's", async () => {
    const us = await usages({
      "svc/OpenAiClient.java": 'class OpenAiClient {\n    private static final String BASE = "https://api.openai.com/v1";\n    String threads() { return BASE + "/threads"; }\n}\n',
      "svc/AzureAgentClient.java": 'class AzureAgentClient {\n    // forwarding the run to the Azure agents service\n    private final String endpoint;\n    AzureAgentClient(String endpoint) { this.endpoint = endpoint; }\n    void start() {\n        post(endpoint + "/threads", body);\n        post(endpoint + "/threads/" + id + "/runs", body);\n    }\n}\n',
    });
    expect(us.filter((u) => u.file === "svc/AzureAgentClient.java" && /threads/.test(u.op ?? ""))).toEqual([]);
    expect(us.some((u) => u.file === "svc/OpenAiClient.java" && /threads/.test(u.op ?? ""))).toBe(true);
  });
});
