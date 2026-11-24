import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "./helpers/legacy-scan.js";

// Recall gap from the 55-repo benchmark: model IDs written as TypeScript literal types
describe("TypeScript literal types", () => {
  it("count in model-named type aliases, fields and parameters; not in other names or as map keys", async () => {
    const map = await scanRepo(resolve(import.meta.dirname, "fixtures/unions"));
    const got = map.usages.filter((u) => u.model).map((u) => `${u.line}:${u.model}`);
    expect(got).toEqual([
      "1:gpt-4o",
      "1:gpt-3.5-turbo-0613",
      "3:gpt-4-0613",
      "3:gpt-4o-mini",
      "4:gpt-4-32k",
      "4:gpt-4o",
      "8:gpt-4-1106-preview",
      "8:gpt-4o",
      "10:gpt-3.5-turbo-16k",
      "10:gpt-4o",
    ]);
  });
});
