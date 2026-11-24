import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-fix3-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const lines = (us: any[], file: string) => us.filter((u) => u.file === file && u.apiVersion).map((u) => u.line).sort((a, b) => a - b);
const also = (us: any[], file: string, line: number) => us.find((u) => u.file === file && u.line === line && u.apiVersion)?.alsoLines ?? [];

describe("URL = a base constant + a path", () => {
  it("a URL setting starting with an imported versioned base, in a template", async () => {
    const us = (await scanRepo(await repo({
      "wa/utils.ts": "export const WHATSAPP_API_BASE = 'https://graph.facebook.com/v23.0';\n",
      "wa/client.ts": "import { http } from 'x';\nimport { WHATSAPP_API_BASE } from './utils';\n\nexport async function request(path: string) {\n  const req = {\n    url: `${WHATSAPP_API_BASE}${path}`,\n  };\n  return http.send(req);\n}\n",
    }))).usages;
    expect(lines(us, "wa/client.ts")).toEqual([6]);
  });

  it("a function returning the versioned URL, wrapped by an object member, used in another file", async () => {
    const us = (await scanRepo(await repo({
      "shop/auth.ts": "export const SHOPIFY_API_VERSION = '2026-10';\nexport function getBaseUrl(shop: string) {\n  return `https://${shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}`;\n}\nexport const helpers = {\n  getBaseUrl: (a: any) => getBaseUrl(a.shop),\n};\n",
      "shop/index.ts": "import { http } from 'x';\nimport { helpers } from './auth';\n\nexport const call = (a: any, url: string) => http.send({\n  url: `${helpers.getBaseUrl(a)}${url}`,\n});\n",
    }))).usages;
    expect(lines(us, "shop/auth.ts")).toEqual([1]);
    expect(also(us, "shop/auth.ts", 1)).toContain(3);
    expect(lines(us, "shop/index.ts")).toEqual([5]);
  });

  it("each URL setting given the constant in a file; a version key given an imported version", async () => {
    const us = (await scanRepo(await repo({
      "n/Generic.ts": "export const WA_BASE = 'https://graph.facebook.com/v13.0/';\n",
      "n/Node.ts": "import { WA_BASE } from './Generic';\n\nexport const d = {\n  requestDefaults: { baseURL: WA_BASE },\n  methods: { load: { routing: { request: { baseURL: WA_BASE } } } },\n};\n",
      "fb/__init__.py": "",
      "fb/constants.py": "GRAPH_API_VERSION = 'v19.0'\nGRAPH_API_URL = f'https://graph.facebook.com/{GRAPH_API_VERSION}'\n",
      "fb/provider.py": "from fb.constants import GRAPH_API_VERSION\n\ndef init(app):\n    \"\"\"Facebook JS SDK init\"\"\"\n    return {'appId': app.id, 'version': GRAPH_API_VERSION}\n",
    }))).usages;
    expect(lines(us, "n/Node.ts")).toEqual([4, 5]);
    expect(lines(us, "fb/constants.py")).toEqual([1]);
    expect(also(us, "fb/constants.py", 1)).toContain(2);
    expect(lines(us, "fb/provider.py")).toEqual([5]);
  });
});
