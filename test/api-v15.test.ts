import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v15-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const roles = (us: any[], file: string) => us.filter((u) => u.file === file && u.apiVersion).map((u) => `${u.line} ${u.provider} ${u.apiVersion.split(": ").pop()} ${u.role}`);

describe("v15: a library's own version enum or list is a catalog", () => {
  it("TS enum whose entries are spread out by doc comments", async () => {
    const d = await repo({ "facebook-sdk/src/versions.ts": "// Graph API versions (graph.facebook.com)\nexport enum GraphApiVersion {\n  /**\n   * Graph API version 22.\n   * Deprecated 2027.\n   */\n  V22 = 'v22.0',\n  /**\n   * Graph API version 23.\n   * Deprecated 2027.\n   */\n  V23 = 'v23.0',\n  /**\n   * Graph API version 24.\n   * Deprecated 2028.\n   */\n  V24 = 'v24.0',\n}\n" });
    const r = roles((await scanRepo(d)).usages, "facebook-sdk/src/versions.ts");
    console.log("ROLES", JSON.stringify(r));
    expect(r.filter((x) => x.endsWith(" breaks"))).toEqual([]);
  });

  it("Python Enum class with comments between entries", async () => {
    const d = await repo({ "facebook_sdk/versions.py": "\"\"\"Facebook Graph API versions.\"\"\"\nfrom enum import Enum\n\n\nclass GraphVersion(str, Enum):\n    \"\"\"Supported versions of graph.facebook.com.\"\"\"\n\n    # Graph version, January 2025\n    # Deprecated 2027\n    # See changelog\n    V22_0 = \"v22.0\"\n    # Graph version, May 2025\n    # Deprecated 2027\n    # See changelog\n    V23_0 = \"v23.0\"\n    # Graph version, October 2025\n    # Deprecated 2028\n    # See changelog\n    V24_0 = \"v24.0\"\n" });
    const r = roles((await scanRepo(d)).usages, "facebook_sdk/versions.py");
    console.log("ROLES", JSON.stringify(r));
    expect(r.filter((x) => x.endsWith(" breaks"))).toEqual([]);
  });

  it("Go const block of typed versions", async () => {
    const d = await repo({ "facebook/graph/version.go": "package graph\n\n// Version is a Facebook Graph API version (graph.facebook.com).\ntype Version string\n\nconst (\n\t// V22 is the January 2025 version.\n\t// It expires in 2027.\n\tV22 Version = \"v22.0\"\n\t// V23 is the May 2025 version.\n\t// It expires in 2027.\n\tV23 Version = \"v23.0\"\n\t// V24 is the October 2025 version.\n\t// It expires in 2028.\n\tV24 Version = \"v24.0\"\n)\n" });
    const r = roles((await scanRepo(d)).usages, "facebook/graph/version.go");
    console.log("ROLES", JSON.stringify(r));
    expect(r.filter((x) => x.endsWith(" breaks"))).toEqual([]);
  });

  it("Shopify-style enum of dated versions", async () => {
    const d = await repo({ "shopify-api/lib/api-version.ts": "// Shopify Admin API versions\nexport enum ApiVersion {\n  // Admin API version 2024-10\n  // Supported 12 months\n  October24 = '2024-10',\n  // Admin API version 2025-01\n  // Supported 12 months\n  January25 = '2025-01',\n  // Admin API version 2025-04\n  // Supported 12 months\n  April25 = '2025-04',\n}\n" });
    const r = roles((await scanRepo(d)).usages, "shopify-api/lib/api-version.ts");
    console.log("ROLES", JSON.stringify(r));
    expect(r.filter((x) => x.endsWith(" breaks"))).toEqual([]);
  });

  it("an object keyed by versions, each holding its dates", async () => {
    const d = await repo({ "facebook/src/graph-versions.ts": "// Facebook Graph API version lifecycle (graph.facebook.com)\nexport const GRAPH_VERSIONS = {\n  'v22.0': {\n    released: '2025-01-21',\n    expires: '2027-02-01',\n  },\n  'v23.0': {\n    released: '2025-05-29',\n    expires: '2027-06-01',\n  },\n  'v24.0': {\n    released: '2025-10-08',\n    expires: '2028-01-01',\n  },\n};\n" });
    const r = roles((await scanRepo(d)).usages, "facebook/src/graph-versions.ts");
    console.log("ROLES", JSON.stringify(r));
    expect(r.filter((x) => x.endsWith(" breaks"))).toEqual([]);
  });

  it("negative: an app config holding three products' different versions still breaks", async () => {
    const d = await repo({ "src/config.ts": "export const meta = {\n  facebook: {\n    // Graph for pages\n    graphVersion: 'v19.0',\n  },\n  whatsapp: {\n    // Cloud API\n    graphVersion: 'v20.0',\n  },\n  instagram: {\n    // graph.instagram.com\n    graphVersion: 'v21.0',\n  },\n};\nexport const url = `https://graph.facebook.com/${meta.facebook.graphVersion}/me`;\n" });
    const r = roles((await scanRepo(d)).usages, "src/config.ts");
    expect(r.some((x) => x.startsWith("4 ") && x.endsWith(" breaks"))).toBe(true);
  });
});

