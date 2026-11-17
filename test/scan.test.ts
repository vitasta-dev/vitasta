import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ApiMap, ChangeRecord, Usage } from "../src/types.js";

let map: ApiMap;
const at = (file: string, line: number): Usage | undefined => map.usages.find((u) => u.file === file && u.line === line);

beforeAll(async () => {
  map = await scanRepo(resolve(import.meta.dirname, "fixtures/sample"));
});

describe("manifests", () => {
  it("reads SDKs from package.json and requirements.txt", () => {
    const names = map.sdks.map((s) => `${s.lang}:${s.name}@${s.version}`).sort();
    expect(names).toEqual(["py:anthropic@0.40.0", "py:openai@0.28.1", "ts:@anthropic-ai/sdk@^0.30.0", "ts:openai@^4.20.0"]);
  });
});

describe("TypeScript / JavaScript", () => {
  it("follows a client stored on this.client", () => {
    expect(at("src/chat.ts", 13)).toMatchObject({ provider: "openai", kind: "sdk", sdkCall: "beta.threads.runs.create", op: "* /v1/threads" });
    expect(at("src/chat.ts", 17)).toMatchObject({ op: "POST /v1/chat/completions", model: "gpt-4o" });
  });

  it("follows a client imported from another file and resolves a model constant", () => {
    expect(at("src/chat.ts", 23)).toMatchObject({
      provider: "anthropic", op: "POST /v1/messages", model: "claude-sonnet-4-20250514", confidence: "certain",
    });
    expect(at("src/chat.ts", 23)?.params).toContain("temperature");
  });

  it("rebuilds a fetch URL from a base-URL constant with an env fallback, and reads the JSON body", () => {
    expect(at("src/chat.ts", 28)).toMatchObject({ kind: "http", provider: "anthropic", op: "POST /v1/messages", model: "claude-3-5-sonnet-20241022" });
  });

  it("joins an axios instance baseURL with the request path", () => {
    expect(at("src/chat.ts", 38)).toMatchObject({ kind: "http", provider: "openai", op: "GET /v1/models" });
  });

  it("handles CommonJS require with destructuring (legacy SDK v3)", () => {
    expect(at("src/legacy.js", 6)).toMatchObject({ provider: "openai", sdkCall: "createChatCompletion", model: "gpt-3.5-turbo" });
  });

  it("records pinned API versions", () => {
    const pins = map.usages.filter((u) => u.kind === "version-pin").map((u) => `${u.file}:${u.apiVersion}`);
    expect(pins).toContain("src/lib/llm.ts:anthropic-version: 2023-06-01");
  });

  it("flags model IDs that live outside a call as possible", () => {
    expect(at("src/lib/llm.ts", 8)).toMatchObject({ kind: "model-ref", model: "claude-sonnet-4-5-20250929", confidence: "possible" });
  });

  it("follows clients built by a local factory function", () => {
    expect(at("src/factory.ts", 8)).toMatchObject({ provider: "anthropic", confidence: "certain", model: "claude-3-haiku-20240307" });
  });

  it("marks Azure-hosted calls so the provider's retirement dates aren't applied", () => {
    expect(at("src/factory.ts", 13)).toMatchObject({ provider: "openai", model: "gpt-4", host: "azure" });
  });

  it("does not match own routes or look-alike strings", () => {
    expect(map.usages.filter((u) => u.file === "src/chat.ts" && u.line >= 40)).toEqual([]);
  });
});

describe("Python", () => {
  it("follows self.client and resolves os.environ.get defaults", () => {
    expect(at("py/agent.py", 14)).toMatchObject({ provider: "anthropic", sdkCall: "messages.create", model: "claude-3-opus-20240229" });
  });

  it("handles legacy module-level calls", () => {
    expect(at("py/agent.py", 24)).toMatchObject({ provider: "openai", sdkCall: "ChatCompletion.create", op: "POST /v1/chat/completions", model: "gpt-4" });
  });

  it("joins an httpx.Client base_url with the request path", () => {
    expect(at("py/agent.py", 29)).toMatchObject({ kind: "http", provider: "openai", op: "POST /v1/assistants" });
  });

  it("follows clients passed in as typed parameters", () => {
    expect(at("py/agent.py", 33)).toMatchObject({ provider: "anthropic", model: "claude-opus-4-1-20250805" });
  });
});

describe("matching against the feed", () => {
  const feed: ChangeRecord[] = [
    {
      id: "t-retire", provider: "anthropic", type: "model_retirement", title: "x",
      selector: { models: ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"] }, effective: "2026-11-30", trigger: "date", sources: [],
    },
    {
      id: "t-assistants", provider: "openai", type: "endpoint_shutdown", title: "x",
      selector: { ops: ["* /v1/assistants", "* /v1/threads"] }, effective: "2026-08-26", trigger: "date", sources: [],
    },
    {
      id: "t-params", provider: "anthropic", type: "param_removed", title: "x",
      selector: { ops: ["POST /v1/messages"], params: ["temperature", "top_p", "top_k"] }, effective: "2026-10-21", trigger: "upgrade", sources: [],
    },
  ];

  it("computes status and days left", () => {
    const f = findImpacts(map, feed, "2026-11-13");
    const byId = (id: string) => f.filter((x) => x.change.id === id);
    expect(byId("t-retire")).toHaveLength(1);
    expect(byId("t-retire")[0]).toMatchObject({ status: "urgent", daysLeft: 17 });
    expect(byId("t-assistants").map((x) => `${x.usage.file}:${x.usage.line}`).sort()).toEqual(["py/agent.py:29", "src/chat.ts:13"]);
    expect(byId("t-assistants").every((x) => x.status === "broken")).toBe(true);
    expect(byId("t-params").map((x) => `${x.usage.file}:${x.usage.line}`).sort()).toEqual(["py/agent.py:14", "src/chat.ts:23"]);
    expect(byId("t-params").every((x) => x.status === "on-upgrade")).toBe(true);
  });

  it("applies Azure's own schedule to Azure-hosted models", () => {
    const azure: ChangeRecord = {
      id: "t-azure-gpt4", provider: "openai", type: "model_retirement", title: "x",
      selector: { models: ["gpt-4"], hosts: ["azure"] }, effective: "2026-12-01", trigger: "date", sources: [],
    };
    const f = findImpacts(map, [azure], "2026-11-13").map((x) => `${x.usage.file}:${x.usage.line}:${x.status}`);
    expect(f).toEqual(["src/factory.ts:13:urgent"]);
  });

  it("skips provider retirement dates for Azure-hosted models", () => {
    const azureRetire: ChangeRecord = {
      id: "t-gpt4", provider: "openai", type: "model_retirement", title: "x",
      selector: { models: ["gpt-4"] }, effective: "2026-10-23", trigger: "date", sources: [],
    };
    const files = findImpacts(map, [azureRetire], "2026-11-13").map((f) => `${f.usage.file}:${f.usage.line}`);
    expect(files).toContain("py/agent.py:24");
    expect(files).not.toContain("src/factory.ts:13");
  });
});
