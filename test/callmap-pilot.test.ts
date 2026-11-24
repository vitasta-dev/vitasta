import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { CallMap, indexFile, type FileIndex } from "../src/scan/callmap.js";
import { parse } from "../src/scan/parser.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-callmap-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
async function cachePack(dir: string): Promise<{ pack: string; at: Record<string, [number, number, number]> }> {
  const sub = (await readdir(dir)).find((n) => n.startsWith("objects-"))!;
  const idx = JSON.parse(await readFile(join(dir, sub, "index.json"), "utf8"));
  return { pack: join(dir, sub, idx.pack), at: idx.at };
}
async function cacheText(dir: string): Promise<string> {
  const { pack, at } = await cachePack(dir);
  const buf = await readFile(pack);
  const blocks = new Map<number, string[]>();
  for (const [o, n] of Object.values(at)) if (!blocks.has(o)) blocks.set(o, JSON.parse(gunzipSync(buf.subarray(o, o + n)).toString("utf8")));
  return [...blocks.values()].flat().join("\n");
}
const at = (us: any[], file: string, provider: string) => us.filter((u) => u.file === file && u.provider === provider && u.role === "breaks").map((u) => u.line);

async function mapOf(files: Record<string, string>): Promise<CallMap> {
  const idx = new Map<string, FileIndex>();
  for (const [rel, src] of Object.entries(files)) {
    const lang = rel.endsWith(".py") ? "py" : "ts";
    const t = await parse(lang, rel, src);
    idx.set(rel, indexFile(lang, t));
    t.delete();
  }
  return new CallMap(idx);
}

describe("call map: links across files", () => {
  it("follows re-exports to the definition, and an import path to exactly one file", async () => {
    const m = await mapOf({
      "a/graphRequest.ts": "export const graphRequest = { get() {} };\n",
      "a/utils.ts": "export { graphRequest } from './graphRequest';\nexport * from './more';\n",
      "a/more.ts": "export function extra() {}\n",
      "a/page.ts": "import { graphRequest as gr, extra } from './utils';\n",
    });
    expect(m.resolveLocal("a/page.ts", "gr")).toMatchObject({ file: "a/graphRequest.ts", def: { name: "graphRequest", kind: "object" } });
    expect(m.resolveLocal("a/page.ts", "extra")).toMatchObject({ file: "a/more.ts", def: { name: "extra", kind: "function" } });
  });

  it("an alias path two files end with resolves to neither (a missed link, not a guess)", async () => {
    const m = await mapOf({
      "x/queries/common.ts": "export const V = '2026-04';\n",
      "y/queries/common.ts": "export const V = '2026-04';\n",
      "z/use.ts": "import { V } from '@/queries/common';\n",
    });
    expect(m.resolveLocal("z/use.ts", "V")).toBeUndefined();
  });

  it("Python: relative and absolute modules, imported names re-exported by a package", async () => {
    const m = await mapOf({
      "pkg/__init__.py": "from .client import make\n",
      "app/__init__.py": "",
      "pkg/client.py": "def make():\n    pass\n",
      "app/run.py": "from pkg import make\n",
    });
    expect(m.resolveLocal("app/run.py", "make")).toMatchObject({ file: "pkg/client.py", def: { name: "make" } });
  });

  it("an outside package through the repo's own module", async () => {
    const m = await mapOf({
      "polar/__init__.py": "",
      "polar/integrations/__init__.py": "",
      "polar/integrations/stripe/__init__.py": "import stripe as stripe_lib\n",
      "polar/integrations/stripe/service.py": "from polar.integrations.stripe import stripe_lib\n",
    });
    expect(m.resolveExternal("polar/integrations/stripe/service.py", "stripe_lib")).toEqual({ spec: "stripe", name: "*" });
  });

  it("Python: `import stripe` isn't a same-named script elsewhere in the repo", async () => {
    const m = await mapOf({
      "server/polar/__init__.py": "",
      "server/polar/pay/__init__.py": "import stripe as stripe_lib\n",
      "dev/cli/commands/polar.py": "",
      "dev/cli/commands/stripe.py": "def run():\n    pass\n",
    });
    expect(m.resolveExternal("server/polar/pay/__init__.py", "stripe_lib")).toEqual({ spec: "stripe", name: "*" });
    const imp = m.get("server/polar/pay/__init__.py")!.imports[0];
    expect(m.resolveSpec("server/polar/pay/__init__.py", imp.spec)).toBeUndefined();
  });

  it("the index holds structure, never string values", async () => {
    const m = await mapOf({ "k.ts": "export const KEY = 'sk_live_secret_value';\nexport function f(a, b) { return call({ temperature: 0 }); }\n" });
    const text = JSON.stringify(m.get("k.ts"));
    expect(text).not.toContain("sk_live");
    expect(text).toContain("temperature");
  });
});

