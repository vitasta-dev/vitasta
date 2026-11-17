import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ApiMap, ChangeRecord, Usage } from "../src/types.js";

let map: ApiMap;
const at = (file: string, line: number): Usage | undefined => map.usages.find((u) => u.file === file && u.line === line);

beforeAll(async () => {
  map = await scanRepo(resolve(import.meta.dirname, "fixtures/cloud"));
});

describe("Bedrock and Vertex model IDs", () => {
  it("recognises Bedrock cross-region IDs and ARNs as Anthropic on Bedrock", () => {
    expect(at("lab/config.py", 2)).toMatchObject({ provider: "anthropic", kind: "model-ref", host: "bedrock", model: "us.anthropic.claude-sonnet-4-20250514-v1:0" });
    expect(at("lab/config.py", 3)).toMatchObject({ provider: "anthropic", host: "bedrock" });
  });

  it("recognises Claude on Vertex through AnthropicVertex and @version IDs", () => {
    expect(at("lab/agents.py", 8)).toMatchObject({ provider: "anthropic", kind: "sdk", host: "vertex", model: "claude-sonnet-4-5@20250929" });
  });

  it("tells Gemini on Vertex (vertexai=True) from the Gemini API", () => {
    expect(at("lab/agents.py", 19)).toMatchObject({ provider: "google", kind: "sdk", host: "vertex", model: "gemini-2.5-flash" });
    const api = at("web/gemini.ts", 6);
    expect(api).toMatchObject({ provider: "google", kind: "sdk", model: "gemini-2.0-flash" });
    expect(api?.host).toBeUndefined();
  });
});

describe("Bedrock calls", () => {
  it("reads boto3 bedrock-runtime converse(modelId=...)", () => {
    expect(at("aws/converse.py", 8)).toMatchObject({
      provider: "anthropic", kind: "sdk", host: "bedrock", confidence: "certain",
      op: "POST /model/{modelId}/converse", model: "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    });
  });

  it("reads framework constructors that take model_id (LangChain, Strands)", () => {
    expect(at("aws/converse.py", 14)).toMatchObject({ provider: "anthropic", kind: "sdk", host: "bedrock", confidence: "likely" });
    expect(at("aws/converse.py", 14)?.params).toContain("temperature");
  });

  it("reads AWS SDK v3 ConverseCommand with a model constant", () => {
    expect(at("aws/invoke.ts", 7)).toMatchObject({
      provider: "anthropic", kind: "sdk", host: "bedrock", confidence: "certain", sdkCall: "ConverseCommand",
      model: "global.anthropic.claude-sonnet-4-20250514-v1:0",
    });
  });

  it("doesn't also report those model IDs as loose references", () => {
    expect(map.usages.filter((u) => u.file.startsWith("aws/") && u.kind === "model-ref")).toEqual([]);
  });
});

describe("config files", () => {
  it("finds model IDs in YAML config, and only real model IDs", () => {
    const refs = map.usages.filter((u) => u.file === "lab/models.yml");
    // "name: claude-sonnet-4" is a label, not a setting; model_id on line 3 is the setting
    expect(refs.map((u) => `${u.line}:${u.model}`)).toEqual(["3:eu.anthropic.claude-sonnet-4-20250514-v1:0"]);
    expect(refs[0]).toMatchObject({ lang: "config", host: "bedrock", confidence: "possible" });
  });
});

describe("host-specific schedules", () => {
  const feed: ChangeRecord[] = [
    // Anthropic's own API retired Sonnet 4 on 2026-06-15; Bedrock on 2026-10-14
    { id: "api", provider: "anthropic", type: "model_retirement", title: "x", selector: { models: ["claude-sonnet-4-20250514"] }, effective: "2026-06-15", trigger: "date", sources: [] },
    { id: "bedrock", provider: "anthropic", type: "model_retirement", title: "x", selector: { models: ["anthropic.claude-sonnet-4-20250514-v1:0"], hosts: ["bedrock"] }, effective: "2026-10-14", trigger: "date", sources: [] },
    { id: "bedrock-37", provider: "anthropic", type: "model_retirement", title: "x", selector: { models: ["anthropic.claude-3-7-sonnet-20250219-v1:0"], hosts: ["bedrock"] }, effective: "2026-11-13", trigger: "date", sources: [] },
    { id: "vertex-claude", provider: "anthropic", type: "model_retirement", title: "x", selector: { models: ["claude-sonnet-4-5", "claude-sonnet-4-5@*"], hosts: ["vertex"] }, effective: "2026-11-30", trigger: "date", sources: [] },
    { id: "vertex-gemini", provider: "google", type: "model_retirement", title: "x", selector: { models: ["gemini-2.5-flash"], hosts: ["vertex"] }, effective: "2026-10-20", trigger: "date", sources: [] },
    { id: "gemini-api", provider: "google", type: "model_retirement", title: "x", selector: { models: ["gemini-2.0-flash"] }, effective: "2026-12-01", earliest: true, trigger: "date", sources: [] },
    { id: "gemini-api-25", provider: "google", type: "model_retirement", title: "x", selector: { models: ["gemini-2.5-flash"] }, effective: "2027-06-01", trigger: "date", sources: [] },
  ];
  const ids = () => findImpacts(map, feed, "2026-11-13").map((f) => `${f.change.id}@${f.usage.file}:${f.usage.line}:${f.status}`).sort();

  it("applies each host's own dates and never the provider's to hosted models", () => {
    expect(ids()).toEqual([
      "bedrock-37@aws/converse.py:8:broken",
      "bedrock-37@lab/config.py:3:broken",
      "bedrock@aws/invoke.ts:7:broken",
      "bedrock@lab/config.py:2:broken",
      "bedrock@lab/models.yml:3:broken",
      "gemini-api@web/gemini.ts:6:urgent",
      "vertex-claude@lab/agents.py:8:urgent",
      "vertex-gemini@lab/agents.py:19:broken",
    ]);
  });
});
