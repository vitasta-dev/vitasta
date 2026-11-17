import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.js";
import { scanRepo } from "../src/scan/index.js";

describe("secret redaction", () => {
  const cases: [string, string][] = [
    ["openai", `const c = new OpenAI({ apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" })`],
    ["anthropic", `client = Anthropic(api_key="sk-ant-api03-abcdefghijklmnopqrstuvwxyz")`],
    ["stripe", `stripe = Stripe("sk_live_51Habcdefghijklmnop")`],
    ["github", `token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"`],
    ["google", `key = "AIzaSyA-abcdefghijklmnopqrstuvwxyz12345"`],
    ["aws", `aws_access_key_id = AKIAIOSFODNN7EXAMPLE`],
    ["bearer", `headers: { Authorization: "Bearer abcdef1234567890abcdef" }`],
    ["url auth", `fetch("https://user:hunter2pass@api.example.com/v1")`],
    ["generic", `const password = "correct-horse-battery"`],
  ];
  for (const [name, line] of cases) {
    it(`hides a ${name} secret`, () => {
      const out = redactSecrets(line);
      expect(out).toContain("[redacted]");
      for (const secret of ["abcdefghijklmnopqrstuvwxyz", "51Habcdefghijklmnop", "IOSFODNN7EXAMPLE", "abcdef1234567890abcdef", "hunter2pass", "correct-horse-battery"]) {
        expect(out).not.toContain(secret);
      }
    });
  }

  it("leaves ordinary code alone", () => {
    const line = `const r = await client.chat.completions.create({ model: "gpt-4o-mini", max_tokens: 100 })`;
    expect(redactSecrets(line)).toBe(line);
    expect(redactSecrets(`model = "claude-sonnet-4-5-20250929"`)).toBe(`model = "claude-sonnet-4-5-20250929"`);
  });
});

describe("scanning untrusted repos", () => {
  it("redacts keys in snippets and doesn't follow symlinks out of the repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitasta-sec-"));
    const outside = await mkdtemp(join(tmpdir(), "vitasta-outside-"));
    await writeFile(join(outside, "secret.ts"), `import OpenAI from "openai";\nnew OpenAI().chat.completions.create({ model: "gpt-4o" });\n`);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { openai: "^4" } }));
    await writeFile(
      join(root, "src/a.ts"),
      `import OpenAI from "openai";\nconst c = new OpenAI({ apiKey: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" }); c.chat.completions.create({ model: "gpt-4o" });\n`,
    );
    await symlink(outside, join(root, "linked"));
    await symlink(join(outside, "secret.ts"), join(root, "src/b.ts"));
    const map = await scanRepo(root);
    expect(map.usages.length).toBeGreaterThan(0);
    expect(map.usages.every((u) => u.file.startsWith("src/a.ts"))).toBe(true);
    expect(JSON.stringify(map)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
