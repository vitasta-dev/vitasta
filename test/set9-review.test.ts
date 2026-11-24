import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo, isTestPath } from "../src/scan/index.js";
import { findImpacts, loadFeed } from "../src/feed/match.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 9's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s9r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];
const findings = async (files: Record<string, string>) => findImpacts(await scanRepo(await repo(files)), await loadFeed(`${process.env.HOME}/vitasta/feed/data`), "2026-11-23") as any[];

describe("test files by each language's own naming", () => {
  it("channel-test.go is code; channel_test.go, foo.test.ts, foo_spec.rb, FooTest.java are tests", () => {
    expect(isTestPath("relay/channel-test.go")).toBe(false);
    expect(isTestPath("app/spec-runner.rb")).toBe(false);
    expect(isTestPath("src/latest-api.js")).toBe(false);
    for (const t of ["relay/channel_test.go", "src/foo.test.ts", "app/foo_spec.rb", "app/foo_test.rb", "src/FooTest.java", "pkg/test_helpers.py", "src/test-utils.ts", "data/test-cases.json"]) expect(isTestPath(t)).toBe(true);
  });
});

describe("a. an OpenAI-Beta header needs an Assistants op", () => {
  it("not on vector-store requests", async () => {
    const fs = await findings({ "src/VectorStores.php": "<?php\nnamespace App;\nclass VectorStores\n{\n    public function __construct($http) { $this->http = $http; $this->headers = ['OpenAI-Beta' => 'assistants=v2']; }\n    public function create(array $b) { return $this->http->post('/v1/vector_stores', ['json' => $b, 'headers' => $this->headers]); }\n}\n" });
    expect(fs.filter((f) => f.change.id.startsWith("openai-assistants"))).toEqual([]);
  });
});

describe("b. a converter to a Responses or completions request isn't Anthropic's", () => {
  it("${baseUrl}/responses and /v1/completions destinations", async () => {
    const us = await usages({
      "package.json": '{"name":"kit","dependencies":{"@anthropic-ai/sdk":"^0.60.0"}}',
      "src/responses.ts": 'import type Anthropic from "@anthropic-ai/sdk";\nexport function toResponsesBody(req: Anthropic.MessageCreateParams) {\n  return {\n    model: req.model,\n    temperature: req.temperature,\n  };\n}\nexport async function send(baseUrl: string, req: Anthropic.MessageCreateParams) {\n  return fetch(`${baseUrl}/responses`, { method: "POST", body: JSON.stringify(toResponsesBody(req)) });\n}\n',
      "src/providers/anthropic/compat.ts": "export function payload(model: string, temperature?: number) {\n  return { model, temperature };\n}\nexport async function post(base: string, body: object) {\n  return fetch(`${base}/v1/completions`, { method: \"POST\", body: JSON.stringify(body) });\n}\n",
    });
    expect(us.filter((u) => u.provider === "anthropic" && u.params?.includes("temperature"))).toEqual([]);
  });
});

describe("2. Meta Marketing paths take the Marketing provider", () => {
  it("act_/insights and /adsets are meta-marketing; /me stays meta", async () => {
    const us = await usages({ "ads.js": "async function a(acct, t) {\n  return fetch(`https://graph.facebook.com/v24.0/act_${acct}/insights?access_token=${t}`);\n}\nasync function b(id, t) {\n  return fetch(`https://graph.facebook.com/v24.0/${id}/adsets?access_token=${t}`);\n}\nasync function c(t) {\n  return fetch(`https://graph.facebook.com/v24.0/me?access_token=${t}`);\n}\n" });
    const by = (l: number) => us.find((u) => u.line === l && u.kind === "http")?.provider;
    expect([by(2), by(5), by(8)]).toEqual(["meta-marketing", "meta-marketing", "meta"]);
  });
});

describe("1. provider-wrapper libraries' endpoint paths", () => {
  it("Retrofit annotations, a PHP path constant and an enum case, joined to the library's base URL", async () => {
    const us = await usages({
      "src/main/java/a/AssistantsApi.java": 'package a;\nimport retrofit2.http.*;\npublic interface AssistantsApi {\n    @POST("v1/assistants")\n    Call<Object> create(@Body Object req);\n}\n',
      "src/main/java/a/Client.java": 'package a;\npublic class Client {\n    public static final String BASE_URL = "https://api.openai.com/";\n}\n',
      "php/Client.php": "<?php\nfinal class Client\n{\n    public const BASE_URI = 'https://api.openai.com/v1';\n}\n",
      "php/Evals.php": "<?php\nfinal class Evals\n{\n    private const PATH = 'evals';\n    public function create(array $p): array { return $this->t->post(self::PATH, $p); }\n}\n",
      "php/Endpoint.php": "<?php\nenum Endpoint: string\n{\n    case Translations = 'audio/translations';\n    case Nothing = 'not/an/endpoint';\n}\n",
    });
    const ops = us.filter((u) => u.provider === "openai").map((u) => `${u.file.split("/").pop()}:${u.line} ${u.op}`);
    expect(ops).toContain("AssistantsApi.java:4 POST /v1/assistants");
    expect(ops).toContain("Evals.php:4 * /v1/evals");
    expect(ops).toContain("Endpoint.php:4 * /v1/audio/translations");
    expect(ops.some((o) => o.startsWith("Endpoint.php:5"))).toBe(false);
  });
});

