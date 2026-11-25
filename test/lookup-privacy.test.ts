import { describe, expect, it } from "vitest";
import { publicModel, queryOf } from "../src/feed/lookup.js";
import { modelWordGaps } from "./feed-checks.js";
import { haveTestFeed, TEST_FEED } from "./feed-data.js";
import type { Usage } from "../src/types.js";

describe("what the lookup may send (review F5)", () => {
  it("never a customer's own names: Azure deployments, codenames, keys", () => {
    for (const [m, host] of [
      ["gpt-4o-contoso-prod-eastus", "azure"], ["mistral-acme-internal-prod", undefined], ["mai-acmecorp-secret-project", "azure"],
      ["Llama-3-acme-customer-42", "azure"], ["grok-contoso-hr-bot", "azure"], ["kimi-k2-acmecorp", "azure"],
      ["openai.sk-proj-abcdefghijkl1234567890", "bedrock"], ["gpt-4o-Xk9mQ2pL7vR4tB8nW3yZ6cD1", undefined],
    ] as const) expect(publicModel(m, host), m).toBeUndefined();
  });

  it("public IDs still go: on the provider's API, on Azure and on Bedrock", () => {
    for (const m of ["gpt-4o-mini", "gpt-4o-2024-08-06", "claude-sonnet-4-5-20250929", "us.meta.llama3-1-405b-instruct-v1:0", "DeepSeek-R1-0528", "Llama-3.3-70B-Instruct", "gemini-2.5-flash", "o4-mini"]) {
      expect(publicModel(m, "azure") ?? publicModel(m), m).toBeTruthy();
    }
    const q = queryOf([{ provider: "openai", kind: "sdk", lang: "ts", file: "a.ts", line: 1, model: "gpt-4o-contoso-prod", host: "azure", confidence: "certain", snippet: "" } as Usage]);
    expect(q.map((x) => x.model)).toEqual([undefined]);
  });

  // The word list comes from the feed: every model ID the feed has records for must count as public. Checked on the
  // frozen test feed's approved records; the live feed's new IDs show in the drift report (test/feed-data.ts)
  it.skipIf(!haveTestFeed)("every model ID in the feed is made of public words (src/data/model-words.json)", () => {
    expect(modelWordGaps(TEST_FEED, "approved")).toEqual([]);
  });
});
