import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSdkSource } from "../src/scan/sdkcode.js";
import { scanRepo } from "../src/scan/index.js";
import { findImpacts, loadFeed } from "../src/feed/match.js";
import { queryOf } from "../src/feed/lookup.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 16's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s16r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

describe("a provider SDK's own code without a manifest", () => {
  it("bundle modules that define the SDK's resource classes give one note; the app's own call stays", async () => {
    const us = await usages({ "package.json": '{"name":"app","dependencies":{"openai":"^4.0.0"}}\n', "engine/modules/0412-assistants.js": "import { APIResource } from \"./0398-resource.js\";\nexport class Assistants extends APIResource {\n  create(body, options) {\n    return this._client.post('/assistants', { body, ...options, headers: { 'OpenAI-Beta': 'assistants=v2', ...options?.headers } });\n  }\n  retrieve(assistantID, options) {\n    return this._client.get(`/assistants/${assistantID}`, { ...options, headers: { 'OpenAI-Beta': 'assistants=v2' } });\n  }\n  list(query = {}, options) {\n    return this._client.getAPIList('/assistants', CursorPage, { query, ...options });\n  }\n}\n", "engine/modules/0413-threads.js": "export class Threads extends APIResource {\n  create(body = {}, options) {\n    return this._client.post('/threads', { body, ...options, headers: { 'OpenAI-Beta': 'assistants=v2' } });\n  }\n  createAndRun(body, options) {\n    return this._client.post('/threads/runs', { body, ...options, stream: body.stream ?? false });\n  }\n}\n", "src/app.js": "import OpenAI from \"openai\";\nconst client = new OpenAI();\nexport const make = () => client.beta.assistants.create({ name: \"t\", model: \"gpt-4o\" });\n" });
    const bundle = us.filter((u) => u.file.startsWith("engine/"));
    expect(bundle.length).toBe(1);
    expect(bundle[0].role).toBe("recorded");
    expect(us.some((u) => u.file === "src/app.js" && /assistants/.test(u.op ?? "") && u.role !== "recorded")).toBe(true);
  });
  it("is decided by what a file defines, in any language, not by its path", () => {
    expect(isSdkSource("class Assistants(SyncAPIResource):\n    def create(self):\n        return self._post(\"/assistants\")\n")).toBe(true);
    expect(isSdkSource("func (r *AssistantService) New(ctx context.Context, body AssistantNewParams) {\n\terr = requestconfig.ExecuteNewRequest(ctx, \"POST\", \"assistants\")\n}\n")).toBe(true);
    // an app that calls the SDK, or wraps its own HTTP client, isn't
    expect(isSdkSource("const a = await client.beta.assistants.create({ model: 'gpt-4o' });\n")).toBe(false);
    expect(isSdkSource("class Api { list() { return this._client.post('/assistants'); } get() { return this._client.get('/threads'); } }\n")).toBe(false);
  });
});

describe("UI values aren't request settings", () => {
  it("JSX: JSON shown as a placeholder", async () => {
    const us = await usages({ "package.json": '{"dependencies":{"@anthropic-ai/sdk":"^0.30.0"}}\n', "web/Settings.tsx": "import Anthropic from \"@anthropic-ai/sdk\";\nexport function Settings({ value, onChange }: any) {\n  const c = new Anthropic();\n  return (\n    <textarea\n      value={value}\n      onChange={onChange}\n      placeholder='{\"temperature\": 0.7, \"top_p\": 0.9}'\n    />\n  );\n}\n" });
    expect(us.filter((u) => u.params?.some((p: string) => p === "temperature" || p === "top_p"))).toEqual([]);
  });
  it("Python: a slider named after a setting, with a default, that nothing sends", async () => {
    const us = await usages({ "requirements.txt": "anthropic>=0.40\ngradio>=4\n", "app.py": "import anthropic\nimport gradio as gr\n\nclient = anthropic.Anthropic()\n\n\ndef build_ui():\n    with gr.Blocks() as demo:\n        temperature = gr.Slider(name=\"temperature\", minimum=0.0, maximum=1.0, default=0.7)\n        top_p = gr.Slider(label=\"top_p\", minimum=0.0, maximum=1.0, value=0.9)\n        box = gr.Textbox()\n        btn = gr.Button(\"Send\")\n        btn.click(lambda p: client.messages.create(model=\"claude-sonnet-4-5\", max_tokens=100, messages=[{\"role\": \"user\", \"content\": p}]).content[0].text, inputs=[box], outputs=[box])\n    return demo\n" });
    expect(us.filter((u) => u.params?.some((p: string) => p === "temperature" || p === "top_p"))).toEqual([]);
  });
  it("a raw JSON body in a string is still a body", async () => {
    const us = await usages({ "package.json": '{"dependencies":{}}\n', "a.ts": 'export async function f(key: string) {\n  return fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, body: \'{"model":"claude-sonnet-4-5","max_tokens":10,"temperature":0.2,"messages":[]}\' });\n}\n' });
    expect(us.some((u) => u.file === "a.ts" && u.params?.includes("temperature"))).toBe(true);
  });
});