describe("3. PHP config defaults read with config('pkg.key')", () => {
  it("each read in another file is the default's version", async () => {
    const us = await usages({
      "config/fbpkg.php": "<?php\n\nreturn [\n    'graph' => [\n        'base_uri' => env('FB_GRAPH_BASE_URI', 'https://graph.facebook.com/v20.0'),\n    ],\n];\n",
      "app/PostManager.php": "<?php\nclass PostManager\n{\n    public function url(string $id): string\n    {\n        return config('fbpkg.graph.base_uri') . '/' . $id . '/feed';\n    }\n}\n",
    });
    expect(us.filter((u) => u.provider === "meta" && /v20\.0/.test(u.apiVersion ?? "")).map((u) => `${u.file}:${u.line}`).sort()).toEqual(["app/PostManager.php:6", "config/fbpkg.php:5"]);
  });
});

describe("4. Ruby: a default traced to an Anthropic adapter's capability gate", () => {
  it("the gate's params[:temperature] = …, and the executor's keyword default on its def line", async () => {
    const us = await usages({
      "Gemfile": 'gem "anthropic"\n',
      "lib/llm/executor.rb": "module Llm\n  class Executor\n    def run(text, temperature: 0.7)\n      adapter = Adapters::Anthropic.new\n      adapter.chat(text, temperature: temperature)\n    end\n  end\nend\n",
      "lib/llm/adapters/anthropic.rb": "module Llm\n  module Adapters\n    class Anthropic\n      def initialize\n        @client = ::Anthropic::Client.new(api_key: ENV[\"KEY\"])\n      end\n\n      def chat(text, temperature:)\n        params = { model: \"claude-sonnet-4-5\", max_tokens: 1024, messages: [] }\n        params[:temperature] = temperature if supports_temperature?\n        @client.messages.create(**params)\n      end\n    end\n  end\nend\n",
    });
    const at = us.filter((u) => u.provider === "anthropic" && u.params?.includes("temperature")).map((u) => `${u.file}:${u.line}`);
    expect(at).toContain("lib/llm/adapters/anthropic.rb:10");
    expect(at).toContain("lib/llm/executor.rb:3");
  });
});

describe("d. sample and demo projects", () => {
  it("dotted .NET sample projects are samples; a name that starts with demo isn't", () => {
    for (const t of ["Sample.Web/appsettings.json", "src/MyApp.Samples/appsettings.json", "MyApp.Demo/appsettings.json"]) expect(isTestPath(t)).toBe(true);
    expect(isTestPath("src/DemographicsService/appsettings.json")).toBe(false);
  });
});

describe("1b. a bare word isn't an endpoint path by its spelling", () => {
  it("SEARCH = 'search', type=\"search\" in a view, setFocus('search') give nothing", async () => {
    const us = await usages({
      "app/C.php": '<?php\nclass C { public const BASE = "https://api.openai.com/v1"; }\n',
      "app/RateLimits.php": "<?php\nclass RateLimits\n{\n    public const SEARCH = 'search';\n}\n",
      "resources/views/a.blade.php": '<input type="search" />\n',
      "app/ui.ts": 'export function f(setFocus: any) { setFocus("search"); }\n',
    });
    expect(us.filter((u) => u.provider === "openai" && /search/.test(u.op ?? ""))).toEqual([]);
  });
});

describe("1c. a server's routes aren't client calls", () => {
  it("@GetMapping on a Spring controller gives nothing; on a Feign client it counts", async () => {
    const base = { "src/main/java/a/Conf.java": 'package a;\npublic class Conf { public static final String BASE = "https://api.openai.com/v1"; }\n' };
    const ctl = 'package a;\n@RestController\npublic class Ctl {\n    @GetMapping("/v1/assistants")\n    public String list() { return ""; }\n}\n';
    expect((await usages({ ...base, "src/main/java/a/Ctl.java": ctl })).filter((u) => u.provider === "openai" && u.file.endsWith("Ctl.java"))).toEqual([]);
    const feign = 'package a;\n@FeignClient(name = "openai", url = "https://api.openai.com")\npublic interface Api {\n    @PostMapping("/v1/assistants")\n    String create(Object body);\n}\n';
    expect((await usages({ ...base, "src/main/java/a/Api.java": feign })).find((u) => u.provider === "openai" && u.file.endsWith("Api.java"))?.op).toBe("POST /v1/assistants");
  });
});
