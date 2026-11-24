import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 17's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s17r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

describe("routes the app serves, router links and path tests aren't provider calls", () => {
  it("a Go server implementing the Assistants API, its dashboard's links, and a URL classifier", async () => {
    const us = await usages({ "go.mod": "module x\n\ngo 1.22\n", "server/endpoints/assistants_gen.go": "package endpoints\n\nimport \"net/http\"\n\n// Code generated from the Assistants API spec. DO NOT EDIT.\n\nconst AssistantsPath = \"/assistants\"\nconst ThreadsPath = \"/threads\"\n\nfunc RegisterAssistants(mux *http.ServeMux, h Handler) {\n\tmux.HandleFunc(\"/v1/assistants\", h.ListAssistants)\n\tmux.HandleFunc(\"/v1/threads\", h.CreateThread)\n\tmux.HandleFunc(\"/v1/threads/{thread_id}/runs\", h.CreateRun)\n}\n", "server/cmd/serve.go": "package cmd\n\nimport (\n\t\"net/http\"\n\t\"x/server/endpoints\"\n)\n\n// upstream models are forwarded to the configured provider\nconst upstream = \"https://api.openai.com/v1\"\n\nfunc Serve(h endpoints.Handler) {\n\tmux := http.NewServeMux()\n\tendpoints.RegisterAssistants(mux, h)\n\tmux.HandleFunc(\"/healthz\", func(w http.ResponseWriter, r *http.Request) {})\n\thttp.ListenAndServe(\":8080\", mux)\n}\n", "dashboard/src/Nav.tsx": "import { Link, useNavigate } from \"react-router-dom\";\nexport function Nav() {\n  const navigate = useNavigate();\n  const items = [{ to: \"/assistants\", label: \"Assistants\" }, { to: \"/threads\", label: \"Threads\" }];\n  return (\n    <nav>\n      {items.map((i) => <Link key={i.to} to={i.to}>{i.label}</Link>)}\n      <a href=\"/assistants\">All</a>\n      <button onClick={() => navigate(\"/threads\")}>Threads</button>\n    </nav>\n  );\n}\n", "dashboard/package.json": '{"dependencies":{"react-router-dom":"^6.0.0"}}\n', "classify/urls.py": "BASE = \"https://api.openai.com/v1\"\n\ndef classify(path: str) -> str:\n    if \"/search/\" in path:\n        return \"search\"\n    if path.startswith(\"/assistants\"):\n        return \"assistants\"\n    return \"other\"\n" });
    expect(us.filter((u) => /assistants|threads|search/.test(u.op ?? ""))).toEqual([]);
  });
  it("a relay that forwards to the provider is still read", async () => {
    const us = await usages({ "go.mod": "module x\n", "proxy/p.go": 'package proxy\n\nimport "net/http"\n\nconst upstream = "https://api.openai.com/v1"\n\nfunc forward(w http.ResponseWriter, r *http.Request) {\n\treq, _ := http.NewRequest("POST", upstream+"/threads", r.Body)\n\thttp.DefaultClient.Do(req)\n}\n' });
    expect(us.some((u) => /\/v1\/threads/.test(u.op ?? ""))).toBe(true);
  });
});

describe("another server's settings aren't traced into an Anthropic request", () => {
  it("an Ollama tool's own generate(…) isn't the Claude module's; an aliased real caller is", async () => {
    const us = await usages({ "requirements.txt": "langchain-anthropic>=0.3\nrequests\n", "tools/ollama_tool.py": "import requests\n\nOLLAMA_URL = \"http://localhost:11434/api/generate\"\n\n\ndef generate(prompt: str, model: str = \"llama3\", temperature: float = 0.2) -> str:\n    r = requests.post(OLLAMA_URL, json={\"model\": model, \"prompt\": prompt, \"options\": {\"temperature\": temperature}})\n    return r.json()[\"response\"]\n\n\ndef summarize(text: str) -> str:\n    return generate(f\"Summarize: {text}\", temperature=0.1)\n", "llm/claude.py": "from langchain_anthropic import ChatAnthropic\n\n\ndef generate(prompt: str, temperature: float = 1.0) -> str:\n    llm = ChatAnthropic(model=\"claude-sonnet-4-5\", temperature=temperature)\n    return llm.invoke(prompt).content\n", "jobs/hf_dispatch.py": "from llm.claude import generate as claude_generate\n\nHF_ENDPOINT = \"https://api-inference.huggingface.co/models/meta-llama/Llama-3-8b\"\n\n\ndef run_job(prompt, temperature=0.9):\n    import requests\n    return requests.post(HF_ENDPOINT, json={\"inputs\": prompt, \"parameters\": {\"temperature\": temperature}}).json()\n\n\ndef review(text):\n    return claude_generate(text, temperature=0.3)\n" });
    const t = us.filter((u) => u.params?.includes("temperature") && u.op === "POST /v1/messages").map((u) => `${u.file}:${u.line}`).sort();
    expect(t).not.toContain("tools/ollama_tool.py:12");
    expect(t).not.toContain("tools/ollama_tool.py:6");
    expect(t).not.toContain("jobs/hf_dispatch.py:6");
    expect(t).toContain("jobs/hf_dispatch.py:12");
  });
});