describe("an OpenAI-compatible request in an Anthropic client class", () => {
  it("Java: the method whose URL a resolveOpenAiEndpoint(…) helper builds isn't Anthropic's", async () => {
    const us = await usages({ "ClaudeClient.java": "package com.x;\n\nimport java.net.URI;\nimport java.net.http.HttpClient;\nimport java.net.http.HttpRequest;\nimport java.util.HashMap;\nimport java.util.Map;\n\npublic class ClaudeClient {\n    private static final String ANTHROPIC_URL = \"https://api.anthropic.com/v1/messages\";\n    private final HttpClient http = HttpClient.newHttpClient();\n\n    public String complete(String prompt) throws Exception {\n        Map<String, Object> body = new HashMap<>();\n        body.put(\"model\", \"claude-sonnet-4-5\");\n        body.put(\"max_tokens\", 1024);\n        HttpRequest req = HttpRequest.newBuilder(URI.create(ANTHROPIC_URL))\n                .header(\"anthropic-version\", \"2023-06-01\")\n                .POST(HttpRequest.BodyPublishers.ofString(body.toString())).build();\n        return http.send(req, null).toString();\n    }\n\n    public String completeCompatible(String baseUrl, String model, String prompt) throws Exception {\n        Map<String, Object> body = new HashMap<>();\n        body.put(\"model\", model);\n        body.put(\"temperature\", 0.7);\n        body.put(\"top_p\", 0.9);\n        HttpRequest req = HttpRequest.newBuilder(URI.create(resolveOpenAiEndpoint(baseUrl)))\n                .header(\"anthropic-version\", \"2023-06-01\")\n                .POST(HttpRequest.BodyPublishers.ofString(body.toString())).build();\n        return http.send(req, null).toString();\n    }\n\n    private String resolveOpenAiEndpoint(String baseUrl) { return UrlUtil.join(baseUrl, Paths.COMPLETIONS); }\n}\n" });
    expect(us.filter((u) => u.file === "ClaudeClient.java" && u.line >= 23 && u.line <= 31 && u.params?.some((p: string) => p === "temperature" || p === "top_p"))).toEqual([]);
  });
});

