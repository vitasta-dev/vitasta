import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ApiMap, ChangeRecord } from "../src/types.js";

let map: ApiMap;
const find = (file: string, pred: (u: ApiMap["usages"][number]) => boolean) => map.usages.filter((u) => u.file === file && pred(u));

beforeAll(async () => {
  map = await scanRepo(resolve(import.meta.dirname, "fixtures/breadth"));
});

const rec = (r: Partial<ChangeRecord> & Pick<ChangeRecord, "id" | "provider" | "type" | "selector" | "effective">): ChangeRecord =>
  ({ title: r.id, trigger: "date", sources: [{ url: "https://example.com" }], ...r }) as ChangeRecord;

describe("providers added as JSON plugins", () => {
  it("credits an OpenAI SDK pointed at Groq's endpoint to Groq", () => {
    const [u] = find("web/llm.ts", (u) => u.kind === "sdk");
    expect(u).toMatchObject({ provider: "groq", viaSdk: "openai", model: "llama-3.3-70b-versatile" });
    expect(u.proxy).toBeUndefined();
  });

  it("maps Mistral SDK calls", () => {
    expect(find("py/bot.py", (u) => u.provider === "mistral" && u.kind === "sdk")[0]).toMatchObject({ op: "POST /v1/chat/completions", model: "mistral-medium-3-5" });
  });

  it("maps Slack methods through the op template, Python snake_case included", () => {
    const ops = find("py/bot.py", (u) => u.provider === "slack").map((u) => u.op);
    expect(ops).toEqual(expect.arrayContaining(["POST /api/chat.postMessage", "POST /api/files.upload"]));
  });

  it("finds Microsoft Graph and Cloudflare HTTP calls and a Notion version pin", () => {
    expect(find("web/platform.ts", (u) => u.provider === "msgraph")[0]).toMatchObject({ op: "POST /v1.0/copilot/retrieval" });
    expect(find("web/platform.ts", (u) => u.provider === "cloudflare")[0]?.op).toMatch(/^GET \/client\/v4\/accounts\/\{[^}]*\}\/cloudforce-one\/events\/categories\//);
    expect(find("web/platform.ts", (u) => u.provider === "notion" && u.kind === "version-pin")[0]?.apiVersion).toMatch(/2022-06-28/);
  });

  it("matches the new providers' feed records", () => {
    const feed = [
      rec({ id: "groq-llama", provider: "groq", type: "model_retirement", selector: { models: ["llama-3.3-70b-versatile"] }, effective: "2026-08-16" }),
      rec({ id: "mistral-medium", provider: "mistral", type: "model_retirement", selector: { models: ["mistral-medium-3-5"] }, effective: "2027-04-30" }),
      rec({ id: "graph-retrieval", provider: "msgraph", type: "endpoint_shutdown", selector: { ops: ["POST /v1.0/copilot/retrieval"] }, effective: "2025-12-31" }),
      rec({ id: "cf-cat", provider: "cloudflare", type: "endpoint_shutdown", selector: { ops: ["GET /client/v4/accounts/{account_id}/cloudforce-one/events/categories/{category_id}"] }, effective: "2026-11-28" }),
      // OpenAI's own retirement of a same-named model must not hit the Groq call
      rec({ id: "openai-llama", provider: "openai", type: "model_retirement", selector: { models: ["llama-3.3-70b-versatile"] }, effective: "2026-01-01" }),
    ];
    const ids = findImpacts(map, feed, "2026-11-13").map((f) => f.change.id).sort();
    expect(ids).toEqual(["cf-cat", "graph-retrieval", "groq-llama", "mistral-medium"]);
  });
});
