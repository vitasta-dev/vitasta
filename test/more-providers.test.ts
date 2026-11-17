import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { queryOf } from "../src/feed/lookup.js";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ApiMap, ChangeRecord, Usage } from "../src/types.js";

let map: ApiMap;
const at = (file: string, line: number): Usage | undefined => map.usages.find((u) => u.file === file && u.line === line);

beforeAll(async () => {
  map = await scanRepo(resolve(import.meta.dirname, "fixtures/more-providers"));
});

const sunset = (provider: string, v: string, effective: string): ChangeRecord => ({
  id: `${provider}-${v}`, provider, type: "version_sunset", title: `${provider} ${v}`, selector: { versions: [v] }, effective, trigger: "date", sources: [{ url: "https://example.com" }],
});
const retire = (provider: string, model: string, effective: string): ChangeRecord => ({
  id: `${provider}-${model}`, provider, type: "model_retirement", title: model, selector: { models: [model] }, effective, trigger: "date", sources: [{ url: "https://example.com" }],
});

describe("Meta: Marketing API vs Graph API on the same host", () => {
  it("gives act_ paths and the Business SDK to the Marketing API, other Graph calls to Meta", () => {
    expect(at("graph.ts", 1)).toMatchObject({ provider: "meta-marketing", kind: "http", apiVersion: "url: v24.0" });
    expect(at("graph.ts", 3)).toMatchObject({ provider: "meta-marketing" });
    expect(at("graph.ts", 2)).toMatchObject({ provider: "meta", op: "GET /v24.0/me" });
    expect(at("ads.py", 3)).toMatchObject({ provider: "meta-marketing", kind: "version-pin", apiVersion: "api_version: v24.0" });
  });

  it("applies each schedule only to its own calls", () => {
    const feed = [sunset("meta-marketing", "v24.0", "2026-11-10"), sunset("meta", "v24.0", "2028-02-18")];
    const f = findImpacts(map, feed, "2026-11-17");
    const dateAt = (file: string, line: number) => f.filter((x) => x.usage.file === file && x.usage.line === line).map((x) => x.change.effective);
    expect(dateAt("graph.ts", 1)).toEqual(["2026-11-10"]);
    expect(dateAt("graph.ts", 2)).toEqual(["2028-02-18"]);
    expect(dateAt("ads.py", 3)).toEqual(["2026-11-10"]);
  });
});

describe("Google Ads, Together, OpenRouter", () => {
  it("finds Google Ads versions in the Python client and REST URLs", () => {
    expect(at("gads.py", 2)).toMatchObject({ provider: "googleads", kind: "version-pin", apiVersion: "version: v23" });
    expect(at("gads_rest.js", 1)).toMatchObject({ provider: "googleads", kind: "http", apiVersion: "url: v23" });
  });

  it("finds Together and OpenRouter (through the OpenAI SDK) calls with their model IDs", () => {
    expect(at("tog.py", 3)).toMatchObject({ provider: "together", kind: "sdk", model: "MiniMaxAI/MiniMax-M3" });
    expect(at("orouter.ts", 3)).toMatchObject({ provider: "openrouter", kind: "sdk", model: "z-ai/glm-5.1", viaSdk: "openai" });
    const f = findImpacts(map, [retire("together", "MiniMaxAI/MiniMax-M3", "2026-11-06"), retire("openrouter", "z-ai/glm-5.1", "2026-11-20")], "2026-11-17");
    expect(f.map((x) => x.change.provider).sort()).toEqual(["openrouter", "together"]);
  });

  it("doesn't take a local Hugging Face model name for a hosted model", () => {
    expect(map.usages.filter((u) => u.file === "hf.py")).toEqual([]);
  });
});

describe("lookup privacy for org/model IDs", () => {
  it("sends public IDs of known orgs and drops a company's own model names", () => {
    const u = (provider: string, model: string): Usage => ({ provider, kind: "sdk", model, lang: "py", file: "f", line: 1, confidence: "certain", snippet: "" });
    const q = queryOf([u("together", "MiniMaxAI/MiniMax-M3"), u("openrouter", "z-ai/glm-5.1:free"), u("together", "acme-corp/our-secret-finetune"), u("openrouter", "mycompany/router-model")]);
    expect(q.map((x) => x.model)).toEqual(["MiniMaxAI/MiniMax-M3", "z-ai/glm-5.1:free", undefined, undefined]);
  });
});