describe("Meta Marketing versions with no record of their own", () => {
  const files = {"pkg/pkg.gemspec": "Gem::Specification.new do |s|\n  s.name = \"pkg\"\n  s.add_dependency \"faraday\"\nend\n", "pkg/lib/pkg/integrations/core/constants.rb": "module Pkg\n  module Integrations\n    module Core\n      module Constants\n        ZENDESK_TICKETS_URL = \"https://%<subdomain>s.zendesk.com/api/v2/tickets.json\"\n        AIRTABLE_BASES_URL = \"https://api.airtable.com/v0/meta/bases\"\n        HUBSPOT_CONTACTS_URL = \"https://api.hubapi.com/crm/v3/objects/contacts\"\n        FACEBOOK_AUDIENCE_GET_ALL_ACCOUNTS = \"https://graph.facebook.com/v18.0/me/adaccounts?fields=id,name\"\n        SLACK_POST_MESSAGE = \"https://slack.com/api/chat.postMessage\"\n      end\n    end\n  end\nend\n", "pkg/lib/pkg/integrations/destination/facebook_custom_audience/client.rb": "module Pkg\n  module Integrations\n    module Destination\n      module FacebookCustomAudience\n        class Client\n          include Pkg::Integrations::Core::Constants\n\n          def accounts(token)\n            Pkg::Integrations::Core::HttpClient.request(FACEBOOK_AUDIENCE_GET_ALL_ACCOUNTS, \"GET\", headers: { \"Authorization\" => \"Bearer #{token}\" })\n          end\n\n          def write(records, token)\n            stream = catalog[\"streams\"].first\n            Pkg::Integrations::Core::HttpClient.request(stream[\"url\"].gsub(\"{audience_id}\", records.first[:audience]), stream[\"method\"], payload: records)\n          end\n\n          def catalog\n            @catalog ||= JSON.parse(File.read(File.join(__dir__, \"config\", \"catalog.json\")))\n          end\n        end\n      end\n    end\n  end\nend\n", "pkg/lib/pkg/integrations/destination/facebook_custom_audience/config/catalog.json": "{\n  \"streams\": [\n    {\n      \"name\": \"audience_users\",\n      \"url\": \"https://graph.facebook.com/v18.0/{audience_id}/users\",\n      \"method\": \"POST\",\n      \"batch_size\": 10000\n    }\n  ]\n}\n"};
  it("a v18.0 Marketing URL in a many-vendor constants module and in a connector's JSON config match the Graph v18.0 record", async () => {
    const d = await repo(files);
    const map = await scanRepo(d);
    const feed = [
      { id: "meta-graph-v18.0-sunset-2026-01-26", provider: "meta", type: "version_sunset", title: "Graph API v18.0", selector: { versions: ["v18.0"] }, effective: "2026-01-26", sources: [] },
      { id: "meta-marketing-v24.0-sunset-2026-11-10", provider: "meta-marketing", type: "version_sunset", title: "Marketing API v24.0", selector: { versions: ["v24.0"] }, effective: "2026-11-10", sources: [] },
    ] as any[];
    const fs = findImpacts(map as any, feed, "2026-11-24");
    const at = fs.filter((f) => f.change.id === "meta-graph-v18.0-sunset-2026-01-26").map((f) => `${f.usage.file.split("/").pop()}:${f.usage.line}`).sort();
    expect(at).toEqual(["catalog.json:5", "constants.rb:8"]);
    // and the lookup query asks for the same version under Graph too
    expect(queryOf((map as any).usages).some((q) => q.provider === "meta" && /v18\.0/.test(q.apiVersion ?? ""))).toBe(true);
  });
  it("a Marketing version that has its own record uses it, not Graph's", async () => {
    const d = await repo({ ...files, "pkg/lib/pkg/integrations/core/constants.rb": files["pkg/lib/pkg/integrations/core/constants.rb"].replace("v18.0", "v24.0") });
    const fs = findImpacts((await scanRepo(d)) as any, [
      { id: "meta-graph-v24.0-sunset-2027-01-01", provider: "meta", type: "version_sunset", title: "g", selector: { versions: ["v24.0"] }, effective: "2027-01-01", sources: [] },
      { id: "meta-marketing-v24.0-sunset-2026-11-10", provider: "meta-marketing", type: "version_sunset", title: "m", selector: { versions: ["v24.0"] }, effective: "2026-11-10", sources: [] },
    ] as any[], "2026-11-24");
    const c = fs.filter((f) => f.usage.file.endsWith("constants.rb")).map((f) => f.change.id);
    expect(c).toEqual(["meta-marketing-v24.0-sunset-2026-11-10"]);
  });
});

