import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canBlock } from "../src/check.js";
import { scanRepo } from "../src/scan/index.js";

// Automatic library maps, trial (src/scan/automap.ts): synthetic maps only, no real packages
const tree = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-am-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const wrapperMap = { package: "agentkit", version: "1.0.0", functions: { "agentkit.assist.create_helper": { file: "agentkit/assist.py", line: 1, params: ["name", "model"], calls: ["corelib:make_assistant"] } }, aliases: { "agentkit.create_helper": "agentkit.assist.create_helper" } };
const coreMap = { package: "corelib", version: "2.0.0", functions: { "corelib.assistants.main.make_assistant": { file: "corelib/assistants/main.py", line: 1, params: ["model"], ops: [{ provider: "openai", op: "* /v1/assistants", params: [] }] } }, aliases: {} };
const cache = async () => tree({ "pypi/agentkit/1.0.0.json": JSON.stringify(wrapperMap), "pypi/corelib/2.0.0.json": JSON.stringify(coreMap) });
const app = { "requirements.txt": "agentkit==1.0.0\ncorelib==2.0.0\n", "app.py": "from agentkit import create_helper\nfrom agentkit.assist import create_helper as ch\n\n\ndef go():\n    a = create_helper(name=\"x\", model=\"gpt-4o\")\n    return ch(name=\"y\")\n" };

describe("automatic library maps (trial)", () => {
  afterEach(() => { delete process.env.VITASTA_LIBMAP_DIR; });
  it("an app's call of a mapped function reaches the provider op through another library's map", async () => {
    process.env.VITASTA_LIBMAP_DIR = await cache();
    const us = (await scanRepo(await tree(app))).usages as any[];
    const auto = us.filter((u) => u.libmap === "auto").map((u) => `${u.line} ${u.op}`).sort();
    expect(auto).toEqual(["6 * /v1/assistants", "7 * /v1/assistants"]);
    const u = us.find((x) => x.libmap === "auto" && x.line === 6);
    expect(u.reason).toMatch(/agentkit 1\.0\.0, auto map\) → corelib\.assistants\.main\.make_assistant \(corelib 2\.0\.0/);
    expect(u.confidence).toBe("possible");
    expect(canBlock({ usage: u, change: {}, status: "broken" } as any)).toBe(false);
  });
  it("off without a cache; a locked version with no map gives no finding and is listed", async () => {
    const off = (await scanRepo(await tree(app))).usages as any[];
    expect(off.filter((u) => u.libmap)).toEqual([]);
    process.env.VITASTA_LIBMAP_DIR = await cache();
    const warns: string[] = [];
    const other = await tree({ ...app, "requirements.txt": "agentkit==1.1.0\ncorelib==2.0.0\n" });
    const us = (await scanRepo(other, { onWarn: (w) => warns.push(w) })).usages as any[];
    expect(us.filter((u) => u.libmap)).toEqual([]);
    expect(warns.some((w) => /not mapped yet.*agentkit@1\.1\.0/.test(w))).toBe(true);
  });
});