describe("call map: traces from provider calls", () => {
  it("a version set inside an exported wrapper reaches the files calling it through a re-export", async () => {
    const us = (await scanRepo(await repo({
      "fb/graphRequest.ts": [
        "import * as graph from 'fbgraph';",
        "export const graphRequest = {",
        "  base(method: string, path: string) {",
        "    graph.setVersion('7.0');",
        "    return graph[method](path);",
        "  },",
        "  get(...args) { return this.base('get', ...args); },",
        "};",
      ].join("\n"),
      "fb/utils.ts": "export { graphRequest } from './graphRequest';\n",
      "fb/pages.ts": "import { graphRequest } from './utils';\n\nexport const pages = () => graphRequest.get('/me/accounts');\n",
    }))).usages;
    const p = us.find((u: any) => u.file === "fb/pages.ts" && u.provider === "meta");
    expect(p?.line).toBe(3);
    expect(p?.reason).toContain("fb/graphRequest.ts:4");
  });

  it("an exported constant with a versioned URL, used by name in another file and as a baseURL setting", async () => {
    const us = (await scanRepo(await repo({
      "c/constant.ts": "export const accessTokenEndpoint = 'https://graph.facebook.com/v13.0/oauth/access_token';\n",
      "c/index.ts": "import { got } from 'got';\nimport { accessTokenEndpoint } from './constant';\n\nexport const token = () => got.post(accessTokenEndpoint, {});\n",
      "w/Generic.ts": "export const WA_BASE = 'https://graph.facebook.com/v13.0/';\n",
      "w/Node.ts": "import { WA_BASE } from './Generic';\n\nexport const description = {\n  requestDefaults: {\n    baseURL: WA_BASE,\n  },\n};\n",
    }))).usages;
    expect(at(us, "c/index.ts", "meta")).toEqual([4]);
    expect(at(us, "w/Node.ts", "meta")).toEqual([5]);
  });

  it("an imported version resolves by the import path when two modules define the same name", async () => {
    const us = (await scanRepo(await repo({
      "admin/queries/common.ts": "export const SHOPIFY_API_VERSION = '2024-01'\n",
      "admin/client.ts": "import { SHOPIFY_API_VERSION } from './queries/common'\n\nexport const url = (shop: string) => `https://${shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`\n",
      "store/queries/common.ts": "export const SHOPIFY_API_VERSION = '2024-01'\n",
    }))).usages;
    expect(at(us, "admin/client.ts", "shopify")).toEqual([3]);
  });

  it("Python: keys a caller sets on params a wrapper passes to the SDK, through a module-level instance", async () => {
    const us = (await scanRepo(await repo({
      "app/__init__.py": "",
      "app/stripe/__init__.py": "import stripe as stripe_lib\n",
      "app/stripe/service.py": [
        "from app.stripe import stripe_lib",
        "",
        "class StripeService:",
        "    async def create_payment_intent(self, **params):",
        "        return await stripe_lib.PaymentIntent.create_async(**params)",
        "",
        "stripe = StripeService()",
      ].join("\n"),
      "app/checkout.py": [
        "from app.stripe.service import stripe as stripe_service",
        "",
        "async def confirm(checkout):",
        "    params = {\"amount\": checkout.amount}",
        "    params[\"payment_method_types\"] = checkout.types",
        "    return await stripe_service.create_payment_intent(",
        "        **params",
        "    )",
      ].join("\n"),
    }))).usages;
    const pmt = us.find((u: any) => u.file === "app/checkout.py" && u.params?.includes("payment_method_types"));
    expect(pmt).toMatchObject({ line: 5, op: "POST /v1/payment_intents", provider: "stripe" });
    expect(pmt?.reason).toContain("app/stripe/service.py:5");
  });

  it("Python: a version bound over several parenthesized lines, and a holder used in another module", async () => {
    const us = (await scanRepo(await repo({
      "fb/__init__.py": "",
      "fb/constants.py": [
        "from django.conf import settings",
        "GRAPH_API_VERSION = (",
        "    getattr(settings, 'SOCIALACCOUNT_PROVIDERS', {})",
        "    .get('facebook', {})",
        "    .get('VERSION', 'v19.0')",
        ")",
        "GRAPH_API_URL = (",
        "    getattr(settings, 'SOCIALACCOUNT_PROVIDERS', {})",
        "    .get('facebook', {})",
        "    .get('GRAPH_API_URL', f'https://graph.facebook.com/{GRAPH_API_VERSION}')",
        ")",
      ].join("\n"),
      "fb/flows.py": "import requests\nfrom fb.constants import (\n    GRAPH_API_URL,\n)\n\ndef me(token):\n    return requests.get(f'{GRAPH_API_URL}/me', params={'access_token': token})\n",
    }))).usages;
    expect(at(us, "fb/flows.py", "meta")).toEqual([7]);
  });

  it("an SDK option set from a member of an imported namespace", async () => {
    const us = (await scanRepo(await repo({
      "wa/misc/constants.ts": "export namespace WHATSAPP {\n  export const API_VERSION = 'v22.0'\n}\n",
      "wa/auth.ts": "import WhatsAppAPI from 'whatsapp-api-js'\nimport { WHATSAPP } from './misc/constants'\n\nexport const client = (token: string) => new WhatsAppAPI({ token, v: WHATSAPP.API_VERSION })\n",
    }))).usages;
    expect(at(us, "wa/auth.ts", "meta")).toEqual([4]);
  });
});

