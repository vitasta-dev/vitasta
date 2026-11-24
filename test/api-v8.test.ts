import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v8-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const at = async (d: string) => (await scanRepo(d)).usages;
const versions = (us: any[], file: string) => us.filter((u) => u.file === file && u.apiVersion).map((u) => `${u.line} ${u.provider} ${u.apiVersion.split(": ").pop()}`);
const params = (us: any[], file: string) => us.filter((u) => u.file === file && u.params?.length).map((u) => `${u.line} ${u.op} ${u.params.join(",")}`);

describe("v8: version variables followed into provider URLs (test set 2)", () => {
  it("a local version variable used later in a Graph URL", async () => {
    const d = await repo({
      "utils/fb.ts": [
        "export async function sendEvent(pixelId: string, token: string) {",
        '  const apiVersion = "v20.0";',
        "  const body = { data: [] };",
        "  const headers = {};",
        "  const timeout = 1000;",
        "  const url = `https://graph.facebook.com/${apiVersion}/${pixelId}/events?access_token=${token}`;",
        "  return fetch(url, { method: 'POST', body: JSON.stringify(body) });",
        "}",
      ].join("\n"),
    });
    // /{pixel}/events is the Conversions API, part of the Marketing API (its own sunset dates, v9)
    expect(versions(await at(d), "utils/fb.ts")).toContain("2 meta-marketing v20.0");
  });

  it("an exported constant another file imports and interpolates; an unrelated same-named constant isn't followed", async () => {
    const d = await repo({
      "social/facebook.provider.ts": "export const META_GRAPH_API_VERSION = 'v25.0';\n",
      "social/instagram.provider.ts": "import { META_GRAPH_API_VERSION } from './facebook.provider';\nexport const auth = `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`;\n",
      "other/threads.ts": "const META_GRAPH_API_VERSION = 'v1.0';\nexport const t = `https://graph.threads.net/${META_GRAPH_API_VERSION}/me`;\n",
    });
    const us = await at(d);
    expect(versions(us, "social/facebook.provider.ts")).toEqual(["1 meta v25.0"]);
    expect(versions(us, "social/instagram.provider.ts")).toEqual(["2 meta v25.0"]);
    expect(versions(us, "other/threads.ts")).toEqual([]);
  });

  it("a Shopify version constant used in a store URL whose host is a variable", async () => {
    const d = await repo({ "shopify/admin-graphql.ts": 'const SHOPIFY_ADMIN_API_VERSION = "2025-04";\nexport const url = (shop: string) => `https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;\n' });
    expect(versions(await at(d), "shopify/admin-graphql.ts")).toContain("1 shopify 2025-04");
  });

  it("a version-led path handed to a helper that adds the host", async () => {
    const d = await repo({ "Integration/FacebookIntegration.php": "<?php\nclass FacebookIntegration {\n  public function getUserData() {\n    return $this->makeRequest($this->getApiUrl('v2.8/me'));\n  }\n}\n" });
    expect(versions(await at(d), "Integration/FacebookIntegration.php")).toEqual(["4 meta v2.8"]);
  });
});

describe("v8: params built in other functions and methods", () => {
  it("JS: a builder's object reaches the SDK call through a wrapper and a callback; each key is reported on its line", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"stripe":"^14.0.0"}}',
      "stripe-api.js": [
        "const Stripe = require('stripe');",
        "class StripeAPI {",
        "  constructor() { this._stripe = new Stripe('sk_test_x'); }",
        "  async _createWithFallback(params, opts) {",
        "    return await this._stripe.checkout.sessions.create(sessionCreateParams(params), opts);",
        "  }",
        "  async _createCheckoutSession(params, opts) {",
        "    return this.tracking.run(() => this._createWithFallback(params, opts));",
        "  }",
        "  async createSetupSession(customer) {",
        "    const stripeSessionOptions = {",
        "      mode: 'setup',",
        "      payment_method_types: ['card'],",
        "    };",
        "    return this._createCheckoutSession(stripeSessionOptions, undefined);",
        "  }",
        "}",
        "function sessionCreateParams(p) { return { ...p }; }",
      ].join("\n"),
    });
    expect(params(await at(d), "stripe-api.js")).toContain("13 POST /v1/checkout/sessions payment_method_types");
  });

  it("JS: a client exported by another module and named after the provider", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"stripe":"^14.0.0"}}',
      "lib/pay.ts": 'import { stripe } from "@/lib/stripe";\nexport const f = () => stripe.paymentIntents.create({ amount: 1, payment_method_types: ["card"] });\n',
    });
    expect(params(await at(d), "lib/pay.ts")).toEqual(["2 POST /v1/payment_intents amount,payment_method_types"]);
  });

  it("Ruby: Stripe::Checkout::Session.create(payload) with the hash built in another method", async () => {
    const d = await repo({
      "Gemfile": "gem 'stripe'\n",
      "app/services/stripe_service.rb": [
        "class StripeService",
        "  def call",
        "    payload = payment_intent_payload",
        "    ::Stripe::PaymentIntent.create(payload, { api_key: key })",
        "    ::Stripe::Checkout::Session.create(session_payload)",
        "  end",
        "  def payment_intent_payload",
        "    payload = {",
        "      amount: 1,",
        "      payment_method_types: ['card'],",
        "    }",
        "    payload[:metadata] = {}",
        "    payload",
        "  end",
        "  def session_payload",
        "    {",
        "      mode: 'payment',",
        "      payment_method_types: ['card'],",
        "    }",
        "  end",
        "end",
      ].join("\n"),
    });
    const p = params(await at(d), "app/services/stripe_service.rb");
    expect(p).toContain("10 POST /v1/payment_intents payment_method_types");
    expect(p).toContain("12 POST /v1/payment_intents metadata");
    expect(p).toContain("18 POST /v1/checkout/sessions payment_method_types");
    // Negative: the options hash after the payload isn't the body
    expect(p.some((s) => s.includes("api_key"))).toBe(false);
  });
});
