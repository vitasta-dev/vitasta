import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 60_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-gotag-"));
  for (const [p, t] of Object.entries({ "go.mod": "module example.com/app\n\ngo 1.22\n", ...files })) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};
const call = (setup: string, params: string) => `package main

import "github.com/openai/openai-go"

func main() {
${setup}
	client := openai.NewClient()
	client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{${params}})
}
`;

describe("Go struct-tag and viper defaults for settings that reach a provider request", () => {
  it("caarlos0/env envDefault: the model and sampling defaults are found at the tag, the model by name", async () => {
    const us = await scan({
      "config.go": "package main\n\ntype Config struct {\n\tModel string  `env:\"OPENAI_MODEL\" envDefault:\"gpt-4o\"`\n\tTemp  float64 `env:\"TEMP\" envDefault:\"0.7\"`\n\tPort  int     `env:\"PORT\" envDefault:\"8080\"`\n}\n",
      "main.go": call("\tcfg := Config{}\n\tenv.Parse(&cfg)", "Model: openai.ChatModel(cfg.Model), Temperature: openai.Float(cfg.Temp)"),
    });
    const model = us.find((u) => u.file === "config.go" && u.line === 4);
    expect(model).toMatchObject({ provider: "openai", model: "gpt-4o", params: ["model"], setting: true });
    expect(model.modelSpan.kind).toBe("string");
    expect(us.find((u) => u.file === "config.go" && u.line === 5)?.params).toEqual(["temperature"]);
    // the port default doesn't reach a provider: not reported
    expect(us.some((u) => u.file === "config.go" && u.line === 6)).toBe(false);
  });
  it("kelseyhightower/envconfig and creasty/defaults `default:` tags, a var-declared and a new()-made config", async () => {
    const files = { "config.go": "package main\n\ntype Config struct {\n\tModel string  `default:\"gpt-4o\" envconfig:\"MODEL\"`\n\tTopP  float64 `default:\"0.9\"`\n}\n" };
    for (const setup of ["\tvar cfg Config\n\tenvconfig.Process(\"app\", &cfg)", "\tcfg := new(Config)\n\tdefaults.Set(cfg)"]) {
      const us = await scan({ ...files, "main.go": call(setup, "Model: openai.ChatModel(cfg.Model), TopP: openai.Float(cfg.TopP)") });
      expect(us.find((u) => u.file === "config.go" && u.line === 4)).toMatchObject({ model: "gpt-4o" });
      expect(us.find((u) => u.file === "config.go" && u.line === 5)?.params).toEqual(["top_p"]);
    }
  });
  it("a nested config struct (cfg.OpenAI.Model)", async () => {
    const us = await scan({
      "config.go": "package main\n\ntype Config struct {\n\tOpenAI OpenAIConfig\n}\ntype OpenAIConfig struct {\n\tModel string `envDefault:\"gpt-4o\"`\n}\n",
      "main.go": call("\tcfg := new(Config)", "Model: openai.ChatModel(cfg.OpenAI.Model)"),
    });
    expect(us.find((u) => u.file === "config.go" && u.line === 7)).toMatchObject({ model: "gpt-4o" });
  });
  it("viper.SetDefault for a field read through its mapstructure tag", async () => {
    const us = await scan({
      "config.go": "package main\n\ntype LLM struct {\n\tModel string `mapstructure:\"model\"`\n\tTemperature float64 `mapstructure:\"temperature\"`\n}\n\nfunc load() {\n\tviper.SetDefault(\"llm.model\", \"gpt-4o\")\n\tviper.SetDefault(\"llm.temperature\", 0.3)\n}\n",
      "main.go": call("\tl := &LLM{}", "Model: openai.ChatModel(l.Model), Temperature: openai.Float(l.Temperature)"),
    });
    expect(us.some((u) => u.file === "config.go" && u.line === 9 && u.model === "gpt-4o")).toBe(true);
    expect(us.find((u) => u.file === "config.go" && u.line === 10 && u.params?.includes("temperature"))).toBeTruthy();
  });
  it("an API version in a tag default reaches the URL built from it (a Graph version)", async () => {
    const us = await scan({
      "config.go": "package main\n\ntype Config struct {\n\tGraphVersion string `env:\"GRAPH_VERSION\" envDefault:\"v19.0\"`\n}\n",
      "main.go": "package main\n\nimport \"net/http\"\n\nfunc main() {\n\tcfg := Config{}\n\turl := \"https://graph.facebook.com/\" + cfg.GraphVersion + \"/me/accounts\"\n\thttp.Get(url)\n}\n",
    });
    expect(us.find((u) => u.file === "config.go" && u.line === 4)).toMatchObject({ kind: "version-pin", apiVersion: "url: v19.0" });
  });
  it("nothing else changes: a tag default that no provider request reads, and a request with its own literal", async () => {
    const own = call("\tcfg := Config{}\n\t_ = cfg", 'Model: "gpt-4.1"');
    const cfg = "package main\n\ntype Config struct {\n\tModel string `envDefault:\"gpt-4o\"`\n}\n";
    const withTag = await scan({ "config.go": cfg, "main.go": own });
    const without = await scan({ "config.go": "package main\n\ntype Config struct {\n\tModel string\n}\n", "main.go": own });
    expect(withTag.map((u) => [u.file, u.line, u.model, u.params?.join()])).toEqual(without.map((u) => [u.file, u.line, u.model, u.params?.join()]));
  });
});
