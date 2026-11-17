import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const FIXTURES = ["sample", "cloud", "java"].map((f) => resolve(import.meta.dirname, "fixtures", f));
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("edit spans point at exactly the right text", () => {
  for (const root of FIXTURES) {
    it(`in fixtures/${root.split("/").pop()}`, async () => {
      const map = await scanRepo(root);
      let models = 0;
      let params = 0;
      for (const u of map.usages) {
        const text = readFileSync(join(root, u.file), "utf8");
        if (u.modelSpan && u.model) {
          const slice = text.slice(u.modelSpan.start, u.modelSpan.end);
          if (u.modelSpan.kind === "string") expect(slice.slice(1, -1), `${u.file}:${u.line}`).toBe(u.model);
          else if (u.modelSpan.kind === "bare") expect(slice).toBe(u.model);
          else expect(slice).toMatch(/^[A-Za-z]*Model\.[A-Z0-9_]+$/);
          models++;
        }
        for (const [name, span] of Object.entries(u.paramSpans ?? {})) {
          const slice = text.slice(span.start, span.end).trim();
          if (u.lang === "java") expect(slice, `${u.file}:${u.line} ${name}`).toMatch(new RegExp(`^\\.${camel(name)}\\(`));
          else expect(slice.replace(/^["']/, ""), `${u.file}:${u.line} ${name}`).toMatch(new RegExp(`^${name}\\b`));
          params++;
        }
      }
      expect(models).toBeGreaterThan(0);
      expect(params).toBeGreaterThan(0);
    });
  }
});
