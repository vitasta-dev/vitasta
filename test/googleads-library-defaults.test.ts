import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 120_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-gadefaults-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return ((await scanRepo(d)).usages as any[]).filter((u) => u.provider === "googleads" && u.apiVersion?.startsWith("default: "));
};
const at = (us: any[]) => us.map((u) => `${u.file}:${u.line} ${u.apiVersion}`).sort();

const TS = `import { GoogleAdsApi } from "google-ads-api";\nconst client = new GoogleAdsApi({\n  client_id: "x",\n  client_secret: "y",\n  developer_token: "z",\n});\nexport const customer = client.Customer({ customer_id: "1", refresh_token: "r" });\n`;
const pkg = (v: string) => `{\n  "dependencies": {\n    "google-ads-api": "${v}"\n  }\n}\n`;

describe("npm google-ads-api: the API version is the release's major", () => {
  it("reports the default at the client construction and at the package.json line", async () => {
    expect(at(await scan({ "package.json": pkg("^23.0.1"), "src/ads.ts": TS }))).toEqual(["package.json:3 default: v23", "src/ads.ts:2 default: v23"]);
  });
  it("each release maps to its own default (a lockfile wins over the range)", async () => {
    const lock = (v: string) => `{\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/google-ads-api": {\n      "version": "${v}"\n    }\n  }\n}\n`;
    for (const [v, want] of [["14.2.0", "v14"], ["16.0.0", "v16"], ["17.1.0", "v17"], ["22.0.0", "v22"], ["24.1.0", "v24"], ["26.1.0", "v26"]]) {
      const us = await scan({ "package.json": pkg("^1.0.0"), "package-lock.json": lock(v), "ads.js": TS.replace('import { GoogleAdsApi } from "google-ads-api";', 'const { GoogleAdsApi } = require("google-ads-api");') });
      expect(us.map((u) => u.apiVersion), v).toContain(`default: ${want}`);
      expect(us.some((u) => u.file === "ads.js"), v).toBe(true);
    }
  });
  it("negatives: the app sets the version, no client is constructed, a release the map doesn't know", async () => {
    expect(await scan({ "package.json": pkg("^23.0.1"), "src/ads.ts": TS.replace("developer_token: \"z\",", "developer_token: \"z\",\n  googleAdsVersion: \"v22\",") })).toEqual([]);
    expect(await scan({ "package.json": pkg("^23.0.1"), "src/types.ts": 'import type { Customer } from "google-ads-api";\nexport type C = Customer;\n' })).toEqual([]);
    expect(await scan({ "package.json": pkg("^30.0.0"), "src/ads.ts": TS })).toEqual([]);
    // a different package that has a GoogleAdsApi class of its own
    expect(await scan({ "package.json": pkg("^23.0.1").replace("google-ads-api", "other-lib"), "src/ads.ts": TS.replace("google-ads-api", "other-lib") })).toEqual([]);
  });
});

describe("npm google-ads-node: the root exports are one version's clients", () => {
  const NODE = `import { GoogleAdsServiceClient } from "google-ads-node";\nexport const c = new GoogleAdsServiceClient({ sslCreds: undefined });\n`;
  const pkgN = (v: string) => `{\n  "dependencies": {\n    "google-ads-node": "${v}"\n  }\n}\n`;
  it("a release maps to the version its index aliases (only the releases read are listed)", async () => {
    expect(at(await scan({ "package.json": pkgN("^24.1.0"), "src/ads.ts": NODE }))).toEqual(["package.json:3 default: v24", "src/ads.ts:2 default: v24"]);
    expect((await scan({ "package.json": pkgN("19.0.0"), "src/ads.ts": NODE })).map((u) => u.apiVersion)).toContain("default: v22");
  });
  it("negatives: an explicit version namespace, a release not read, no client constructed", async () => {
    expect(await scan({ "package.json": pkgN("^24.1.0"), "src/ads.ts": 'import { v23 } from "google-ads-node";\nexport const c = new v23.GoogleAdsServiceClient({});\n' })).toEqual([]);
    expect(await scan({ "package.json": pkgN("^21.0.0"), "src/ads.ts": NODE })).toEqual([]);
    expect(await scan({ "package.json": pkgN("^24.1.0"), "src/ads.ts": 'import type { GoogleAdsServiceClient } from "google-ads-node";\nexport type C = GoogleAdsServiceClient;\n' })).toEqual([]);
  });
});

describe("PyPI google-ads: get_service / get_type use the release's default unless a version is given", () => {
  const req = "google-ads==31.2.0\n";
  const PY = (body: string) => `from google.ads.googleads.client import GoogleAdsClient\nclient = GoogleAdsClient.load_from_storage()\n${body}\n`;
  it("get_service and get_type with a literal type name, no version", async () => {
    expect(at(await scan({ "requirements.txt": req, "a.py": PY('svc = client.get_service("GoogleAdsService")') }))).toEqual(["a.py:3 default: v25", "requirements.txt:1 default: v25"]);
    expect(at(await scan({ "requirements.txt": req, "b.py": PY('op = client.get_type("CampaignOperation")') })).join()).toContain("b.py:3 default: v25");
  });
  it("negatives: version= on the call, on the client's load, or no get_service at all", async () => {
    expect(await scan({ "requirements.txt": req, "a.py": PY('svc = client.get_service("GoogleAdsService", version="v23")') })).toEqual([]);
    expect(await scan({ "requirements.txt": req, "a.py": `from google.ads.googleads.client import GoogleAdsClient\nclient = GoogleAdsClient.load_from_storage(version="v24")\nsvc = client.get_service("GoogleAdsService")\n` })).toEqual([]);
    expect(await scan({ "requirements.txt": req, "a.py": PY("x = 1") })).toEqual([]);
    // another library's get_service
    expect(await scan({ "requirements.txt": "boto3==1.0.0\n", "a.py": 'svc = container.get_service("MyService")\n' })).toEqual([]);
  });
});
