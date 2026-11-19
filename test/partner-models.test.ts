import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { publicModel } from "../src/feed/lookup.js";
import { azureFamily, bedrockModel, hostOfModel, modelProvider, normalizeModel, partnerOnlyHost } from "../src/providers.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

const fixture = resolve(import.meta.dirname, "fixtures/partner");
const rec = (id: string, provider: string, host: "azure" | "bedrock", models: string[]): ChangeRecord => ({
  id, provider, type: "model_retirement", title: id, selector: { models, hosts: [host] }, effective: "2026-12-01", trigger: "date",
  sources: [{ url: "https://example.com" }],
});

describe("partner vendors' model IDs (src/data/partner-models.json)", () => {
  it("Bedrock IDs: namespace → the feed's provider; region prefixes and ARNs come off; strong only with Bedrock's own form", () => {
    expect(bedrockModel("meta.llama3-1-405b-instruct-v1:0")).toEqual({ provider: "meta-llama", model: "meta.llama3-1-405b-instruct-v1:0", strong: true });
    expect(bedrockModel("us.meta.llama3-1-405b-instruct-v1:0")).toEqual({ provider: "meta-llama", model: "meta.llama3-1-405b-instruct-v1:0", strong: true });
    expect(bedrockModel("arn:aws:bedrock:us-east-1:123456789012:inference-profile/eu.mistral.pixtral-large-2502-v1:0")?.provider).toBe("mistral");
    expect(bedrockModel("deepseek.v3.1")).toEqual({ provider: "deepseek", model: "deepseek.v3.1", strong: false });
    expect(bedrockModel("moonshot.kimi-k2-thinking")?.provider).toBe(bedrockModel("moonshotai.kimi-k2-thinking")?.provider);
    // Not Bedrock IDs: an unknown namespace, a domain, a word with no digit or dash
    expect(bedrockModel("acme.model-v1:0")).toBeUndefined();
    expect(bedrockModel("google.com")).toBeUndefined();
    expect(bedrockModel("amazon.titan")).toBeUndefined();
    expect(normalizeModel("global.amazon.nova-2-lite-v1:0")).toBe("amazon.nova-2-lite-v1:0");
    expect(normalizeModel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(hostOfModel("writer.palmyra-x5-v1:0")).toBe("bedrock");
    expect(hostOfModel("zai.glm-4.7")).toBeUndefined(); // needs Bedrock code around it
  });

  it("Azure catalog names by vendor family, any case; only counted on Azure", () => {
    expect(azureFamily("Llama-3.3-70B-Instruct")).toBe("meta-llama");
    expect(azureFamily("Meta-Llama-3.1-405B-Instruct")).toBe("meta-llama");
    expect(azureFamily("Phi-4-mini-instruct")).toBe("microsoft");
    expect(azureFamily("DeepSeek-R1-0528")).toBe("deepseek");
    expect(azureFamily("Cohere-rerank-v4.0-pro")).toBe("cohere");
    expect(azureFamily("FLUX.1-Kontext-pro")).toBe("blackforestlabs");
    expect(azureFamily("Kimi-K2.6")).toBe("moonshotai");
    expect(azureFamily("my-llama-wrapper")).toBeUndefined();
    expect(partnerOnlyHost("Llama-3.3-70B-Instruct")).toBe("azure");
    expect(partnerOnlyHost("us.meta.llama3-1-8b-instruct-v1:0")).toBe("bedrock");
    // A provider's own API model isn't partner-only, even where a family pattern would also take it
    expect(partnerOnlyHost("grok-4")).toBeUndefined();
    expect(partnerOnlyHost("deepseek-v3.2")).toBeUndefined();
    expect(modelProvider("Ministral-3B")?.id).toBe("mistral");
  });

  it("the lookup may send them: catalog names are public", () => {
    expect(publicModel("us.meta.llama3-1-405b-instruct-v1:0")).toBe("meta.llama3-1-405b-instruct-v1:0");
    expect(publicModel("Llama-3.3-70B-Instruct")).toBe("Llama-3.3-70B-Instruct");
    expect(publicModel("acme-internal-model")).toBeUndefined();
  });

  it("found on the platform the code runs them on; the same names elsewhere aren't", async () => {
    const map = await scanRepo(fixture);
    const found = map.usages
      .filter((u) => u.model)
      .map((u) => `${u.file}:${u.line} ${u.provider} ${u.model} @${u.host ?? "-"}`)
      .sort();
    expect(found).toEqual([
      "azure-models.ts:2 meta-llama Llama-3.3-70B-Instruct @azure",
      "azure-models.ts:3 deepseek deepseek-r1 @azure",
      "azure_branch.py:6 cohere Cohere-command-r-08-2024 @azure",
      "bedrock-chat.ts:4 meta-llama us.meta.llama3-1-405b-instruct-v1:0 @bedrock",
      "bedrock-chat.ts:5 deepseek deepseek.v3.1 @bedrock",
      "bedrock_chat.py:4 mistral mistral.mistral-7b-instruct-v0:2 @bedrock",
      "bedrock_chat.py:5 qwen qwen.qwen3-coder-30b-a3b-instruct @bedrock",
    ]);
  });

  it("match the platform's records (Azure names in any case), and nothing on another platform", async () => {
    const map = await scanRepo(fixture);
    const feed = [
      rec("azure-llama", "meta-llama", "azure", ["Llama-3.3-70B-Instruct"]),
      rec("azure-deepseek-r1", "deepseek", "azure", ["DeepSeek-R1"]),
      rec("bedrock-llama", "meta-llama", "bedrock", ["meta.llama3-1-405b-instruct-v1:0"]),
      rec("bedrock-deepseek", "deepseek", "bedrock", ["deepseek.v3-v1:0", "deepseek.v3.1"]),
      rec("bedrock-qwen", "qwen", "bedrock", ["qwen.qwen3-coder-30b-a3b-v1:0", "qwen.qwen3-coder-30b-a3b-instruct"]),
      rec("bedrock-llama-on-azure-name", "meta-llama", "bedrock", ["Llama-3.3-70B-Instruct"]),
    ];
    const hits = findImpacts(map, feed, "2026-11-18").map((f) => `${f.change.id} ${f.usage.file}:${f.usage.line}`).sort();
    expect(hits).toEqual([
      "azure-deepseek-r1 azure-models.ts:3",
      "azure-llama azure-models.ts:2",
      "bedrock-deepseek bedrock-chat.ts:5",
      "bedrock-llama bedrock-chat.ts:4",
      "bedrock-qwen bedrock_chat.py:5",
    ]);
  });

  // The feed names each vendor; this file must know every Azure and Bedrock model it lists, with the same provider.
  // The feed is a separate (private) repo: $VITASTA_FEED_DATA, else the sibling checkout. Locally it skips without
  // one; in CI it must be there (test.yml checks it out), so a new vendor in the feed can't go unnoticed.
  const feedDir = process.env.VITASTA_FEED_DATA ?? resolve(import.meta.dirname, "../../feed/data");
  const haveFeed = existsSync(resolve(feedDir, "azure.json"));
  it.skipIf(!haveFeed && !process.env.CI)("covers every Azure and Bedrock model ID in the feed", () => {
    if (!haveFeed) throw new Error(`no feed data at ${feedDir}: CI must check out vitasta-dev/feed (FEED_READ_TOKEN) and set VITASTA_FEED_DATA`);
    const missed: string[] = [];
    for (const file of ["azure.json", "bedrock.json"]) {
      for (const r of JSON.parse(readFileSync(resolve(feedDir, file), "utf8")) as ChangeRecord[]) {
        for (const m of r.selector.models ?? []) {
          if (m.includes("*") || m === "model-router") continue; // Azure's "model-router" is too common a word to look for
          const p = modelProvider(normalizeModel(m));
          if (p?.id !== r.provider) missed.push(`${file} ${r.provider} ${m}${p ? ` (found as ${p.id})` : ""}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });
});