describe("a minified, re-split SDK bundle (mangled names, tagged-template paths)", () => {
  it("is SDK code by its shape: client-internal requests, generator options, sub-resources on the client", async () => {
    const us = await usages({ "package.json": '{"name":"app","dependencies":{"openai":"^4.0.0"}}\n', "engine/modules/2231-r.js": "import{Ni as Ni,Cn as Cn,Xa as Xa,fze as fze}from\"./2230-c.js\";var iCe=class iCe extends Ni{constructor(){super(...arguments);this.steps=new fze(this._client)}create(e,t,r){let{include:n,...a}=t;return this._client.post(Cn`/threads/${e}/runs`,{query:{include:n},body:a,...r,headers:Xa([{\"OpenAI-Beta\":\"assistants=v2\"},r?.headers]),stream:t.stream??!1,__synthesizeEventData:!0,__security:{bearerAuth:!0}})}retrieve(e,t,r){let{thread_id:s}=t;return this._client.get(Cn`/threads/${s}/runs/${e}`,{...r,headers:Xa([{\"OpenAI-Beta\":\"assistants=v2\"},r?.headers]),__security:{bearerAuth:!0}})}};export{iCe as Runs};\n", "engine/modules/2232-a.js": "var qBe=class qBe extends Ni{create(e,t){return this._client.post(\"/assistants\",{body:e,...t,headers:Xa([{\"OpenAI-Beta\":\"assistants=v2\"},t?.headers]),__security:{bearerAuth:!0}})}del(e,t){return this._client.delete(Cn`/assistants/${e}`,{...t,headers:Xa([{\"OpenAI-Beta\":\"assistants=v2\"},t?.headers])})}};export{qBe as Assistants};\n", "src/app.js": "import OpenAI from \"openai\";\nconst client = new OpenAI();\nexport const make = () => client.beta.assistants.create({ name: \"t\", model: \"gpt-4o\" });\n" });
    const bundle = us.filter((u) => u.file.startsWith("engine/"));
    expect(bundle.length).toBe(1);
    expect(bundle[0].role).toBe("recorded");
    expect(us.some((u) => u.file === "src/app.js" && /assistants/.test(u.op ?? "") && u.role !== "recorded")).toBe(true);
  });
  it("one generator option with a client-internal request is enough; neither alone is", () => {
    expect(isSdkSource("x=class x extends y{a(e){return this._client.post(Q`/files`,{body:e,__binaryResponse:!0})}}")).toBe(true);
    expect(isSdkSource("const opts = { __metadata: { a: 1 } };")).toBe(false);
    expect(isSdkSource("class A { go() { return this._client.post(`/runs`, {}); } }")).toBe(false);
  });
});

describe("a Marketing version dated by Graph's record", () => {
  it("the report says the date is the latest and the Marketing version may stop sooner", async () => {
    const { renderMarkdown } = await import("../src/report/markdown.js");
    const d = await repo({ "lib/c.rb": '# Facebook Ads\nURL = "https://graph.facebook.com/v18.0/act_1/insights"\nNet::HTTP.get(URI(URL))\n' });
    const map = await scanRepo(d);
    const fs = findImpacts(map as any, [{ id: "meta-graph-v18.0-sunset-2026-01-26", provider: "meta", type: "version_sunset", title: "Graph API v18.0", selector: { versions: ["v18.0"] }, effective: "2026-01-26", sources: [] }] as any[], "2026-11-24");
    expect(fs.length).toBeGreaterThan(0);
    expect(renderMarkdown(map as any, fs, "x")).toMatch(/may stop sooner/);
  });
});

describe("builder chains", () => {
  it("Spring AI options with ternary fallbacks: each step is its setting, calls inside the arguments aren't steps", async () => {
    const us = await usages({ "pom.xml": "<project><dependencies><dependency><groupId>org.springframework.ai</groupId><artifactId>spring-ai-anthropic</artifactId><version>1.0.0</version></dependency></dependencies></project>\n", "ChatFactory.java": "package com.x;\n\nimport org.springframework.ai.anthropic.AnthropicChatModel;\nimport org.springframework.ai.anthropic.AnthropicChatOptions;\nimport org.springframework.ai.anthropic.api.AnthropicApi;\n\npublic class ChatFactory {\n    public AnthropicChatModel create(AnthropicApi api, AgentConfig cfg) {\n        AnthropicChatOptions options = AnthropicChatOptions.builder()\n                .model(cfg.getModel() != null ? cfg.getModel() : \"claude-sonnet-4-5\")\n                .temperature(cfg.getTemperature() != null ? cfg.getTemperature() : 0.7)\n                .topP(cfg.getTopP() != null ? cfg.getTopP() : 0.9)\n                .topK(cfg.getTopK() != null ? cfg.getTopK() : 40)\n                .maxTokens(1024)\n                .build();\n        return AnthropicChatModel.builder().anthropicApi(api).defaultOptions(options).build();\n    }\n}\n" });
    const ps = us.filter((u) => u.file === "ChatFactory.java" && u.params?.length).flatMap((u) => u.params).sort();
    expect(ps).toEqual(["max_tokens", "model", "temperature", "top_k", "top_p"]);
  });
});

