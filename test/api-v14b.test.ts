import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v14b-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const breaks = (us: any[], file: string) => us.filter((u) => u.file === file && u.apiVersion && u.role === "breaks").map((u) => `${u.line} ${u.provider} ${u.apiVersion.split(": ").pop()}`);

describe("v14b: Meta versions (pattern 1)", () => {
  it("over the read budget, app code naming a provider host is kept ahead of tests", async () => {
    const big = "// openai test fixture\n" + "const x = 'openai';\n".repeat(3000);
    const d = await repo({
      "packages/a/test/fixture1.test.ts": big,
      "packages/a/test/fixture2.test.ts": big,
      "packages/nodes-base/nodes/WhatsApp/constants.ts": "export const WHATSAPP_BASE_URL = 'https://graph.facebook.com/v13.0/';\n",
    });
    const warns: string[] = [];
    const r = await scanRepo(d, { maxSourceBytes: big.length + 500, onWarn: (w) => warns.push(w) });
    expect(breaks(r.usages, "packages/nodes-base/nodes/WhatsApp/constants.ts")).toContain("1 meta v13.0");
    expect(warns.join(" ")).toMatch(/read budget/);
  });

  it("a tagged template with the version followed directly by ${", async () => {
    const d = await repo({ "src/fb.ts": "export const me = (resource: string) => requestUrl`https://graph.facebook.com/v21.0${resource}`;\n" });
    expect(breaks((await scanRepo(d)).usages, "src/fb.ts")).toContain("1 meta v21.0");
  });

  it("Python: a numeric version setting put into a v{version} template (.format, f-string)", async () => {
    const d = await repo({
      "social/backends/facebook.py": "class FacebookOAuth2(BaseOAuth2):\n    API_VERSION = 24.0\n    AUTHORIZATION_URL = 'https://www.facebook.com/v{version}/dialog/oauth'\n\n    def user_data(self, token):\n        version = self.setting('API_VERSION', self.API_VERSION)\n        url = 'https://graph.facebook.com/v{version}/me'.format(version=version)\n        return self.get_json(url)\n\n    def other(self):\n        return self.get_json(f'https://graph.facebook.com/v{self.API_VERSION}/me/permissions')\n",
    });
    const b = breaks((await scanRepo(d)).usages, "social/backends/facebook.py");
    expect(b).toContain("2 meta v24.0");
  });

  it("Python: a string version setting in a {version} template (Shopify 2020-10)", async () => {
    const d = await repo({
      "social/backends/shopify.py": "class ShopifyOAuth2(BaseOAuth2):\n    API_VERSION = '2020-10'\n\n    def user_data(self, token, shop):\n        version = self.setting('API_VERSION', self.API_VERSION)\n        return self.get_json('https://{shop}.myshopify.com/admin/api/{version}/shop.json'.format(shop=shop, version=version))\n",
    });
    expect(breaks((await scanRepo(d)).usages, "social/backends/shopify.py")).toContain("2 shopify 2020-10");
  });

  it("an SDK setter in a shared wrapper module (fbgraph setVersion), and the modules that import it", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"fbgraph":"^1.4.4"}}',
      "lib/graph.js": "const graph = require('fbgraph');\ngraph.setVersion('7.0');\nmodule.exports = graph;\n",
      "routes/me.js": "const graph = require('../lib/graph');\nexports.me = (req, res) => graph.get('me', (err, r) => res.json(r));\n",
    });
    const us = (await scanRepo(d)).usages;
    expect(breaks(us, "lib/graph.js")).toContain("2 meta v7.0");
    expect(breaks(us, "routes/me.js").join(" ")).toContain("meta v7.0");
  });

  it("Python: a version from getattr(settings, …, 'v19.0') joined into a URL constant other modules import", async () => {
    const d = await repo({
      "allauth/socialaccount/providers/facebook/constants.py": "from django.conf import settings\nGRAPH_API_VERSION = getattr(settings, 'SOCIALACCOUNT_PROVIDERS', {}).get('facebook', {}).get('VERSION', 'v19.0')\nGRAPH_API_URL = 'https://graph.facebook.com/' + GRAPH_API_VERSION\n",
      "allauth/socialaccount/providers/facebook/views.py": "import requests\nfrom .constants import GRAPH_API_URL\n\ndef me(token):\n    return requests.get(GRAPH_API_URL + '/me', params={'access_token': token})\n",
    });
    const us = (await scanRepo(d)).usages;
    expect(breaks(us, "allauth/socialaccount/providers/facebook/constants.py").join(" ")).toContain("meta v19.0");
    expect(breaks(us, "allauth/socialaccount/providers/facebook/views.py")).toContain("5 meta v19.0");
  });

  it("config: a YAML provider catalog with a live dialog URL", async () => {
    const d = await repo({ "config/providers.yaml": "facebook:\n  authorization_url: https://www.facebook.com/v22.0/dialog/oauth\n  token_url: https://graph.facebook.com/v22.0/oauth/access_token\n" });
    const b = breaks((await scanRepo(d)).usages, "config/providers.yaml");
    expect(b.join(" ")).toContain("meta v22.0");
  });

  it("Google Ads: a version constant in a baseURL template (n8n requestDefaults)", async () => {
    const d = await repo({ "nodes/GoogleAds/GoogleAds.node.ts": "const API_VERSION = 'v25';\nexport const description = {\n  requestDefaults: {\n    baseURL: `https://googleads.googleapis.com/${API_VERSION}`,\n  },\n};\n" });
    expect(breaks((await scanRepo(d)).usages, "nodes/GoogleAds/GoogleAds.node.ts").join(" ")).toMatch(/googleads v25/);
  });
});