describe("model settings found in the 30 Nov repo count", () => {
  it("a model ID that's the default of a flag named like a model setting (Go)", () => {
    expect(at("setup.go", 4)).toMatchObject({ provider: "anthropic", kind: "model-ref", model: "claude-sonnet-4-5-20250929" });
    expect(at("setup.go", 5)).toBeUndefined();
  });

  it("provider-prefixed IDs as frameworks write them, with the route's host", () => {
    expect(at("agent.py", 4)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(at("agent.py", 4)?.modelSpan).toBeUndefined(); // a fix PR must not drop the prefix
    expect(at("agent.py", 7)).toMatchObject({ provider: "anthropic", host: "bedrock", model: "anthropic.claude-sonnet-4-5-20250929-v1:0" });
    expect(at("litellm.yaml", 4)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("leaves prefixed IDs alone in a file that uses a router (OpenRouter's IDs look the same)", () => {
    expect(map.usages.filter((u) => u.file === "routed.go")).toEqual([]);
  });
});

describe("OpenAI prompt objects", () => {
  const record: ChangeRecord = {
    id: "openai-responses-prompt-objects-2026-11-30", provider: "openai", type: "param_removed", title: "prompt objects",
    selector: { ops: ["POST /v1/responses"], params: ["prompt"] }, effective: "2026-11-30", trigger: "date", sources: [{ url: "https://example.com" }],
  };

  it("finds prompt={id: …} in Responses calls (Python and TypeScript)", () => {
    const f = findImpacts(map, [record], "2026-11-17").map((x) => `${x.usage.file}:${x.usage.line}`).sort();
    expect(f).toEqual(["prompts.py:4", "prompts.ts:5", "tutor.ts:2", "tutor.ts:3"]);
  });

  it("counts a quoted pmpt_ ID kept in a constant, but not pmpt_ variable names", () => {
    expect(at("tutor.ts", 2)).toMatchObject({ provider: "openai", op: "POST /v1/responses", params: ["prompt"], resource: "OpenAI prompt object" });
    expect(at("tutor.ts", 4)).toBeUndefined();
    // the ID inside a call that's already found isn't reported twice
    expect(at("prompts.ts", 3)).toBeUndefined();
    expect(at("prompts.ts", 7)).toBeUndefined();
  });
});

describe("tables and catalogs (false positives from the 30 Nov repo count)", () => {
  it("a model ID as a lookup-table key (colours, sizes, prices) isn't a use", () => {
    expect(at("tables.ts", 2)).toBeUndefined();
    expect(at("tables.ts", 3)).toBeUndefined();
    expect(at("tables.py", 2)).toBeUndefined();
    expect(at("tables.py", 5)).toBeUndefined();
  });

  it("catalogs, pickers, model lists, types and alias maps are reported as listed, not as calls", () => {
    for (const [file, line] of [["tables.ts", 6], ["tables.ts", 9], ["tables.ts", 11], ["tables.py", 8], ["tables.py", 11]] as const) {
      expect(at(file, line), `${file}:${line}`).toMatchObject({ provider: "anthropic", listed: true });
    }
  });

  it("settings stay live: a default parameter, and an agent config that only has a name", () => {
    expect(at("tables.py", 14)).toMatchObject({ provider: "anthropic", host: "vertex" });
    expect(at("tables.py", 14)?.listed).toBeUndefined();
    expect(at("tables.ts", 12)?.listed).toBeUndefined();
    expect(at("tables.ts", 12)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("a listed model never fails a PR check", async () => {
    const { canBlock } = await import("../src/check.js");
    const rec = { id: "r", provider: "anthropic", type: "model_retirement", title: "t", selector: { models: ["claude-sonnet-4-5-20250929"] }, effective: "2026-11-01", trigger: "date", sources: [] } as ChangeRecord;
    const listed = findImpacts(map, [rec], "2026-11-17").filter((f) => f.usage.file === "tables.ts");
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((f) => f.usage.listed && !canBlock(f))).toBe(true);
  });
});
