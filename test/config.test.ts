import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePr } from "../src/check.js";
import { globToRegExp, safePattern } from "../src/config.js";
import { findImpacts } from "../src/feed/match.js";
import { PROVIDERS } from "../src/providers.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

const ROOT = resolve(import.meta.dirname, "fixtures/configured");
const FEED: ChangeRecord[] = [
  { id: "openai-gpt-4-0613-retire-2026-10-23", provider: "openai", type: "model_retirement", title: "gpt-4", selector: { models: ["gpt-4"] }, effective: "2026-10-23", trigger: "date", sources: [] },
  { id: "turbo", provider: "openai", type: "model_retirement", title: "gpt-3.5-turbo", selector: { models: ["gpt-3.5-turbo"] }, effective: "2026-12-20", trigger: "date", sources: [] },
];

describe(".vitasta.yml", () => {
  it("adds the repo's own APIs and change records, honours ignore and accept, and reports bad entries", async () => {
    const warnings: string[] = [];
    const map = await scanRepo(ROOT, { onWarn: (w) => warnings.push(w) });
    expect(map.usages.some((u) => u.file.startsWith("legacy/"))).toBe(false);
    expect(map.usages.find((u) => u.provider === "acme-billing")).toMatchObject({ kind: "http", op: "POST /v1/invoices", apiVersion: "url: 1" });
    expect(warnings.join("\n")).toMatch(/providers\[1\] skipped: .*repeated group/);
    expect(warnings.join("\n")).toMatch(/changes\[1\] skipped/);

    const f = findImpacts(map, FEED, "2026-11-13").map((x) => `${x.change.id}:${x.status}`).sort();
    // gpt-4 accepted; gpt-3.5-turbo due in 37 days counts as urgent under urgentDays: 60; the internal v1 sunset is found
    expect(f).toEqual(["acme-billing-v1:urgent", "turbo:urgent"]);
  });

  it("uses failOn from the policy for the PR check", async () => {
    const map = await scanRepo(ROOT);
    const findings = findImpacts(map, FEED, "2026-11-13");
    const all = new Map([["src/app.ts", new Set([1, 2, 3, 4, 5])]]);
    expect(evaluatePr(findings, all, map.config?.policy.failOn).conclusion).toBe("neutral"); // only "broken" fails
  });

  it("never leaks a repo's custom providers into the next scan", async () => {
    await scanRepo(ROOT);
    expect(PROVIDERS.some((p) => p.id === "acme-billing")).toBe(false);
  });

  it("globs and pattern safety", () => {
    expect(globToRegExp("legacy/**").test("legacy/a/b.ts")).toBe(true);
    expect(globToRegExp("*.test.ts").test("a.test.ts")).toBe(true);
    // gitignore-style: no slash → any depth; a bare name covers its contents; a path with a slash is anchored
    expect(globToRegExp("*.test.ts").test("src/a.test.ts")).toBe(true);
    expect(globToRegExp("legacy").test("legacy/x.ts")).toBe(true);
    expect(globToRegExp("legacy/").test("pkg/legacy/x.ts")).toBe(true);
    expect(globToRegExp("src/legacy").test("pkg/src/legacy/x.ts")).toBe(false);
    expect(globToRegExp("/legacy").test("pkg/legacy/x.ts")).toBe(false);
    expect(() => safePattern("(a+)+$", "x")).toThrow();
    expect(() => safePattern("x".repeat(201), "x")).toThrow();
    expect(safePattern("^acme-[a-z]+$", "x")).toBe("^acme-[a-z]+$");
  });
});
