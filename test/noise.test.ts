import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Built from the false positives found in the 55-repo precision review (13 Nov 2026)
describe("loose model strings: settings count, data and labels don't", () => {
  it("TS/JS", async () => {
    const map = await scanRepo(resolve(import.meta.dirname, "fixtures/noise"));
    const ts = map.usages.filter((u) => u.file === "src/models.ts" && u.kind === "model-ref" && u.line < 15).map((u) => `${u.line}:${u.model}`);
    expect(ts).toEqual([
      "2:gpt-4-turbo",
      "3:claude-3-opus-20240229",
      "3:claude-sonnet-5-5",
      "4:gpt-4o",
      "4:gpt-4.1",
      "5:claude-3-haiku-20240307",
      "6:claude-3-5-sonnet-20240620",
    ]);
  });

  it("TS/JS round 2: allowed lists, registries, picker maps, helper args count; capability sets and token counters don't", async () => {
    const map = await scanRepo(resolve(import.meta.dirname, "fixtures/noise"));
    const ts = map.usages.filter((u) => u.file === "src/models.ts" && u.line >= 15).map((u) => `${u.line}:${u.model}`);
    expect(ts).toEqual([
      "16:gpt-4o-mini",
      "16:o1-mini",
      "17:claude-3-haiku-20240307",
      "18:gpt-4-0125-preview",
      "20:claude-3-opus-20240229",
    ]);
  });

  it("Python, including clients pointed at a relay server", async () => {
    const map = await scanRepo(resolve(import.meta.dirname, "fixtures/noise"));
    const py = map.usages.filter((u) => u.file === "py/agent.py" && u.model).map((u) => `${u.line}:${u.model}${u.proxy ? ` via ${u.proxy}` : ""}`);
    // A list or loop of models counts in a repo that uses the provider (17 Nov review of 138 top repos: fallback
    // lists and model loops are real uses); a context-window table still doesn't
    expect(py).toEqual(["3:gpt-4-turbo", "4:gpt-4o", "4:gpt-4.1", "6:gpt-4o", "6:o3", "8:gpt-3.5-turbo", "11:gpt-4-turbo via relay.example.com"]);
  });

  it("YAML config: model keys and lists under model keys only", async () => {
    const map = await scanRepo(resolve(import.meta.dirname, "fixtures/noise"));
    const y = map.usages.filter((u) => u.file === "settings.yml").map((u) => `${u.line}:${u.model}`);
    expect(y).toEqual(["2:gpt-4-turbo", "5:claude-3-opus-20240229", "6:claude-sonnet-5-5"]);
  });
});