describe("Ruby: sampling defaults in a hash a request body is built from", () => {
  it("a defaults constant in another file, through a class method and .merge chains, into a Net::HTTP body", async () => {
    const us = await usages({ "lib/llm/configuration.rb": "module Llm\n  class Configuration\n    DEFAULTS = {\n      max_tokens: 1024,\n      temperature: 0.2\n    }.freeze\n\n    def self.defaults\n      DEFAULTS\n    end\n  end\nend\n", "lib/llm/adapters/anthropic.rb": "require \"net/http\"\nrequire \"json\"\n\nmodule Llm\n  module Adapters\n    class Anthropic\n      URL = URI(\"https://api.anthropic.com/v1/messages\")\n\n      def initialize(api_key, options = {})\n        @api_key = api_key\n        @options = Llm::Configuration.defaults.merge(model: \"claude-sonnet-4-5\").merge(options)\n      end\n\n      def chat(messages)\n        req = Net::HTTP::Post.new(URL, \"x-api-key\" => @api_key, \"anthropic-version\" => \"2023-06-01\", \"content-type\" => \"application/json\")\n        req.body = @options.merge(messages: messages).to_json\n        Net::HTTP.start(URL.host, URL.port, use_ssl: true) { |h| h.request(req) }\n      end\n    end\n  end\nend\n" });
    expect(us.some((u) => u.file === "lib/llm/configuration.rb" && u.line === 5 && u.params?.includes("temperature") && u.op === "POST /v1/messages")).toBe(true);
  });
  it("a hash the body isn't built from isn't the request's", async () => {
    const us = await usages({
      "lib/llm/ui.rb": "module Llm\n  SLIDERS = { temperature: 0.7 }.freeze\nend\n",
      "lib/llm/adapters/anthropic.rb": "require \"net/http\"\nrequire \"json\"\n\nmodule Llm\n  module Adapters\n    class Anthropic\n      URL = URI(\"https://api.anthropic.com/v1/messages\")\n\n      def initialize(api_key, options = {})\n        @api_key = api_key\n        @options = Llm::Configuration.defaults.merge(model: \"claude-sonnet-4-5\").merge(options)\n      end\n\n      def chat(messages)\n        req = Net::HTTP::Post.new(URL, \"x-api-key\" => @api_key, \"anthropic-version\" => \"2023-06-01\", \"content-type\" => \"application/json\")\n        req.body = @options.merge(messages: messages).to_json\n        Net::HTTP.start(URL.host, URL.port, use_ssl: true) { |h| h.request(req) }\n      end\n    end\n  end\nend\n",
      "lib/llm/configuration.rb": "module Llm\n  class Configuration\n    def self.defaults\n      { max_tokens: 1024 }\n    end\n  end\nend\n",
    });
    expect(us.filter((u) => u.params?.includes("temperature"))).toEqual([]);
  });
});

describe("PHP: a request setting read from framework config", () => {
  it("config('anthropic.temperature') in a Guzzle body: the config file's line is the setting too", async () => {
    const us = await usages({ "config/anthropic.php": "<?php\n\nreturn [\n    'api_key' => env('ANTHROPIC_API_KEY'),\n    'model' => env('ANTHROPIC_MODEL', 'claude-sonnet-4-5'),\n    'temperature' => env('ANTHROPIC_TEMPERATURE', 0.2),\n    'max_tokens' => 1024,\n];\n", "src/AnthropicClient.php": "<?php\n\nnamespace Acme\\Anthropic;\n\nuse GuzzleHttp\\Client;\n\nclass AnthropicClient\n{\n    public function __construct(private Client $http) {}\n\n    public function message(array $messages): array\n    {\n        $response = $this->http->post('https://api.anthropic.com/v1/messages', [\n            'headers' => ['x-api-key' => config('anthropic.api_key'), 'anthropic-version' => '2023-06-01'],\n            'json' => [\n                'model' => config('anthropic.model'),\n                'max_tokens' => config('anthropic.max_tokens'),\n                'temperature' => config('anthropic.temperature'),\n                'messages' => $messages,\n            ],\n        ]);\n        return json_decode((string) $response->getBody(), true);\n    }\n}\n" });
    expect(us.some((u) => u.file === "config/anthropic.php" && u.line === 6 && u.params?.includes("temperature") && u.op === "POST /v1/messages")).toBe(true);
    expect(us.some((u) => u.file === "src/AnthropicClient.php" && u.line === 18 && u.params?.includes("temperature"))).toBe(true);
  });
});

