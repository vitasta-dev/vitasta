import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v7-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const versions = async (d: string, file: string) =>
  (await scanRepo(d)).usages.filter((u) => u.file === file && u.apiVersion).map((u) => `${u.line} ${u.provider} ${u.apiVersion!.split(": ").pop()} ${u.testRole ?? u.role}`);

describe("v7: API versions outside a full URL (from the test set)", () => {
  it("version constants, defaults and templated paths with the host in a variable", async () => {
    const d = await repo({
      "app/services/whatsapp/cloud_service.rb": [
        "class CloudService",
        "  WHATSAPP_API_VERSION = 'v14.0'.freeze",
        "  def media_url(id)",
        '    "#{api_base_path}/v13.0/#{id}"',
        "  end",
        "  def phone_id_path(version = 'v13.0')",
        "  end",
        "end",
      ].join("\n"),
      "app/controllers/dashboard_controller.rb": "FACEBOOK_API_VERSION: GlobalConfigService.load('FACEBOOK_API_VERSION', 'v18.0'),\n",
      "src/core/constants.ts": 'export const STOREFRONT_API_VERSION = "2026-10";\n',
    });
    expect(await versions(d, "app/services/whatsapp/cloud_service.rb")).toEqual(["2 meta v14.0 breaks", "4 meta v13.0 breaks", "6 meta v13.0 breaks"]);
    expect(await versions(d, "app/controllers/dashboard_controller.rb")).toEqual(["1 meta v18.0 breaks"]);
    expect(await versions(d, "src/core/constants.ts")).toEqual(["1 shopify 2026-10 breaks"]);
  });

  it("config entries name the API near the value; another API's version in the same file doesn't count", async () => {
    const d = await repo({
      "config/installation_config.yml": [
        "- name: FACEBOOK_API_VERSION",
        "  display_title: 'Facebook API Version'",
        "  value: 'v18.0'",
        "- name: TIKTOK_API_VERSION",
        "  display_title: 'TikTok API Version'",
        "  value: 'v1.3'",
        "- name: SHOPIFY_PARTNER_API_VERSION",
        "  value: '2026-07'",
      ].join("\n"),
    });
    expect(await versions(d, "config/installation_config.yml")).toEqual(["3 meta v18.0 breaks"]);
  });

  it("negatives: Threads' v1.0 isn't Graph's; a version list is a catalog; a comment is copy; no provider, no version", async () => {
    const d = await repo({
      "src/threads.ts": 'const FACEBOOK_APP = 1\nconst THREADS_API_VERSION = "v1.0"\nconst url = `${base}/v1.0/me/threads`\n',
      "src/types.ts": "// Shopify Admin API versions\nexport enum ApiVersion {\n  April25 = '2025-04',\n  July25 = '2025-07',\n  October25 = '2025-10',\n}\n",
      "src/docs.ts": "// shopify\n// The Storefront API version defaults to '2026-10'\nexport const x = 1\n",
      "src/other.ts": "const API_VERSION = 'v14.0'\n",
    });
    expect(await versions(d, "src/threads.ts")).toEqual([]);
    const listed = await versions(d, "src/types.ts");
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((s) => s.endsWith("catalog"))).toBe(true);
    expect(await versions(d, "src/docs.ts")).toEqual(["2 shopify 2026-10 users-copy"]);
    expect(await versions(d, "src/other.ts")).toEqual([]);
  });

  it("the Facebook login dialog URL follows Graph's versions", async () => {
    const d = await repo({ "src/providers/facebook.ts": 'export const authorization = { url: "https://www.facebook.com/v19.0/dialog/oauth" }\n' });
    expect(await versions(d, "src/providers/facebook.ts")).toEqual(["1 meta v19.0 breaks"]);
  });
});

describe("v7: light data flow for SDK params", () => {
  it("JS: create(params) with `const params = { … }` earlier in the function; the options argument isn't the body", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"stripe":"^14.0.0"}}',
      "src/pay.ts": [
        "import Stripe from 'stripe'",
        "const stripe = new Stripe('sk_test_x')",
        "export async function hold(customer: string) {",
        "  const params = { customer, payment_method_types: ['card'] }",
        "  return stripe.setupIntents.create(params, { stripeAccount: 'acct_1' })",
        "}",
      ].join("\n"),
    });
    const u = (await scanRepo(d)).usages.find((x) => x.file === "src/pay.ts" && x.op === "POST /v1/setup_intents");
    expect(u?.params).toContain("payment_method_types");
    expect(u?.params).not.toContain("stripeAccount");
  });

  it("Python: create(**params) with params[\"k\"] = … earlier in the function", async () => {
    const d = await repo({
      "requirements.txt": "stripe==7.0.0\n",
      "pay.py": [
        "import stripe",
        "def create_intent(amount, types):",
        "    params = {}",
        '    params["payment_method_types"] = types',
        "    return stripe.PaymentIntent.create(amount=amount, **params)",
      ].join("\n"),
    });
    const u = (await scanRepo(d)).usages.find((x) => x.file === "pay.py" && x.op === "POST /v1/payment_intents");
    expect(u?.params).toEqual(expect.arrayContaining(["amount", "payment_method_types"]));
  });
});

describe("v7: tests that stub or assert a versioned URL assert it", () => {
  it("a WebMock stub or an expectation is test-asserts; a URL only passed as data is test-data", async () => {
    const d = await repo({
      "spec/models/channel_spec.rb": [
        "describe Channel do",
        "  it 'calls graph' do",
        "    stub_request(:post, 'https://graph.facebook.com/v22.0/me/messages')",
        "    expect(channel.base_uri).to eq('https://graph.facebook.com/v22.0')",
        "  end",
        "  let(:payload) { { name: 'a' } }",
        "",
        "",
        "",
        "",
        "",
        "  let(:url) { 'https://graph.facebook.com/v21.0/x' }",
        "end",
      ].join("\n"),
    });
    const v = await versions(d, "spec/models/channel_spec.rb");
    expect(v).toContain("3 meta v22.0 test-asserts");
    expect(v.find((s) => s.startsWith("12 "))).toMatch(/test-data$/);
  });
});
