import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { Change } from "../src/types.js";

const scan = () => scanRepo(resolve(import.meta.dirname, "fixtures/tuning"));
const refs = async (file: string) =>
  (await scan()).usages
    .filter((u) => u.file === file && u.kind === "model-ref")
    .map((u) => `${u.line} ${u.model}${u.listed ? " (listed)" : ""}${u.host ? ` @${u.host}` : ""}${u.via ? ` via ${u.via}` : ""}`);

describe("where a model runs, from the code around it", () => {
  it("an entry's provider field, a GitHub Models entry; display labels aren't models", async () => {
    expect(await refs("platforms.ts")).toEqual([
      "2 o4-mini (listed) @azure",
      "3 gpt-4.1 (listed) @azure",
      "6 o1-mini (listed) via GitHub Models",
      "7 gpt-4o (listed) via GitHub Models",
      "9 gpt-4o (listed)",
      "9 gpt-4o-mini (listed)",
      // a name holding "demo" inside a word (ClaudeModel) is still a model type
      "10 claude-opus-4-5 (listed)",
      "10 claude-sonnet-4-5 (listed)",
    ]);
  });
  it("a file for a platform: providers/azure/…, a Copilot provider", async () => {
    expect(await refs("providers/azure/models.ts")).toEqual(["1 gpt-4o (listed) @azure", "1 gpt-4.1 (listed) @azure"]);
    expect(await refs("copilotProvider.ts")).toEqual(["1 gpt-4o (listed) via GitHub Copilot", "1 o3-mini (listed) via GitHub Copilot"]);
  });
  it("an Azure branch; a settings-class default; not prefix or substring tests", async () => {
    expect(await refs("judge.py")).toEqual(["6 gpt-4o-2024-11-20", "9 gpt-4o-2024-08-06 @azure", "13 gpt-4.1-mini"]);
  });
  it("a model reached through something that isn't the provider's API gets none of the provider's retirements", async () => {
    const map = await scan();
    const change: Change = {
      id: "openai-gpt-4o-test", provider: "openai", type: "model_retirement", title: "gpt-4o retires", announced: "2026-01-01",
      effective: "2026-12-01", source: "https://example.com", selector: { models: ["gpt-4o"] },
    } as Change;
    const files = findImpacts(map, [change], "2026-11-18").map((f) => f.usage.file);
    expect(files).toContain("platforms.ts");
    expect(files).not.toContain("copilotProvider.ts");
    expect(files.filter((f) => f === "platforms.ts")).toHaveLength(1);
  });
});

describe("data about models isn't a use of them", () => {
  it("a capability table's model lists, a vendored copy of another project, a retirement knowledge base", async () => {
    // a capability matrix and a set only used in .has() checks are data; a picker list and a model setting count
    expect(await refs("compat.ts")).toEqual([
      "9 gpt-4o (listed)",
      "9 gpt-4.1 (listed)",
      "13 gemini-2.5-flash",
    ]);
    // The vendored copy is really there (so this tests the rule, not a missing file)
    expect(existsSync(resolve(import.meta.dirname, "fixtures/tuning/docs/other/some-chat-app-main/config.ts"))).toBe(true);
    expect(await refs("docs/other/some-chat-app-main/config.ts")).toEqual([]);
    expect(await refs("knowledge/changes/claude-3-opus.yaml")).toEqual([]);
  });
  it("a list another file only tests names against is a capability list; a list another file offers counts", async () => {
    expect(await refs("ttsModels.ts")).toEqual(["2 gpt-4o (listed)", "2 gpt-4o-mini (listed)"]);
  });
  it("a model-info registry keyed by ID counts; a price table keyed by ID doesn't", async () => {
    expect(await refs("registry.ts")).toEqual(["2 claude-3-opus-20240229 (listed)", "3 claude-sonnet-4-5 (listed)"]);
  });
  it("a registry of constructor rows: ModelInfo(id=…); a model config picked by ID, not a price looked up", async () => {
    expect(await refs("catalog.py")).toEqual(["2 gpt-5.3-codex (listed)", "3 gpt-4o (listed)", "6 gpt-4o-mini"]);
  });
});

describe("defaults of model-named flags and options", () => {
  it("getArg('--model', …), .option('judge-model', { default }), z.string().default(…), a model object's id, an embedder; not a user's id", async () => {
    expect(await refs("cli.js")).toEqual(["1 claude-sonnet-4-5-20250929", "2 gpt-4o-mini", "3 gpt-4o", "4 gpt-5.1-codex", "5 text-embedding-004"]);
  });
  it("YAML: a model under the provider's own block counts; an Azure deployment name is on Azure", async () => {
    expect(await refs("image.yaml")).toEqual(["2 gpt-image-1", "5 gpt-image-1 @azure"]);
  });

  it("a property descriptor's default for a model setting, including a resource locator's { mode, value }", async () => {
    expect(await refs("nodeProperties.ts")).toEqual(["7 claude-sonnet-4-5-20250929", "9 claude-3-5-haiku-20241022"]);
  });
});
