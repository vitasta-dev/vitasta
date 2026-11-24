import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRepoConfig } from "../src/config.js";
import { redactSecrets } from "../src/redact.js";
import { code, fence } from "../src/report/escape.js";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-hard-"));
  for (const [p, t] of Object.entries(files)) await writeFile(join(d, p), t);
  return d;
};

describe("18 Nov review: scans stay fast and contained on hostile repos", () => {
  // F1 and F2 (wall-clock limits) run on their own, serially: test/hardening.timing.test.ts, npm run test:timing

  it("F3: a rule-fixture file that is a symlink (to /dev/zero) is never read", async () => {
    const d = await repo({ "app.py": 'import openai\nclient = openai.OpenAI()\nclient.chat.completions.create(model="gpt-4o", messages=[])\n' });
    await symlink("/dev/zero", join(d, "app.yaml"));
    expect((await scanRepo(d)).usages.length).toBeGreaterThan(0);
  });

  it("F6/F15: a repo can't reuse a built-in provider's name, and bad change records are skipped, not crashed on", async () => {
    const d = await repo({ ".vitasta.yml": "providers:\n  - id: openai\n    hosts: [billing.acme.internal]\nchanges:\n  - id: x\n    provider: acme\n    type: model_retirement\n    effective: 2027-01-01\n    selector: { models: [m] }\n    replacement: 5\n" });
    const cfg = await loadRepoConfig(d);
    expect(cfg.providers).toEqual([]);
    expect(cfg.changes).toEqual([]);
    expect(cfg.warnings.join(" ")).toMatch(/built-in provider/);
    expect(cfg.warnings.join(" ")).toMatch(/replacement must be text/);
  });

  it("F8: escaping drops terminal escapes and bidi overrides", () => {
    expect(code("a\u001b]0;TITLE\u0007b‮c")).toBe("`a]0;TITLEbc`");
    expect(fence("x\u001b[31my\n\tz")).toBe("```\nx[31my\n\tz\n```");
  });

  it("F11: common key formats are masked; model settings aren't", () => {
    const k = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
    for (const s of [`os.environ["ANTHROPIC_API_KEY"] = "${k}"`, `co = cohere.Client("${k}")`, `AzureKeyCredential("${k}")`, `SG.${k}.${k}`, `pplx-${k}`, `xapp-1-${k}`, `https://hooks.slack.com/services/T0/B0/${k}`, `ntn_${k}`, `r8_${k}`, `api_key=b"${k}"`, `token = "${k}"`, `password = "correct horse battery staple"`, `GOCSPX-${k}`]) {
      expect(redactSecrets(s), s).not.toContain(k.slice(8, 20));
    }
    expect(redactSecrets('model = "gpt-4o-mini"')).toBe('model = "gpt-4o-mini"');
  });
});