describe("scan cache", () => {
  it("a second scan reads the cache and gives the same findings; the cache holds no code lines", async () => {
    const files = {
      "c/constant.ts": "export const accessTokenEndpoint = 'https://graph.facebook.com/v13.0/oauth/access_token';\n",
      "c/index.ts": "import { got } from 'got';\nimport { accessTokenEndpoint } from './constant';\n\nexport const token = () => got.post(accessTokenEndpoint, { secretish: 'zzz-code-text-zzz' });\n",
      "ai.py": "import anthropic\nc = anthropic.Anthropic()\nc.messages.create(model='claude-3-opus-20240229', max_tokens=10, messages=[])\n",
    };
    const root = await repo(files);
    const cacheDir = await mkdtemp(join(tmpdir(), "vitasta-cache-"));
    const a = (await scanRepo(root, { cacheDir })).usages;
    const b = (await scanRepo(root, { cacheDir })).usages;
    const norm = (us: any[]) => JSON.stringify(us.map((u) => Object.fromEntries(Object.entries(u).sort())));
    expect(norm(b)).toBe(norm(a));
    expect(a.length).toBeGreaterThan(0);
    const raw = await cacheText(cacheDir);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).not.toContain("zzz-code-text-zzz");
    expect(raw).not.toContain("got.post(");
    // No file paths in entry names; folder 0700, entries 0600
    const names = (await readdir(cacheDir, { recursive: true })).join("\n");
    expect(names).not.toContain("constant");
    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    // A changed file is analyzed again
    await writeFile(join(root, "ai.py"), "import anthropic\nc = anthropic.Anthropic()\n\nc.messages.create(model='claude-3-opus-20240229', max_tokens=10, messages=[])\n");
    const c = (await scanRepo(root, { cacheDir })).usages;
    expect(c.find((u: any) => u.file === "ai.py" && u.model)?.line).toBe(4);
  });

  it("cache entries that aren't valid are ignored, and entries a scan doesn't use are removed", async () => {
    const root = await repo({ "ai.py": "import anthropic\nc = anthropic.Anthropic()\nc.messages.create(model='claude-3-opus-20240229', max_tokens=10, messages=[])\n" });
    const cacheDir = await mkdtemp(join(tmpdir(), "vitasta-cache-"));
    await scanRepo(root, { cacheDir });
    const before = await cachePack(cacheDir);
    const n = Object.keys(before.at).length;
    expect(n).toBeGreaterThan(0);
    await writeFile(before.pack, "not gzip at all, not gzip at all, not gzip at all");
    const us = (await scanRepo(root, { cacheDir })).usages;
    expect(us.some((u: any) => u.model === "claude-3-opus-20240229")).toBe(true);
    // A changed file: its old entries go
    await writeFile(join(root, "ai.py"), "import anthropic\nc = anthropic.Anthropic()\n\nc.messages.create(model='claude-3-opus-20240229', max_tokens=10, messages=[])\n");
    await scanRepo(root, { cacheDir });
    const after = await cachePack(cacheDir);
    expect(Object.keys(after.at).length).toBe(n);
    expect((await readdir(join(after.pack, ".."))).filter((f) => f.endsWith(".bin")).length).toBe(1);
  });
});