describe("v15: another provider's version in a file that also mentions Facebook", () => {
  const breaks = (us: any[], file: string) => us.filter((u) => u.file === file && u.apiVersion && u.role === "breaks" && u.provider === "meta").map((u) => `${u.line} ${u.apiVersion.split(": ").pop()}`);
  it("a social-login config: Facebook's version counts, LinkedIn's and Vimeo's don't", async () => {
    const d = await repo({ "config/social.php": "<?php\nreturn [\n  'facebook' => [\n    'api_version' => 'v19.0',\n  ],\n  'linkedin' => [\n    'api_version' => 'v2.1',\n  ],\n  'vimeo' => [\n    'version' => '3.4',\n    'endpoint' => 'https://api.vimeo.com/v2.1/me',\n  ],\n];\n" });
    expect(breaks((await scanRepo(d)).usages, "config/social.php")).toEqual(["4 v19.0"]);
  });
  it("constants named for another service next to Facebook's", async () => {
    const d = await repo({ "src/social/constants.ts": "export const FACEBOOK_GRAPH_VERSION = 'v20.0';\nexport const TWITTER_API_VERSION = 'v2.1';\nexport const PINTEREST_API_VERSION = 'v5.0';\n" });
    expect(breaks((await scanRepo(d)).usages, "src/social/constants.ts")).toEqual(["1 v20.0"]);
  });
  it("another host's versioned URL in a Facebook file", async () => {
    const d = await repo({ "src/facebook/share.js": "export const fb = 'https://graph.facebook.com/v18.0/me';\nexport const other = 'https://api.example-analytics.com/v2.1/events';\nconst apiVersion = 'v2.1'; // example-analytics\n" });
    expect(breaks((await scanRepo(d)).usages, "src/facebook/share.js")).toEqual(["1 v18.0"]);
  });
});

describe("v15: Meta mining shapes", () => {
  const vers = (us: any[], file: string) => us.filter((u) => u.file === file && u.apiVersion && u.role === "breaks").map((u) => `${u.line} ${u.provider} ${u.apiVersion.split(": ").pop()}`);
  it("Business SDK (Python): the version is v + the package's major.minor, from requirements.txt", async () => {
    const d = await repo({ "requirements.txt": "facebook-business==21.0.3\nrequests\n", "ads.py": "from facebook_business.api import FacebookAdsApi\nfrom facebook_business.adobjects.adaccount import AdAccount\nFacebookAdsApi.init(app_id, app_secret, token)\nAdAccount('act_1').get_campaigns()\n" });
    expect(vers((await scanRepo(d)).usages, "ads.py")).toContain("1 meta-marketing v21.0");
  });
  it("Business SDK (Node) from package-lock.json; and the Python one with api_version= set is left to the explicit value", async () => {
    const d = await repo({ "package.json": '{"dependencies":{"facebook-nodejs-business-sdk":"^23.0.0"}}', "package-lock.json": '{"packages":{"node_modules/facebook-nodejs-business-sdk":{"version":"23.0.1"}}}', "ads.js": "const bizSdk = require('facebook-nodejs-business-sdk');\nconst api = bizSdk.FacebookAdsApi.init(token);\n",
      "py/requirements.txt": "facebook_business>=19.0\n", "py/ads.py": "from facebook_business.api import FacebookAdsApi\nFacebookAdsApi.init(app_id, app_secret, token, api_version='v22.0')\n" });
    const us = (await scanRepo(d)).usages;
    expect(vers(us, "ads.js")).toContain("1 meta-marketing v23.0");
    expect(vers(us, "py/ads.py").join(" ")).not.toMatch(/v19\.0/);
  });
  it("facebook-sdk GraphAPI(version=…) split over lines, and with the version in a name", async () => {
    const d = await repo({ "auth.py": "import facebook\n\ndef me(token):\n    g = facebook.GraphAPI(\n        access_token=token, version=\"3.0\"\n    )\n    return g.get_object('me')\n", "share.py": "from .facebook import GraphAPI\nGRAPH_API_VERSION = \"2.12\"\n\ndef post(token):\n    return GraphAPI(access_token=token, version=GRAPH_API_VERSION)\n" });
    const us = (await scanRepo(d)).usages;
    expect(vers(us, "auth.py")).toContain("4 meta v3.0");
    expect(vers(us, "share.py").join(" ")).toContain("meta v2.12");
  });
  it("two-digit minors, a numeric C# constant after \"v\", PHP define(), and a getter in a template", async () => {
    const d = await repo({
      "Facebook.php": "<?php\nclass Fb {\n  public function url() {\n    $apiversion = '2.12';\n    return 'https://graph.facebook.com/v' . $apiversion . '/me';\n  }\n}\n",
      "FacebookApi.cs": "class FacebookApi {\n  internal const string ApplicationVersion = \"2.8\";\n  string Me() => \"https://graph.facebook.com/v\" + FacebookApi.ApplicationVersion + \"/me\";\n}\n",
      "agent.php": "<?php\ndefine(\"API_VERSION\", 2.8);\n$u = 'https://graph.facebook.com/v' . API_VERSION . '/me';\n",
      "capi.ts": "const DEFAULT_GRAPH_API_VERSION = \"v26.0\";\nfunction graphApiVersion() {\n  const configured = process.env.META_GRAPH_API_VERSION ?? \"\";\n  return configured ? configured : DEFAULT_GRAPH_API_VERSION;\n}\nexport const send = (pixelId: string) => fetch(`https://graph.facebook.com/${graphApiVersion()}/${pixelId}/events`);\n",
    });
    const us = (await scanRepo(d)).usages;
    expect(vers(us, "Facebook.php").join(" ")).toContain("v2.12");
    expect(vers(us, "FacebookApi.cs").join(" ")).toContain("v2.8");
    expect(vers(us, "agent.php").join(" ")).toContain("v2.8");
    expect(vers(us, "capi.ts").join(" ")).toMatch(/meta(-marketing)? v26\.0/);
  });
});

