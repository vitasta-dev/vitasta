import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { canBlock, evaluatePr } from "../src/check.js";
import { renderCheckSummary } from "../src/report/check.js";
import { findImpacts } from "../src/feed/match.js";
import { renderMarkdown } from "../src/report/markdown.js";
import { jsonReport } from "../src/report/json.js";
import { scanRepo } from "../src/scan/index.js";

// "our job is to give update". Every place the retired thing exists is reported; a context label
// says what it is, and a tier whether it needs action. Only "action" can fail a check.
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-rwe-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const retire = (models: string[]) => models.map((m, i) => ({ id: `r${i}`, provider: "openai", type: "model_retirement", title: `${m} retires`, selector: { models: [m] }, effective: "2026-01-01", trigger: "date", sources: [{ url: "https://x" }] })) as any[];

describe("report where it exists", () => {
  it("a model id in a plain list is a catalog entry in the 'also' tier; a live request is 'action'", async () => {
    const map = await scanRepo(await repo({
      "package.json": '{"dependencies":{"openai":"^4.0.0"}}\n',
      "src/chat.ts": 'import OpenAI from "openai";\nconst c = new OpenAI();\nexport const ask = () => c.chat.completions.create({ model: "gpt-4o", messages: [] });\n',
      "src/known.ts": 'export const SEEN = ["gpt-3.5-turbo-0301", "text-davinci-003"];\n',
    }));
    const live = (map.usages as any[]).find((u) => u.file === "src/chat.ts" && u.model === "gpt-4o");
    expect(live.tier).toBe("action");
    const listed = (map.usages as any[]).filter((u) => u.file === "src/known.ts" && u.model);
    expect(listed.length).toBe(2);
    expect(listed.every((u) => u.tier === "also" && u.context === "catalog")).toBe(true);
    const fs = findImpacts(map as any, retire(["gpt-4o", "gpt-3.5-turbo-0301", "text-davinci-003"]), "2026-11-24");
    expect(fs.filter((f) => canBlock(f)).map((f) => f.usage.file)).toEqual(["src/chat.ts"]);
    expect(jsonReport(map as any, fs).findings.every((f) => f.usage.tier === "action" || f.usage.tier === "also")).toBe(true);
  });
  it("a large generated catalog is one grouped finding listing the retired ids", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `gpt-3.5-turbo-${String(1000 + i)}`);
    const catalog = JSON.stringify({ models: ids.map((id) => ({ id, context: 4096 })) }, null, 1);
    const map = await scanRepo(await repo({ "data/models.json": catalog, "package.json": '{"dependencies":{"openai":"^4.0.0"}}\n' }));
    const fs = findImpacts(map as any, retire(ids.slice(0, 30)), "2026-11-24");
    // every finding stays (its own record, for fixes and the JSON); each carries the group; the report collapses it
    const mine = fs.filter((f) => f.usage.file === "data/models.json");
    expect(mine.length).toBe(30);
    expect(mine.every((f) => f.usage.grouped?.count === 30 && f.usage.tier === "also")).toBe(true);
    expect(new Set(mine.map((f) => f.change.id)).size).toBe(30);
    const md = renderMarkdown(map as any, fs, "x");
    expect(md).toMatch(/Also in your code[\s\S]*data\/models\.json[\s\S]*30 entries/);
    expect(md.match(/30 entries/g)?.length).toBe(1);
    expect(md).not.toMatch(/## Action needed/);
  });
});

describe("the PR check: two tiers, only action fails", () => {
  const change = { id: "c", provider: "openai", type: "model_retirement", title: "gpt-4o retires", selector: { models: ["gpt-4o"] }, effective: "2026-01-01", trigger: "date", sources: [{ url: "https://x" }] } as any;
  const f = (file: string, line: number, extra: any = {}) => ({ change, usage: { provider: "openai", kind: "model-ref", lang: "ts", file, line, model: "gpt-4o", confidence: "likely", setting: true, ...extra }, daysLeft: -10, status: "broken" as const });
  const live = f("src/agent.ts", 3, { tier: "action" });
  const dead = f("src/old.ts", 5, { tier: "also", context: "dead", contextReason: "nothing in the repo reaches this code", dead: true });
  it("an 'also' finding on a changed line is shown, never failing; the summary has both sections", () => {
    const changed = new Map([["src/agent.ts", new Set([3])], ["src/old.ts", new Set([5])]]);
    const both = evaluatePr([live, dead] as any, changed);
    expect(both.conclusion).toBe("failure");
    const md = renderCheckSummary(both, { filesScanned: 2, usages: [] } as any);
    expect(md).toMatch(/\*\*Action needed in this pull request\*\*[\s\S]*src\/agent\.ts[\s\S]*<summary>Also in this pull request \(1; never fails the check\)<\/summary>[\s\S]*src\/old\.ts/);
    const onlyAlso = evaluatePr([live, dead] as any, new Map([["src/old.ts", new Set([5])]]));
    expect(onlyAlso.conclusion).toBe("neutral");
    expect(onlyAlso.introduced.map((x) => x.usage.file)).toEqual(["src/old.ts"]);
  });
});

describe("catalogs in test-data folders are test notes", () => {
  it("a model catalog under test-data/ or __data__/ is inTest; one under data/ isn't", async () => {
    const cat = JSON.stringify({ models: ["gpt-3.5-turbo-0301", "text-davinci-003"] });
    const map = await scanRepo(await repo({ "src/test-data/models.json": cat, "src/__data__/m.json": cat, "src/data/models.json": cat, "package.json": '{"dependencies":{"openai":"^4.0.0"}}\n' }));
    const by = (f: string) => (map.usages as any[]).filter((u) => u.file === f && u.model);
    expect(by("src/test-data/models.json").every((u) => u.inTest)).toBe(true);
    expect(by("src/__data__/m.json").every((u) => u.inTest)).toBe(true);
    expect(by("src/data/models.json").some((u) => !u.inTest)).toBe(true);
  });
});
