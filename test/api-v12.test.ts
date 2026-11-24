import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v12-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const versionsIn = async (d: string, file: string) => (await scanRepo(d)).usages.filter((u) => u.file === file && u.apiVersion).map((u) => `${u.line} ${u.apiVersion}`);

const SHOPIFY = "packages/shopify/src/index.ts";
const shopify = { [SHOPIFY]: "const SHOPIFY_VERSION = '2026-10';\nexport function getBaseUrl(shop: string) {\n  return `https://${shop}/admin/api/${SHOPIFY_VERSION}`;\n}\n" };

describe("v12: a getter or holder resolves only through its real import path (test set 7)", () => {
  it("positive: imported by a relative path that leads to the defining module", async () => {
    const d = await repo({ ...shopify, "packages/shopify/src/products.ts": "import { getBaseUrl } from './index';\nexport const p = (s: string) => fetch(`${getBaseUrl(s)}/products.json`);\n" });
    expect(await versionsIn(d, "packages/shopify/src/products.ts")).toEqual(["2 url: 2026-10"]);
  });

  it("negatives: another package's own getBaseUrl, a class method, a local declaration, a re-export, a package import", async () => {
    const d = await repo({
      ...shopify,
      // An unrelated package with its own getBaseUrl, called by name
      "packages/notes/src/base.ts": "export const getBaseUrl = (subdomain: string) => `https://${subdomain}.notes.example.com`;\n",
      "packages/notes/src/api.ts": "import { getBaseUrl } from './base';\nexport const list = (s: string) => ({ url: getBaseUrl(s) + '/note/list' });\n",
      // A class method with the same name
      "packages/cloud/src/client.ts": "export class Client {\n  getBaseUrl(cloud: string) { return `https://${cloud}.example.com`; }\n  run(cloud: string) { const baseUrl = this.getBaseUrl(cloud); return baseUrl; }\n}\n",
      // A local declaration in the using file
      "packages/misc/src/util.ts": "function getBaseUrl({ host }: { host: string }) { return `https://${host}`; }\nexport const u = getBaseUrl({ host: 'x' }) + '/a';\n",
      // A re-export list
      "packages/shopify/index.ts": "export {\n  getBaseUrl,\n} from './src/index';\n",
      // Another package's export imported by package name: not resolvable to the Shopify module
      "apps/web/src/page.ts": "import { getBaseUrl } from '@acme/notes';\nexport const go = (s: string) => fetch(getBaseUrl(s) + '/x');\n",
    });
    for (const f of ["packages/notes/src/api.ts", "packages/cloud/src/client.ts", "packages/misc/src/util.ts", "packages/shopify/index.ts", "apps/web/src/page.ts"]) {
      expect(await versionsIn(d, f), f).toEqual([]);
    }
  });

  it("an object property holder resolves through the object's import, not by the property name alone", async () => {
    const d = await repo({
      "src/constants.ts": "const API_VERSION = 'v22.0';\nexport const META = {\n  API_VERSION,\n  API_URL: `https://graph.facebook.com/${API_VERSION}`,\n};\n",
      "src/send.ts": "import { META } from './constants';\nexport const send = (id: string) => fetch(META.API_URL + `/${id}/messages`);\n",
      "src/other.ts": "const SLACK = { API_URL: 'https://slack.com/api' };\nexport const x = fetch(SLACK.API_URL + '/chat.postMessage');\n",
    });
    expect(await versionsIn(d, "src/send.ts")).toEqual(["2 url: v22.0"]);
    expect(await versionsIn(d, "src/other.ts")).toEqual([]);
  });
});
