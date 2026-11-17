import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const refs = async (repo: string, file: string) =>
  (await scanRepo(resolve(import.meta.dirname, "fixtures/shapes", repo))).usages
    .filter((u) => u.file === file && u.kind === "model-ref")
    .map((u) => `${u.line} ${u.model}${u.listed ? " (listed)" : ""}`);

describe("models in code shapes count when the repo uses the provider", () => {
  it("TS: enums and per-provider maps; a model-shaped constructor; not price tables, membership checks, name helpers or recorded responses", async () => {
    expect(await refs("used", "models.ts")).toEqual([
      "2 gpt-4o (listed)",
      "3 gpt-4o-mini (listed)",
      "6 claude-sonnet-4-5 (listed)",
      "7 gpt-4.1 (listed)",
      "14 gpt-4o-mini",
    ]);
  });
  it("Python: enums, preset rows, alias values, returned fallback lists, model-shaped calls; not membership checks", async () => {
    expect(await refs("used", "presets.py")).toEqual([
      "5 gpt-4o (listed)",
      "6 o1 (listed)",
      "10 gpt-4o-mini (listed)",
      "11 llama-3.3-70b-versatile (listed)",
      "13 gpt-4o-2024-08-06 (listed)",
      "13 gpt-4o-mini-2024-07-18 (listed)",
      "17 llama-3.1-8b-instant (listed)",
      "17 llama-3.1-70b-versatile (listed)",
      "22 gpt-4o",
    ]);
  });
  it("Java: enum constants", async () => {
    expect(await refs("used", "Models.java")).toEqual(["2 gpt-4o (listed)", "3 gpt-4o-mini (listed)"]);
  });
  it("the same code in a repo with no sign of using these providers reports nothing", async () => {
    for (const f of ["models.ts", "presets.py", "Models.java"]) expect(await refs("unused", f)).toEqual([]);
  });
});

describe("config files", () => {
  it("lists and flow lists of models count when used; price lists, result files and recorded responses don't", async () => {
    expect(await refs("used", "router.yaml")).toEqual([
      "2 gpt-4o-mini (listed)",
      "3 claude-haiku-4-5 (listed)",
      "7 gpt-4o (listed)",
      "7 gpt-4.1-mini (listed)",
    ]);
    expect(await refs("used", "eval/results.json")).toEqual([]);
    expect(await refs("used", "fixture.json")).toEqual([]);
    expect(await refs("unused", "router.yaml")).toEqual([]);
  });
});

describe("config registries", () => {
  it("one model per entry counts when other entries hold models too; snapshot lists don't", async () => {
    expect(await refs("used", "registry.json")).toEqual(["6 claude-sonnet-4-5 (listed)", "7 claude-haiku-4-5 (listed)"]);
  });
});
