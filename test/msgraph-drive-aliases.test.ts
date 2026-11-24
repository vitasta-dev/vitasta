import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

vi.setConfig({ testTimeout: 120_000 });

// the feed's two drive records (data/msgraph.json): /drives/{drive-id}/recent() and /sharedWithMe() are being removed
const rec = (id: string, op: string) => ({ id, provider: "msgraph", type: "endpoint_shutdown", title: id, selector: { ops: [op] }, effective: "2027-11-01", trigger: "date", sources: [{ url: "https://learn.microsoft.com/graph" }] }) as unknown as ChangeRecord;
const FEED = [rec("recent", "GET /v1.0/drives/{drive-id}/recent()"), rec("shared", "GET /v1.0/drives/{drive-id}/sharedWithMe()")];

const hits = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-graphdrive-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return findImpacts(await scanRepo(d), FEED, "2026-11-25").map((f) => `${f.usage.file}:${f.usage.line} ${f.change.id}`).sort();
};

describe("Microsoft Graph drive aliases match the /drives/{drive-id} records", () => {
  it("/me/drive, /users/{id}/drive, /groups/{id}/drive and /sites/{id}/drive, in raw URLs", async () => {
    expect(await hits({
      "a.py": 'import requests\nBASE = "https://graph.microsoft.com/v1.0"\ndef f(): return requests.get("https://graph.microsoft.com/v1.0/me/drive/recent")\ndef g(uid): return requests.get(f"{BASE}/users/{uid}/drive/sharedWithMe")\n',
      "c.py": 'import requests\ndef h(gid): return requests.get(f"https://graph.microsoft.com/v1.0/groups/{gid}/drive/recent")\n',
      "b.ts": "export const f = (id: string) => fetch(`https://graph.microsoft.com/v1.0/sites/${id}/drive/recent`);\nexport const g = () => fetch('https://graph.microsoft.com/v1.0/drives/abc/sharedWithMe()');\n",
    })).toEqual(["a.py:3 recent", "a.py:4 shared", "b.ts:1 recent", "b.ts:2 shared", "c.py:2 recent"]);
  });
  it("the JS SDK's client.api('/me/drive/recent')", async () => {
    expect(await hits({ "a.js": 'const { Client } = require("@microsoft/microsoft-graph-client");\nconst client = Client.init({});\nasync function f() { return client.api(\'/me/drive/recent\').get(); }\n' })).toEqual(["a.js:3 recent"]);
  });
  it("negatives: other drive paths, other verbs, another host, the beta version spelled alike but another record", async () => {
    expect(await hits({ "a.py": 'import requests\nrequests.get("https://graph.microsoft.com/v1.0/me/drive/items")\nrequests.get("https://graph.microsoft.com/v1.0/me/drive")\nrequests.get("https://graph.microsoft.com/v1.0/me/messages")\nrequests.post("https://graph.microsoft.com/v1.0/me/drive/recent", json={})\nrequests.get("https://example.com/v1.0/me/drive/recent")\nrequests.get("https://graph.microsoft.com/v1.0/me/drives/recent")\n' })).toEqual([]);
  });
});