describe("option setters copy the caller's value", () => {
  it("Go functional options (WithTemperature / WithTopP) aren't defaults; the request struct's fields are the settings", async () => {
    const us = await usages({ "go.mod": "module x\n", "claude/client.go": "package claude\n\nimport (\n\t\"bytes\"\n\t\"encoding/json\"\n\t\"net/http\"\n)\n\ntype RequestConfig struct {\n\tModel       string  `json:\"model\"`\n\tMaxTokens   int     `json:\"max_tokens\"`\n\tTemperature float64 `json:\"temperature,omitempty\"`\n\tTopP        float64 `json:\"top_p,omitempty\"`\n}\n\ntype Option func(*RequestConfig)\n\nfunc WithTemperature(t float64) Option {\n\treturn func(c *RequestConfig) { c.Temperature = t }\n}\n\nfunc WithTopP(p float64) Option {\n\treturn func(c *RequestConfig) {\n\t\tc.TopP = p\n\t}\n}\n\nfunc Send(opts ...Option) (*http.Response, error) {\n\tcfg := RequestConfig{Model: \"claude-sonnet-4-5\", MaxTokens: 1024}\n\tfor _, o := range opts {\n\t\to(&cfg)\n\t}\n\tbody, _ := json.Marshal(cfg)\n\treturn http.Post(\"https://api.anthropic.com/v1/messages\", \"application/json\", bytes.NewReader(body))\n}\n" });
    const lines = us.filter((u) => u.params?.some((p: string) => p === "temperature" || p === "top_p")).map((u) => u.line).sort((a, b) => a - b);
    expect(lines).toEqual([12, 13]);
  });
});

describe("Go: a shared request type and a field name don't join providers", () => {
  it("an Ollama package's RequestConfig literal and its own c.Temperature aren't an Anthropic request's; a body helper's key is", async () => {
    const us = await usages({ "go.mod": "module x\n\ngo 1.22\n", "llm/config.go": "package llm\n\ntype RequestConfig struct {\n\tModel       string\n\tTemperature float64\n\tTopP        float64\n}\n", "anthropic/client.go": "package anthropic\n\nimport (\n\t\"bytes\"\n\t\"encoding/json\"\n\t\"net/http\"\n\n\t\"x/llm\"\n)\n\ntype Client struct{ Key string }\n\nfunc (c *Client) Send(cfg *llm.RequestConfig, prompt string) (*http.Response, error) {\n\tbody, _ := json.Marshal(map[string]any{\"model\": cfg.Model, \"max_tokens\": 1024})\n\treq, _ := http.NewRequest(\"POST\", \"https://api.anthropic.com/v1/messages\", bytes.NewReader(body))\n\treq.Header.Set(\"anthropic-version\", \"2023-06-01\")\n\t_ = cfg.Temperature\n\treturn http.DefaultClient.Do(req)\n}\n\nfunc (c *Client) Ask(cfg *llm.RequestConfig) (*http.Response, error) {\n\treturn http.Post(\"https://api.anthropic.com/v1/messages\", \"application/json\", bytes.NewReader(mustJSON(cfg.Temperature)))\n}\n\nfunc mustJSON(v any) []byte { b, _ := json.Marshal(map[string]any{\"temperature\": v}); return b }\n", "ollama/provider.go": "package ollama\n\nimport (\n\t\"bytes\"\n\t\"encoding/json\"\n\t\"net/http\"\n\n\t\"x/llm\"\n)\n\nconst defaultModel = \"llama3\"\n\ntype Client struct {\n\tBaseURL     string\n\tTemperature *float64\n}\n\nfunc New() *Client {\n\ttemp := 0.4\n\tc := &Client{BaseURL: \"http://localhost:11434\"}\n\tc.Temperature = &temp\n\treturn c\n}\n\nfunc (c *Client) Chat(prompt string) (*http.Response, error) {\n\tcfg := &llm.RequestConfig{Model: defaultModel, Temperature: 0.7}\n\tbody, _ := json.Marshal(map[string]any{\"model\": cfg.Model, \"prompt\": prompt, \"options\": map[string]any{\"temperature\": cfg.Temperature}})\n\treturn http.Post(c.BaseURL+\"/api/generate\", \"application/json\", bytes.NewReader(body))\n}\n" });
    expect(us.filter((u) => u.file.startsWith("ollama/") && u.params?.includes("temperature"))).toEqual([]);
    expect(us.some((u) => u.file === "anthropic/client.go" && u.line === 25 && u.params?.includes("temperature"))).toBe(true);
  });
});

