import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { matches } from "../src/feed/match.js";
import type { ChangeRecord } from "../src/types.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-fix1-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const rec = (over: Partial<ChangeRecord>): ChangeRecord => ({ id: "x", provider: "openai", type: "endpoint_shutdown", title: "t", effective: "2026-08-26", selector: {}, ...over }) as ChangeRecord;

describe("record matching: a header that means the API is used", () => {
  const assistants = rec({ selector: { ops: ["* /v1/assistants"], headers: ["openai-beta: assistants=*"] } });
  it("matches the beta header with any value after the prefix, where an Assistants operation is in sight", async () => {
    const us = (await scanRepo(await repo({
      "a.ts": "export const list = (req: any) => req('GET', '/assistants', {\n  headers: {\n    'OpenAI-Beta': 'assistants=v2',\n  },\n});\n",
      "b.js": "const version = process.env.V;\nconst opts = { defaultHeaders: { 'OpenAI-Beta': `assistants=${version}` } };\nmodule.exports = opts;\n",
    }))).usages.filter((u: any) => u.kind === "version-pin" && u.provider === "openai");
    expect(us.length).toBe(2);
    // Review: a header with no request operation known (b.js: client
    // defaults only) doesn't match a record that names its operations
    expect(us.filter((u: any) => matches(assistants, u)).map((u: any) => u.file)).toEqual(["a.ts"]);
  });
  it("a record without headers still never matches a version pin, and another header doesn't match", () => {
    const pin = { provider: "openai", kind: "version-pin", apiVersion: "openai-beta: assistants=v2", file: "a", line: 1, lang: "ts" } as any;
    expect(matches(rec({ selector: { ops: ["* /v1/assistants"] } }), pin)).toBe(false);
    expect(matches(rec({ selector: { headers: ["openai-beta: realtime=*"] } }), pin)).toBe(false);
    expect(matches(rec({ provider: "anthropic", selector: { headers: ["openai-beta: assistants=*"] } }), pin)).toBe(false);
  });
});

describe("record matching: a request that interpolates its version from the same file", () => {
  it("a class field holding the version: one finding at the field, the requests using it as its lines", async () => {
    const us = (await scanRepo(await repo({
      "c.ts": [
        "import axios from 'axios'",
        "export class Client {",
        "  private _version: string = 'v19.0'",
        "  private _base = 'https://graph.facebook.com'",
        "  async token() {",
        "    return axios.get(`https://graph.facebook.com/${this._version}/oauth/access_token`)",
        "  }",
        "  async debug() {",
        "    return axios.get(",
        "      `https://graph.facebook.com/${this._version}/debug_token`",
        "    )",
        "  }",
        "  async send(id: string) {",
        "    const url = `${this._base}/${this._version}/${id}/messages`",
        "    return axios.post(url, {})",
        "  }",
        "  async unversioned() {",
        "    return axios.get(`${this._base}/me`)",
        "  }",
        "}",
      ].join("\n"),
    }))).usages.filter((u: any) => u.provider === "meta");
    // One finding at the field (line 3), each request using it a line of that finding; none on its own
    const pin = us.find((u: any) => u.line === 3 && u.apiVersion === "const: v19.0");
    expect(pin?.alsoLines).toEqual(expect.arrayContaining([6, 9, 14]));
    expect(pin?.alsoLines).not.toContain(18);
    expect(us.filter((u: any) => u.op && u.apiVersion).length).toBe(0);
    const sunset = rec({ provider: "meta", type: "version_sunset", selector: { versions: ["v19.0"] } });
    expect(matches(sunset, pin!)).toBe(true);
  });
});