describe("Java raw HTTP: RestTemplate, String.format URLs, locals, HttpHeaders.set", () => {
  it("a Spring service's RestTemplate.exchange calls on literal and formatted URLs, and its OpenAI-Beta header", async () => {
    const us = await usages({ "server/src/main/java/com/acme/Acme/services/impl/OpenAIServiceImpl.java": "package com.acme.Acme.services.impl;\n\nimport com.acme.Acme.services.OpenAIService;\nimport java.util.HashMap;\nimport java.util.Map;\nimport org.springframework.beans.factory.annotation.Value;\nimport org.springframework.core.io.FileSystemResource;\nimport org.springframework.http.HttpEntity;\nimport org.springframework.http.HttpHeaders;\nimport org.springframework.http.HttpMethod;\nimport org.springframework.http.MediaType;\nimport org.springframework.http.ResponseEntity;\nimport org.springframework.stereotype.Service;\nimport org.springframework.util.LinkedMultiValueMap;\nimport org.springframework.util.MultiValueMap;\nimport org.springframework.web.client.RestTemplate;\n\n@Service\npublic class OpenAIServiceImpl implements OpenAIService {\n\n    private final RestTemplate restTemplate;\n\n    @Value(\"${spring.ai.openai.api-key}\")\n    private String apiKey;\n\n    @Value(\"${spring.ai.openai.assistant-id}\")\n    private String assistantId;\n\n    public OpenAIServiceImpl(RestTemplate restTemplate) {\n        this.restTemplate = restTemplate;\n    }\n\n    private HttpHeaders createHeaders() {\n        HttpHeaders headers = new HttpHeaders();\n        headers.setContentType(MediaType.APPLICATION_JSON);\n        headers.setBearerAuth(apiKey);\n        headers.set(\"OpenAI-Beta\", \"assistants=v2\");\n        return headers;\n    }\n\n    @Override\n    public Map createThread() {\n        String url = \"https://api.openai.com/v1/threads\";\n        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(new HashMap<>(), createHeaders());\n        ResponseEntity<Map> response = restTemplate.exchange(url, HttpMethod.POST, entity, Map.class);\n        return response.getBody();\n    }\n\n    @Override\n    public Map addMessage(String threadId, String content) {\n        String url = String.format(\"https://api.openai.com/v1/threads/%s/messages\", threadId);\n        Map<String, Object> body = new HashMap<>();\n        body.put(\"role\", \"user\");\n        body.put(\"content\", content);\n        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, createHeaders());\n        return restTemplate.exchange(url, HttpMethod.POST, entity, Map.class).getBody();\n    }\n\n    @Override\n    public Map createRun(String threadId) {\n        String url = String.format(\"https://api.openai.com/v1/threads/%s/runs\", threadId);\n        Map<String, Object> body = new HashMap<>();\n        body.put(\"assistant_id\", assistantId);\n        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, createHeaders());\n        Map run = restTemplate.exchange(url, HttpMethod.POST, entity, Map.class).getBody();\n        final String runUrl = String.format(\"https://api.openai.com/v1/threads/%s/runs/%s\", threadId, run.get(\"id\"));\n        return restTemplate.exchange(runUrl, HttpMethod.GET, new HttpEntity<>(createHeaders()), Map.class).getBody();\n    }\n\n    public Map uploadFile(String path) {\n        HttpHeaders headers = new HttpHeaders();\n        headers.setContentType(MediaType.MULTIPART_FORM_DATA);\n        headers.setBearerAuth(apiKey);\n        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();\n        form.add(\"file\", new FileSystemResource(path));\n        form.add(\"purpose\", \"assistants\");\n        return restTemplate.exchange(\"https://api.openai.com/v1/files\", HttpMethod.POST, new HttpEntity<>(form, headers), Map.class).getBody();\n    }\n}\n" });
    const ops = us.filter((u) => u.op).map((u) => `${u.line} ${u.op}`);
    expect(ops).toEqual(expect.arrayContaining(["45 POST /v1/threads", "56 POST /v1/threads/{id}/messages", "65 POST /v1/threads/{id}/runs", "67 GET /v1/threads/{id}/runs/{id}", "77 POST /v1/files"]));
    expect(us.some((u) => u.kind === "version-pin" && /assistants=v2/.test(u.apiVersion ?? ""))).toBe(true);
  });
  it("Apache HttpPost on a provider URL", async () => {
    const us = await usages({ "A.java": 'import org.apache.http.client.methods.HttpPost;\nclass A {\n  void f() {\n    HttpPost p = new HttpPost("https://api.openai.com/v1/threads");\n  }\n}\n' });
    expect(us.some((u) => u.line === 4 && u.op === "POST /v1/threads")).toBe(true);
  });
  it("delete / set on things that aren't REST clients or version headers don't count", async () => {
    const us = await usages({ "B.java": 'class B {\n  void f(java.util.Map<String, String> m) {\n    cache.delete("https://api.openai.com/v1/threads");\n    m.put("x", "y");\n    props.set("timeout", "30");\n  }\n}\n' });
    expect(us.filter((u) => u.op || u.kind === "version-pin")).toEqual([]);
  });
});

