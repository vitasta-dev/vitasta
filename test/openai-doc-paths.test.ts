import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 120_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-oa-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};

const docs = (us: any[], file: string) => us.filter((u) => u.file === file).map((u) => `${u.line} ${u.op}`);

describe("a doc or skill file that tells an agent to call a retired endpoint (docs, the also tier)", () => {
  it("Markdown: a bare verb + path and a curl URL", async () => {
    const us = await scan({ "skills/translate/SKILL.md": "# Translate audio\n\nCall `POST /v1/audio/translations` with the file.\n\n```\ncurl https://api.openai.com/v1/audio/translations -F file=@a.mp3 -F model=whisper-1\n```\n" });
    expect(docs(us, "skills/translate/SKILL.md")).toEqual(["3 POST /v1/audio/translations", "6 * /v1/audio/translations"]);
    for (const u of us.filter((x) => x.file === "skills/translate/SKILL.md")) expect(u).toMatchObject({ provider: "openai", doc: true, role: "users-copy" });
  });
  it("TOML: an agent's instruction text", async () => {
    const us = await scan({ "agent.toml": 'name = "translator"\ninstructions = "Call POST /v1/audio/translations with the user\'s audio file."\n' });
    expect(docs(us, "agent.toml")).toEqual(["2 POST /v1/audio/translations"]);
  });
  it("negatives: an endpoint that isn't one, an ambiguous bare path with no provider named, a wrong verb, code blocks of another API", async () => {
    expect(docs(await scan({ "a.md": "Call `POST /v1/widgets` now.\n" }), "a.md")).toEqual([]);
    // /v1/models belongs to several providers: with none named in the file, it says nothing
    expect(docs(await scan({ "a.md": "List with `GET /v1/models`.\n" }), "a.md")).toEqual([]);
    expect(docs(await scan({ "a.md": "Use OpenAI: `GET /v1/models`.\n" }), "a.md")).toEqual(["1 GET /v1/models"]);
    // a verb the operation doesn't have
    expect(docs(await scan({ "a.md": "OpenAI: `PATCH /v1/audio/translations`.\n" }), "a.md")).toEqual([]);
    // another host's URL
    expect(docs(await scan({ "a.md": "curl https://example.com/v1/audio/translations\n" }), "a.md")).toEqual([]);
  });
});