describe("v15: library defaults and options over several lines", () => {
  const vers = (us: any[], file: string) => us.filter((u) => u.file === file && u.apiVersion && u.role === "breaks").map((u) => `${u.line} ${u.provider} ${u.apiVersion.split(": ").pop()}`);
  it("whatsapp-api-js options set a version from an imported constant a few lines below the constructor", async () => {
    const d = await repo({ "package.json": '{"dependencies":{"whatsapp-api-js":"^6.2.1"}}', "src/constants.ts": "export const DEFAULT_API_VERSION = \"v23.0\";\n", "src/client.ts": "import { WhatsAppAPI } from \"whatsapp-api-js\";\nimport { DEFAULT_API_VERSION } from \"./constants\";\nexport const client = (t: string) =>\n  new WhatsAppAPI({\n    token: t,\n    appSecret: s,\n    v: DEFAULT_API_VERSION,\n  });\n" });
    const us = (await scanRepo(d)).usages;
    expect(vers(us, "src/client.ts")).toContain("4 meta v23.0");
    expect(vers(us, "src/client.ts").join(" ")).not.toMatch(/v24\.0/);
  });
  it("older whatsapp-api-js (2.6.0) and ASP.NET Core 3.1 defaults, read from their release sources", async () => {
    const d = await repo({ "package.json": '{"dependencies":{"whatsapp-api-js":"^2.6.0"}}', "package-lock.json": '{"packages":{"node_modules/whatsapp-api-js":{"version":"2.6.0"}}}', "index.js": "const WhatsAppAPI = require('whatsapp-api-js');\nconst wa = new WhatsAppAPI(Node18({ token, appSecret }));\n",
      "web/web.csproj": '<Project><ItemGroup><PackageReference Include="Microsoft.AspNetCore.Authentication.Facebook" Version="3.1.8" /></ItemGroup></Project>', "web/Startup.cs": "services.AddAuthentication().AddFacebook(o => { o.AppId = id; o.AppSecret = secret; });\n" });
    const us = (await scanRepo(d)).usages;
    expect(vers(us, "index.js")).toContain("2 meta v19.0");
    expect(vers(us, "web/Startup.cs")).toContain("1 meta v4.0");
  });
  it("a notebook code cell with GraphAPI(token, version='2.7')", async () => {
    const nb = { cells: [{ cell_type: "code", source: ["import facebook\n", "graph = facebook.GraphAPI(token, version='2.7')\n", "graph.get_object('me')\n"] }] };
    const d = await repo({ "explore.ipynb": JSON.stringify(nb, null, 1) });
    // (reported; notebooks are copies for users, as for model IDs)
    const us = (await scanRepo(d)).usages.filter((u: any) => u.file === "explore.ipynb" && u.apiVersion);
    expect(us.map((u: any) => u.apiVersion).join(" ")).toContain("v2.7");
  });
});
