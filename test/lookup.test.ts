import { describe, expect, it } from "vitest";
import { maskOp, publicModel, queryOf, recordsForModel, recordsForUsages, remoteSource, upcomingRecords } from "../src/feed/lookup.js";
import type { ChangeRecord, Usage } from "../src/types.js";

const u = (o: Partial<Usage>): Usage => ({ provider: "openai", kind: "sdk", lang: "py", file: "secret/path.py", line: 7, confidence: "certain", snippet: "api_key = 'sk-...'", ...o });
const rec = (o: Partial<ChangeRecord>): ChangeRecord =>
  ({ id: "x", provider: "openai", type: "model_retirement", title: "t", effective: "2026-12-01", trigger: "date", selector: { models: ["o1-mini"] }, sources: [], ...o }) as ChangeRecord;

describe("lookup query", () => {
  it("sends only matching fields, deduplicated, never file, line, snippet or spans", () => {
    const q = queryOf([
      u({ model: "o1-mini", op: "POST /v1/chat/completions", modelSpan: { start: 1, end: 2, kind: "string" }, inTest: true }),
      u({ model: "o1-mini", op: "POST /v1/chat/completions", file: "other.py", line: 99 }),
    ]);
    expect(q).toEqual([{ provider: "openai", kind: "sdk", model: "o1-mini", op: "POST /v1/{}/{}" }]);
    const text = JSON.stringify(q);
    for (const leaked of ["secret", "path.py", "sk-", "other.py", "snippet", "line", "file", "Span"]) expect(text).not.toContain(leaked);
  });

  it("never sends repo names, account ids, private model names, custom providers or parameter names", () => {
    const q = queryOf([
      u({ provider: "github", kind: "http", op: "GET /repos/acme-corp/secret-repo/issues" }),
      u({ provider: "twilio", kind: "http", op: "POST /2010-04-01/Accounts/AC0123456789abcdef/Messages.json" }),
      u({ model: "ft:gpt-4o-mini-2024-07-18:acme-corp:project-falcon:9abc" }),
      u({ model: "acme-churn-prod-deployment", host: "azure" }),
      u({ provider: "acme-billing", kind: "http", op: "GET /v1/customers/cust_9912/invoices" }),
      u({ model: "gpt-4o", params: ["secret_internal_flag"], sdkCall: "acme.internal.call" }),
      u({ provider: "anthropic", model: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-haiku-20241022-v1:0" }),
    ]);
    const text = JSON.stringify(q);
    for (const leaked of ["acme", "secret", "AC0123", "falcon", "cust_9912", "123456789012", "internal"]) expect(text).not.toContain(leaked);
    expect(q.map((x) => x.model).filter(Boolean)).toEqual(["gpt-4o-mini-2024-07-18", "gpt-4o", "anthropic.claude-3-5-haiku-20241022-v1:0"]);
    expect(maskOp("GET /v1/threads/thread_abc/runs")).toBe("GET /v1/{}/{}/{}");
    expect(publicModel("my-private-model")).toBeUndefined();
  });

  it("a masked query still finds the records exact matching needs (superset)", () => {
    const feed = [
      rec({ id: "op", type: "endpoint_shutdown", selector: { ops: ["GET /repos/{owner}/{repo}/issues"] } } as Partial<ChangeRecord>),
      rec({ id: "param", type: "param_removed", selector: { ops: ["POST /v1/chat/completions"], params: ["functions"] } } as Partial<ChangeRecord>),
    ].map((r, i) => ({ ...r, provider: i ? "openai" : "github" }));
    const q = queryOf([u({ provider: "github", kind: "http", op: "GET /repos/acme/app/issues" }), u({ op: "POST /v1/chat/completions", params: ["functions"] })]);
    expect(recordsForUsages(feed, q).map((r) => r.id).sort()).toEqual(["op", "param"]);
  });

  it("finds the same records the full matcher would", () => {
    const feed = [rec({ id: "a" }), rec({ id: "b", selector: { models: ["gpt-4o"] } }), rec({ id: "c", provider: "anthropic", selector: { models: ["o1-mini"] } })];
    expect(recordsForUsages(feed, queryOf([u({ model: "o1-mini" })])).map((r) => r.id)).toEqual(["a"]);
    expect(recordsForModel(feed, "o1-mini").map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("caps upcoming lists", () => {
    const feed = Array.from({ length: 300 }, (_, i) => rec({ id: `r${i}`, effective: "2026-12-01" }));
    expect(upcomingRecords(feed, undefined, 99999, "2026-11-16")).toHaveLength(100);
    expect(upcomingRecords([rec({ effective: "2028-01-01" })], undefined, 99999, "2026-11-16")).toHaveLength(0);
  });

  it("posts the query and refuses plain-http hosts", async () => {
    let sent: unknown;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ records: [rec({ id: "a" })] }), { status: 200 });
    }) as unknown as typeof fetch;
    const src = remoteSource("https://lookup.test/v1/lookup", fake);
    expect((await src.forUsages([u({ model: "o1-mini" })])).map((r) => r.id)).toEqual(["a"]);
    expect(sent).toEqual({ usages: [{ provider: "openai", kind: "sdk", model: "o1-mini" }] });
    expect(() => remoteSource("http://evil.test/x")).toThrow();
    expect(() => remoteSource("http://localhost:1@evil.example/x")).toThrow();
    expect(() => remoteSource("https://")).toThrow();
  });
});
