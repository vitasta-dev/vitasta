import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluatePr } from "../src/check.js";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const feed: ChangeRecord[] = [{ id: "haiku35", provider: "anthropic", type: "model_retirement", title: "claude-3-5-haiku-20241022 is retired", selector: { models: ["claude-3-5-haiku-20241022"] }, effective: "2026-02-19", trigger: "date", replacement: "claude-haiku-4-5", sources: [] }];

describe("a PR that edits only the model line of a multi-line call", () => {
  for (const [file, text, modelLine] of [
    ["src/summarize.ts", 'import Anthropic from "@anthropic-ai/sdk";\nconst c = new Anthropic();\n\nexport async function summarize(t: string) {\n  const r = await c.messages.create({\n    max_tokens: 200,\n    model: "claude-3-5-haiku-20241022",\n    messages: [{ role: "user", content: t }],\n  });\n  return r;\n}\n', 7],
    ["summarize.py", 'import anthropic\n\nclient = anthropic.Anthropic()\n\n\ndef summarize(t):\n    return client.messages.create(\n        max_tokens=200,\n        model="claude-3-5-haiku-20241022",\n        messages=[{"role": "user", "content": t}],\n    )\n', 9],
  ] as const) {
    it(`counts as added by the PR and fails the check (${file})`, async () => {
      const d = mkdtempSync(join(tmpdir(), "vitasta-modelline-"));
      dirs.push(d);
      writeFileSync(join(d, "package.json"), '{"dependencies":{"@anthropic-ai/sdk":"^0.60.0"}}');
      writeFileSync(join(d, "requirements.txt"), "anthropic==0.70.0\n");
      mkdirSync(join(d, "src"), { recursive: true });
      writeFileSync(join(d, file), text);
      const findings = findImpacts(await scanRepo(d), feed, "2026-11-18");
      expect(findings.length).toBeGreaterThan(0);
      // The diff changes only the model string's line, not the line the call starts on
      const result = evaluatePr(findings, new Map([[file, new Set([modelLine])]]));
      expect(result.introduced.map((f) => f.usage.file)).toEqual([file]);
      expect(result.conclusion).toBe("failure");
    });
  }
});
