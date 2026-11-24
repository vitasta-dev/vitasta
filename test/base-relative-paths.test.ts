import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

vi.setConfig({ testTimeout: 120_000 });

const FEED = [{ id: "shared", provider: "msgraph", type: "endpoint_shutdown", title: "sharedWithMe removed", selector: { ops: ["GET /v1.0/drives/{drive-id}/sharedWithMe()"] }, effective: "2027-11-01", trigger: "date", sources: [{ url: "https://learn.microsoft.com/graph" }] }] as unknown as ChangeRecord[];

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-baserel-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return scanRepo(d);
};
const opsAt = (m: Awaited<ReturnType<typeof scan>>) => m.usages.filter((u) => u.provider === "msgraph" && u.op && /drive/.test(u.op)).map((u) => `${u.file}:${u.line} ${u.op}`);
const joined = (m: Awaited<ReturnType<typeof scan>>) => m.usages.filter((u) => /joined to/.test(u.reason ?? "")).map((u) => `${u.file}:${u.line} ${u.op}`);

describe("a relative path joined to a base URL held in a name", () => {
  it("PHP: 'drive/sharedWithMe' on the base https://graph.microsoft.com/v1.0/me/ is the alias form the records cover", async () => {
    const m = await scan({ "a.php": "<?php\nclass G {\n  private $base = 'https://graph.microsoft.com/v1.0/me/';\n  function shared() { return file_get_contents($this->base . 'drive/sharedWithMe'); }\n}\n" });
    expect(joined(m)).toEqual(["a.php:4 * /v1.0/me/drive/sharedWithMe"]);
    expect(findImpacts(m, FEED, "2026-11-25").map((f) => `${f.usage.file}:${f.usage.line}`)).toEqual(["a.php:4"]);
  });
  it("TS, Python and Ruby: found (by the call analysis where it reads the join itself, by the join rule otherwise)", async () => {
    expect(opsAt(await scan({ "a.ts": 'const BASE = "https://graph.microsoft.com/v1.0";\nexport const f = () => fetch(BASE + "/me/drive/recent");\n' }))).toContain("a.ts:2 GET /v1.0/me/drive/recent");
    expect(opsAt(await scan({ "a.py": 'import requests\nBASE = "https://graph.microsoft.com/v1.0/"\ndef f(): return requests.get(BASE + "me/drive/sharedWithMe")\n' })).join()).toMatch(/a\.py:3 \S+ \/v1\.0\/me\/drive\/sharedWithMe/);
    expect(opsAt(await scan({ "a.rb": 'BASE = "https://graph.microsoft.com/v1.0/me/"\ndef f; Net::HTTP.get(URI(BASE + "drive/recent")); end\n' })).join()).toMatch(/a\.rb:2 \S+ \/v1\.0\/me\/drive\/recent/);
  });
  it("negatives: a bare host base, a name that isn't the base, a URL joined to a URL, another host, a comment, a query", async () => {
    expect(joined(await scan({ "a.ts": 'const HOST = "https://graph.microsoft.com/";\nexport const f = () => fetch(HOST + "v1.0/me/drive/recent");\n' }))).toEqual([]);
    expect(joined(await scan({ "a.ts": 'const BASE = "https://graph.microsoft.com/v1.0";\nconst OTHER = "x";\nexport const f = () => fetch(OTHER + "me/drive/recent");\n' }))).toEqual([]);
    expect(joined(await scan({ "a.ts": 'const BASE = "https://graph.microsoft.com/v1.0";\nexport const f = () => fetch(BASE + "https://example.com/x");\n' }))).toEqual([]);
    expect(joined(await scan({ "a.ts": 'const BASE = "https://api.example.com/v1";\nexport const f = () => fetch(BASE + "/me/drive/recent");\n' }))).toEqual([]);
    expect(joined(await scan({ "a.ts": 'const BASE = "https://graph.microsoft.com/v1.0";\n// fetch(BASE + "me/drive/recent")\nexport const f = 1;\n' }))).toEqual([]);
    expect(joined(await scan({ "a.ts": 'const BASE = "https://graph.microsoft.com/v1.0";\nexport const f = () => fetch(BASE + "?x=1");\n' }))).toEqual([]);
  });
});