describe("set 16 follow-ups", () => {
  it("TS: audio.translations.create, also on a neutrally named client from a factory another module exports", async () => {
    const pkg = '{"dependencies":{"openai":"^4.60.0"}}\n';
    const us = await usages({ "package.json": pkg, "lib/client.ts": "import OpenAI from \"openai\";\nexport function getOpenAI(): OpenAI {\n  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });\n}\n", "lib/audio.ts": "import fs from \"node:fs\";\nimport { getOpenAI } from \"./client\";\n\nconst openai = getOpenAI();\n\nasync function translateInternal(path: string) {\n  const res = await openai.audio.translations.create({\n    file: fs.createReadStream(path),\n    model: \"whisper-1\",\n  });\n  return res.text;\n}\n\nexport { translateInternal as translate };\n" });
    expect(us.some((u) => u.file === "lib/audio.ts" && u.line === 7 && u.op === "POST /v1/audio/translations")).toBe(true);
    const renamed = "import fs from \"node:fs\";\nimport { getOpenAI } from \"./client\";\n\nconst openai = getOpenAI();\n\nasync function translateInternal(path: string) {\n  const res = await openai.audio.translations.create({\n    file: fs.createReadStream(path),\n    model: \"whisper-1\",\n  });\n  return res.text;\n}\n\nexport { translateInternal as translate };\n".replace(/\bopenai\b/g, "client");
    const us2 = await usages({ "package.json": pkg, "lib/client.ts": "import OpenAI from \"openai\";\nexport function getOpenAI(): OpenAI {\n  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });\n}\n", "lib/audio.ts": renamed });
    expect(us2.some((u) => u.file === "lib/audio.ts" && u.line === 7 && u.op === "POST /v1/audio/translations")).toBe(true);
  });
  it("Go: payload[\"temperature\"] = *temp traces to the flag's default", async () => {
    const us = await usages({ "go.mod": "module x\n", "main.go": "package main\n\nimport (\n\t\"bytes\"\n\t\"encoding/json\"\n\t\"flag\"\n\t\"net/http\"\n)\n\nvar temp = flag.Float64(\"temperature\", 0.7, \"sampling temperature\")\n\nfunc ask(prompt string) (*http.Response, error) {\n\tpayload := map[string]interface{}{\n\t\t\"model\":      \"claude-sonnet-4-5\",\n\t\t\"max_tokens\": 1024,\n\t\t\"messages\":   []map[string]string{{\"role\": \"user\", \"content\": prompt}},\n\t}\n\tpayload[\"temperature\"] = *temp\n\tbody, _ := json.Marshal(payload)\n\treq, _ := http.NewRequest(\"POST\", \"https://api.anthropic.com/v1/messages\", bytes.NewReader(body))\n\treq.Header.Set(\"anthropic-version\", \"2023-06-01\")\n\treturn http.DefaultClient.Do(req)\n}\n" });
    expect(us.some((u) => u.line === 10 && u.params?.includes("temperature") && u.op === "POST /v1/messages")).toBe(true);
  });
  it("Java: a Spring controller serving /v1 routes isn't a provider call", async () => {
    const us = await usages({ "ProxyController.java": "import org.springframework.web.bind.annotation.*;\nimport org.springframework.web.client.RestTemplate;\n\n@RestController\n@RequestMapping(\"/v1\")\npublic class ProxyController {\n    private final RestTemplate restTemplate = new RestTemplate();\n\n    @PostMapping(\"/threads\")\n    public Object createThread(@RequestBody Object body) {\n        return java.util.Map.of(\"id\", \"thread_local\");\n    }\n\n    @GetMapping(\"/assistants/{id}\")\n    public Object getAssistant(@PathVariable String id) {\n        return restTemplate.getForObject(\"/internal/assistants/\" + id, Object.class);\n    }\n}\n" });
    expect(us.filter((u) => u.op)).toEqual([]);
  });
});
