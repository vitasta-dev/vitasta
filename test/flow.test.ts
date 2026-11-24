import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Item 4/F: one value tracer for every language (src/scan/flow.ts): Go and Java cases from the dev sets
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-goflow-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const temps = async (files: Record<string, string>) =>
  // each place a fix sees: a finding's line or one of its alsoLines (in-between lines of a chain are alsoLines)
  ((await scanRepo(await repo(files))).usages as any[]).filter((u) => u.params?.includes("temperature") && u.provider === "anthropic").flatMap((u) => [u.line, ...(u.alsoLines ?? [])].map((l: number) => `${u.file}:${l}`));

const provider = `package llm

import "github.com/anthropics/anthropic-sdk-go"

type Request struct {
	Model       string
	Temperature float64
}

func Send(req Request) anthropic.MessageNewParams {
	params := anthropic.MessageNewParams{MaxTokens: 100}
	params.Temperature = anthropic.Float(req.Temperature)
	return params
}
`;

describe("Go: a repo's own request type forwarded to an SDK params field", () => {
  it("the request type's literal, and a functional option's argument", async () => {
    const caller = `package app

import "x/llm"

type Agent struct{ temperature float64 }

func WithTemperature(t float64) func(*Agent) { return func(a *Agent) { a.temperature = t } }

func (a *Agent) Ask() { llm.Send(llm.Request{Model: "claude-x", Temperature: a.temperature}) }

func New() *Agent { a := &Agent{}; WithTemperature(0.3)(a); return a }

func Summary() { llm.Send(llm.Request{Temperature: 0.4}) }
`;
    const r = await temps({ "go.mod": "module x\n", "llm/send.go": provider, "app/agent.go": caller });
    expect(r).toEqual(expect.arrayContaining(["llm/send.go:12", "app/agent.go:9", "app/agent.go:7", "app/agent.go:11", "app/agent.go:13"]));
  });
  it("a cobra flag default through a config getter", async () => {
    const cfg = `package llm

type Config struct{ Temperature float64 }

func (c *Config) GetTemperature() float64 { return c.Temperature }

type Client struct{ temperature float64 }

func (c *Client) Configure(cfg *Config) { c.temperature = cfg.GetTemperature() }
`;
    const client = `package llm

import "github.com/anthropics/anthropic-sdk-go"

func (c *Client) Params() anthropic.MessageNewParams {
	params := anthropic.MessageNewParams{MaxTokens: 100}
	params.Temperature = anthropic.Float(c.temperature)
	return params
}
`;
    const cmd = `package cmd

import "x/llm"

var temperature float64

func init() {
	addCmd.Flags().Float64VarP(&temperature, "temperature", "t", 0.7, "sampling temperature")
}

func save() { _ = llm.Config{Temperature: temperature} }
`;
    const r = await temps({ "go.mod": "module x\n", "llm/config.go": cfg, "llm/client.go": client, "cmd/add.go": cmd });
    expect(r).toEqual(expect.arrayContaining(["llm/client.go:7", "cmd/add.go:8", "cmd/add.go:11"]));
  });
});

const pins = async (files: Record<string, string>) =>
  ((await scanRepo(await repo(files))).usages as any[]).filter((u) => u.apiVersion?.startsWith("url: ")).flatMap((u) => [u.line, ...(u.alsoLines ?? [])].map((l: number) => `${u.file}:${l}:${u.apiVersion}`));

describe("Java: values traced to consts, config defaults and constant records", () => {
  it("a setting's fallback constant (setting mode)", async () => {
    const java = `package a;\nimport com.anthropic.models.messages.MessageCreateParams;\nclass Llm {\n    private static final double DEFAULT_TEMPERATURE = 0.7;\n    MessageCreateParams p(Config c) {\n        return MessageCreateParams.builder()\n            .model("claude-x")\n            .temperature(resolve(c))\n            .build();\n    }\n    private double resolve(Config c) { return c.getTemperature() != null ? c.getTemperature() : DEFAULT_TEMPERATURE; }\n}\n`;
    expect(await temps({ "src/Llm.java": java })).toEqual(expect.arrayContaining(["src/Llm.java:4"]));
  });
  it("a URL from a getter whose field comes from a config option's default (value mode)", async () => {
    const opts = `package a;\npublic class Options {\n    public static final Option<String> API_VERSION =\n        Options.key("api_version")\n            .stringType()\n            .defaultValue("v23.0");\n    public static final Option<String> ENDPOINT = Options.key("endpoint").stringType().defaultValue("https://graph.facebook.com");\n}\n`;
    const params = `package a;\npublic class Params {\n    private String apiVersion;\n    private String apiEndpoint;\n    public Params(ReadonlyConfig config) {\n        this.apiVersion = config.get(Options.API_VERSION);\n        this.apiEndpoint = config.get(Options.ENDPOINT);\n    }\n}\n`;
    const client = `package a;\npublic class Client {\n    private final Params params;\n    public Client(Params params) { this.params = params; }\n    public void go() {\n        String url =\n            params.getApiEndpoint()\n                + "/"\n                + params.getApiVersion()\n                + "/act_1/campaigns";\n    }\n}\n`;
    const r = await pins({ "src/Options.java": opts, "src/Params.java": params, "src/Client.java": client });
    expect(r).toEqual(expect.arrayContaining(["src/Client.java:9:url: v23.0"]));
    expect(r.some((x) => x.startsWith("src/Options.java:") && x.endsWith("v23.0"))).toBe(true);
  });
  it("a version chosen through record constants (DEFAULT = LATEST = V25_0)", async () => {
    const ver = `package a;\npublic record ApiVersion(String version) {\n    public static final ApiVersion V24_0 = new ApiVersion("v24.0");\n    public static final ApiVersion V25_0 = new ApiVersion("v25.0");\n    public static final ApiVersion LATEST = V25_0;\n    public static final ApiVersion DEFAULT = LATEST;\n}\n`;
    const client = `package a;\npublic class Api {\n    private final java.net.URI base;\n    public Api(String apiVersion) {\n        this.base = java.net.URI.create("https://graph.facebook.com/" + apiVersion + "/");\n    }\n}\n`;
    const make = `package a;\npublic class Make {\n    Api build() {\n        return new Api(ApiVersion.DEFAULT.version());\n    }\n}\n`;
    const r = await pins({ "src/ApiVersion.java": ver, "src/Api.java": client, "src/Make.java": make });
    expect(r).toEqual(expect.arrayContaining(["src/Api.java:5:url: v25.0", "src/ApiVersion.java:4:url: v25.0", "src/Make.java:4:url: v25.0"]));
  });
});

