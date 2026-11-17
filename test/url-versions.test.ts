import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import type { ApiMap } from "../src/types.js";

let map: ApiMap;
const pins = (file: string) =>
  map.usages.filter((u) => u.file === file && u.apiVersion).map((u) => `${u.line} ${u.provider} ${u.kind} ${u.apiVersion}`).sort();

beforeAll(async () => {
  map = await scanRepo(resolve(import.meta.dirname, "fixtures/url-versions"));
});

describe("API versions written in URL strings count where they are written", () => {
  it("a base-URL constant, not the comment above it", () => {
    expect(pins("base.js")).toEqual(["2 meta version-pin url: v18.0"]);
  });
  it("wrapped fetch, a store host in a variable (Shopify), a client base URL; a docs link isn't an API URL", () => {
    expect(pins("deps.ts")).toEqual([
      "2 meta version-pin url: v19.0",
      "5 shopify version-pin url: 2026-04",
      "6 googleads version-pin url: v24",
    ]);
  });
  it("Python settings fields and f-strings; docstrings don't count; a followed call isn't reported twice", () => {
    expect(pins("settings.py")).toEqual([
      "10 meta version-pin url: v21.0",
      "14 meta http url: v22.0",
      "6 meta version-pin url: v23.0",
    ]);
  });
  it("Java string constants", () => {
    expect(pins("Graph.java")).toEqual(["2 meta version-pin url: v17.0"]);
  });
});

describe("removed endpoints: a path segment built at runtime never matches a fixed name", async () => {
  const { matches } = await import("../src/feed/match.js");
  const removed = {
    id: "gh-import", provider: "github", type: "endpoint_shutdown" as const, title: "Source imports API removed",
    selector: { ops: ["* /repos/{owner}/{repo}/import"] }, effective: "2024-04-12", trigger: "date" as const, sources: [{ url: "https://example.com" }],
  };
  const call = (op: string) => ({ provider: "github", kind: "http" as const, lang: "py" as const, file: "a.py", line: 1, op, confidence: "likely" as const, snippet: "" });
  it("f\"{API}/repos/{repo}/issues/{n}\" is not the import endpoint", () => {
    expect(matches(removed, call("GET /repos/{id}/issues/{id}"))).toBe(false);
    expect(matches(removed, call("GET /repos/{id}/{id}/{id}"))).toBe(false);
  });
  it("the import endpoint itself still matches, and a masked lookup query still gets it", () => {
    expect(matches(removed, call("PUT /repos/{id}/{id}/import"))).toBe(true);
    expect(matches(removed, call("PUT /repos/acme/app/import"))).toBe(true);
    expect(matches(removed, call("GET /{}/{}/{}/{}"))).toBe(true);
  });
});

describe("config files: commented-out lines are not settings", () => {
  it("reads the live .env setting, not the commented example below it", () => {
    const refs = map.usages.filter((u) => u.file === ".env.example").map((u) => `${u.line} ${u.model}`);
    expect(refs).toEqual(["1 claude-3-haiku-20240307"]);
  });
});
