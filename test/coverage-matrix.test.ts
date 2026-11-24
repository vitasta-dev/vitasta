import { describe, expect, it } from "vitest";
import { CELLS } from "./coverage/cells.js";
import { probe } from "./coverage/probe.js";

describe("API coverage matrix: each covered cell keeps working", () => {
  for (const cell of CELLS) {
    const name = `${cell.p} · ${cell.lang} · ${cell.style}`;
    if (cell.now !== "covered") {
      it.todo(`${name} (${cell.now})`);
      continue;
    }
    it(name, async () => {
      const got = await probe(cell);
      expect(Object.values(got).every(Boolean), JSON.stringify(got)).toBe(true);
    });
  }
});