describe("a config class's property default in a multi-provider file", () => {
  it("C#: Temperature { get; set; } = 0.7f still reaches the Anthropic request that reads it", async () => {
    const us = await usages({
      "Core/GatewayConfig.cs": "namespace Core;\npublic class LlmProviderConfig\n{\n    // providers: anthropic, openai, ollama (http://localhost:11434)\n    public string Provider { get; set; } = \"anthropic\";\n    public float Temperature { get; set; } = 0.7f;\n}\n",
      "Agent/Runtime.cs": "using Anthropic.SDK;\nusing Anthropic.SDK.Messaging;\nnamespace Agent;\npublic class Runtime\n{\n    private readonly float _temperature;\n    public Runtime(Core.LlmProviderConfig config) { _temperature = config.Temperature; }\n    public async Task Run(AnthropicClient client)\n    {\n        var p = new MessageParameters { Model = \"claude-sonnet-4-5\", MaxTokens = 100, Temperature = (decimal)_temperature };\n        await client.Messages.GetClaudeMessageAsync(p);\n    }\n}\n",
    });
    expect(us.some((u) => u.file === "Core/GatewayConfig.cs" && u.line === 6 && u.params?.includes("temperature"))).toBe(true);
  });
});

describe("follow-ups", () => {
  it("Python: another object's generate(…, temperature=…) and a sibling script's flag aren't the Claude module's", async () => {
    const us = await usages({ "requirements.txt": "langchain-anthropic>=0.3\ntransformers\n", "scripts/router.py": "from langchain_anthropic import ChatAnthropic\n\n\ndef generate(prompt, temperature=0.3):\n    llm = ChatAnthropic(model=\"claude-sonnet-4-5\", temperature=temperature)\n    return llm.invoke(prompt).content\n", "scripts/train.py": "import argparse\nfrom transformers import AutoModelForCausalLM, AutoTokenizer\n\nparser = argparse.ArgumentParser()\nparser.add_argument(\"--temperature\", type=float, default=0.1)\nargs = parser.parse_args()\n\nmodel = AutoModelForCausalLM.from_pretrained(\"gpt2\")\ntok = AutoTokenizer.from_pretrained(\"gpt2\")\nout = model.generate(tok(\"hi\", return_tensors=\"pt\").input_ids, temperature=1.0, do_sample=True)\n", "scripts/cli.py": "import argparse\nfrom router import generate\n\nparser = argparse.ArgumentParser()\nparser.add_argument(\"--temperature\", type=float, default=0.1)\nargs = parser.parse_args()\nprint(generate(\"hi\", temperature=args.temperature))\n", "scripts/other_cli.py": "import argparse\n\nparser = argparse.ArgumentParser()\nparser.add_argument(\"--temperature\", type=float, default=0.5)\nargs = parser.parse_args()\n" });
    const t = us.filter((u) => u.params?.includes("temperature") && u.op === "POST /v1/messages").map((u) => `${u.file}:${u.line}`);
    expect(t.filter((x) => x.startsWith("scripts/train.py") || x.startsWith("scripts/other_cli.py"))).toEqual([]);
    expect(t).toContain("scripts/cli.py:7");
  });
  it("Go: an Ollama package's Client.Temperature isn't the root package's same-named Client; option setters in closures aren't defaults", async () => {
    const us = await usages({ "go.mod": "module x\n\ngo 1.22\n\nrequire github.com/anthropics/anthropic-sdk-go v1.0.0\n", "agent/api.go": "package agent\n\nimport (\n\t\"bytes\"\n\t\"encoding/json\"\n\t\"net/http\"\n)\n\ntype Config struct {\n\tProvider    string\n\tModel       string\n\tTemperature *float64\n\tTopP        *float64\n}\n\ntype Option func(*Config)\n\nfunc WithTemperature(t float64) Option {\n\treturn func(c *Config) { c.Temperature = &t }\n}\n\nfunc WithTopP(p float64) Option {\n\treturn func(c *Config) {\n\t\tc.TopP = &p\n\t}\n}\n\ntype claudeRequest struct {\n\tModel       string   `json:\"model\"`\n\tMaxTokens   int      `json:\"max_tokens\"`\n\tTemperature *float64 `json:\"temperature,omitempty\"`\n\tTopP        *float64 `json:\"top_p,omitempty\"`\n}\n\nfunc Call(c *Config, prompt string) (*http.Response, error) {\n\tswitch c.Provider {\n\tcase \"anthropic\":\n\t\treq := claudeRequest{Model: c.Model, MaxTokens: 1024}\n\t\treq.Temperature = c.Temperature\n\t\treq.TopP = c.TopP\n\t\tb, _ := json.Marshal(req)\n\t\treturn http.Post(\"https://api.anthropic.com/v1/messages\", \"application/json\", bytes.NewReader(b))\n\tdefault:\n\t\tb, _ := json.Marshal(map[string]any{\"model\": c.Model, \"temperature\": c.Temperature})\n\t\treturn http.Post(\"https://api.openai.com/v1/chat/completions\", \"application/json\", bytes.NewReader(b))\n\t}\n}\n", "agent/claude.go": "package agent\n\nimport (\n\t\"context\"\n\n\t\"github.com/anthropics/anthropic-sdk-go\"\n)\n\nfunc Ask(ctx context.Context, client anthropic.Client, c *Client, prompt string) (*anthropic.Message, error) {\n\treturn client.Messages.New(ctx, anthropic.MessageNewParams{\n\t\tModel:       anthropic.Model(c.Model),\n\t\tMaxTokens:   1024,\n\t\tTemperature: anthropic.Float(*c.Temperature),\n\t\tMessages:    []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(prompt))},\n\t})\n}\n", "agent/model/ollama/ollama.go": "package ollama\n\nimport (\n\t\"bytes\"\n\t\"encoding/json\"\n\t\"net/http\"\n)\n\ntype Client struct {\n\tBaseURL     string\n\tTemperature *float64\n}\n\nfunc New(base string) *Client {\n\ttemp := 0.4\n\tc := &Client{BaseURL: base}\n\tc.Temperature = &temp\n\treturn c\n}\n\nfunc (c *Client) Generate(prompt string) (*http.Response, error) {\n\tb, _ := json.Marshal(map[string]any{\"model\": \"llama3\", \"prompt\": prompt, \"options\": map[string]any{\"temperature\": c.Temperature}})\n\treturn http.Post(c.BaseURL+\"/api/generate\", \"application/json\", bytes.NewReader(b))\n}\n", "agent/new.go": "package agent\n\nfunc NewClient() *Client {\n\tt := 0.6\n\tc := &Client{Provider: \"anthropic\", Model: \"claude-sonnet-4-5\"}\n\tc.Temperature = &t\n\treturn c\n}\n" });
    const t = us.filter((u) => u.params?.some((p: string) => p === "temperature" || p === "top_p")).map((u) => `${u.file}:${u.line}`);
    expect(t.filter((x) => x.startsWith("agent/model/ollama/"))).toEqual([]);
    expect(t.filter((x) => /agent\/api\.go:(?:18|19|22|23|24)$/.test(x))).toEqual([]);
    expect(t).toContain("agent/new.go:6");
  });
});

describe("CSS attribute selectors aren't requests", () => {
  it("query_selector_all(\"a[href*='/search/']\") next to an OpenAI base", async () => {
    const us = await usages({ "crawl/scrape.py": 'BASE = "https://api.openai.com/v1"\n\n\nasync def links(page):\n    a = await page.query_selector_all("a[href*=\'/search/\']")\n    b = await page.query_selector_all(\'a[href^="/assistants"]\')\n    return BASE + "/search" if a else b\n' });
    expect(us.filter((u) => u.line === 5 || u.line === 6).filter((u) => u.op)).toEqual([]);
  });
});
