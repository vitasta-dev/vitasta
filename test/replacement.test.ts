import { describe, expect, it } from "vitest";
import { impactsFrom, type FeedSource } from "../src/feed/lookup.js";
import { resolveReplacement } from "../src/feed/replacement.js";
import type { ApiMap, ChangeRecord } from "../src/types.js";

const rec = (model: string, effective: string, replacement?: string, extra: Partial<ChangeRecord> = {}): ChangeRecord => ({
  id: `${model}-${effective}`, provider: "openai", type: "model_retirement", title: `${model} retires`, selector: { models: [model] }, effective, trigger: "date",
  ...(replacement ? { replacement } : {}), sources: [], ...extra,
});
// As the feed has them on 18 Nov 2026
const FEED = [
  rec("o1-mini", "2025-10-27", "o4-mini"), rec("o4-mini", "2026-10-23", "gpt-5.6-terra"),
  rec("o1-preview", "2025-07-28", "o3"), rec("o3", "2026-12-11", "gpt-6.1-sol"),
  rec("gpt-4.5-preview", "2025-07-14", "gpt-4.1"), rec("gpt-4.1", "2027-01-14"),
  rec("gpt-4o", "2027-06-01", "gpt-5.1"),
];
const T = "2026-11-18";
const of = (m: string) => FEED.find((r) => r.selector.models![0] === m)!;

describe("the replacement is resolved through the feed", () => {
  it("follows a retired or retiring replacement to the first good one, and says why", () => {
    expect(resolveReplacement(of("o1-mini"), FEED, T)).toMatchObject({ model: "gpt-5.6-terra", named: "o4-mini", text: "gpt-5.6-terra (the provider names o4-mini, retired since 2026-10-23)" });
    expect(resolveReplacement(of("o1-preview"), FEED, T)?.text).toBe("gpt-6.1-sol (the provider names o3, itself retiring on 2026-12-11)");
    expect(resolveReplacement(of("gpt-4o"), FEED, T)).toMatchObject({ model: "gpt-5.1", text: "gpt-5.1" });
  });

  it("a chain that ends at a retiring model with nothing after it recommends nothing, and says so", () => {
    const m = resolveReplacement(of("gpt-4.5-preview"), FEED, T)!;
    expect(m.model).toBeUndefined();
    expect(m.text).toBe("no replacement that isn't itself retiring yet: the provider names gpt-4.1, itself retiring on 2027-01-14, and nothing after it is announced");
  });

  it("prose is shown as written; another platform's record and cycles don't count", () => {
    expect(resolveReplacement(rec("x", "2026-01-01", "the Responses API"), FEED, T)).toEqual({ named: "the Responses API", skipped: [], text: "the Responses API" });
    const azureO4 = rec("o4-mini", "2026-01-01", "gpt-9", { selector: { models: ["o4-mini"], hosts: ["azure"] } });
    expect(resolveReplacement(of("o1-mini"), [azureO4], T)?.model).toBe("o4-mini");
    const loop = [rec("a", "2026-01-01", "b"), rec("b", "2026-01-01", "a")];
    expect(resolveReplacement(loop[0], loop, T)?.model).toBeUndefined();
  });

  it("with the lookup service, the replacements' own records are fetched so the chain resolves", async () => {
    const asked: string[][] = [];
    const src: FeedSource = {
      describe: "fake", remote: true,
      forUsages: async () => [of("o1-mini")],
      forModels: async (ms) => (asked.push(ms), FEED.filter((r) => ms.includes(r.selector.models![0]))),
      forModel: async () => [], upcoming: async () => [],
    };
    const map: ApiMap = { root: "/r", scannedAt: T, filesScanned: 1, sdks: [], usages: [{ provider: "openai", kind: "sdk", lang: "py", file: "a.py", line: 1, model: "o1-mini", confidence: "certain", snippet: "" }] };
    const [f] = await impactsFrom(src, map, T);
    expect(f.moveTo?.model).toBe("gpt-5.6-terra");
    expect(asked).toEqual([["o4-mini"], ["gpt-5.6-terra"]]);
  });
});
