import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ApiMap, ChangeRecord, Usage } from "../src/types.js";

const FILE = "src/main/java/com/acme/Assistant.java";
let map: ApiMap;
const at = (line: number): Usage | undefined => map.usages.find((u) => u.file === FILE && u.line === line);

beforeAll(async () => {
  map = await scanRepo(resolve(import.meta.dirname, "fixtures/java"));
});

describe("Java", () => {
  it("reads SDKs from pom.xml", () => {
    expect(map.sdks.map((s) => `${s.name}@${s.version}`).sort()).toEqual(["com.anthropic:anthropic-java@1.2.0", "com.openai:openai-java@2.0.0"]);
  });

  it("follows a client field into messages().create(params) and reads the params builder", () => {
    expect(at(28)).toMatchObject({ provider: "anthropic", kind: "sdk", op: "POST /v1/messages", sdkCall: "messages.create", model: "claude-3-5-sonnet-20241022", confidence: "certain" });
    expect(at(28)?.params).toEqual(expect.arrayContaining(["max_tokens", "temperature"]));
  });

  it("maps SDK enum constants to the exact model ID (ChatModel.GPT_4_1 → gpt-4.1)", () => {
    expect(at(32)).toMatchObject({ provider: "openai", sdkCall: "chat.completions.create", model: "gpt-4.1" });
  });

  it("reads raw HttpClient calls built from a URL constant, and the version header on its own line", () => {
    expect(at(39)).toMatchObject({ kind: "http", provider: "anthropic", op: "POST /v1/messages" });
    expect(at(40)).toMatchObject({ kind: "version-pin", apiVersion: "anthropic-version: 2023-06-01" });
  });

  it("reads Bedrock ConverseRequest.modelId(...)", () => {
    expect(at(46)).toMatchObject({ provider: "anthropic", host: "bedrock", model: "us.anthropic.claude-sonnet-4-20250514-v1:0" });
  });

  it("matches the Anthropic parameter removal using Java's camelCase setters", () => {
    const change: ChangeRecord = {
      id: "params", provider: "anthropic", type: "param_removed", title: "x",
      selector: { ops: ["POST /v1/messages"], params: ["temperature", "top_p", "top_k"] }, effective: "2026-10-21", trigger: "upgrade", sources: [],
    };
    expect(findImpacts(map, [change], "2026-11-13").map((f) => f.usage.line)).toEqual([28]);
  });
});
