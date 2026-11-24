import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v13-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usagesIn = async (d: string, file: string) => (await scanRepo(d)).usages.filter((u) => u.file === file);
const versions = (us: any[]) => us.filter((u) => u.apiVersion).map((u) => `${u.line} ${u.provider} ${u.apiVersion.split(": ").pop()}`);
const params = (us: any[]) => us.filter((u) => u.params?.length).map((u) => `${u.line} ${u.op} ${u.params.join(",")}`);

describe("v13: Microsoft Graph's names and versions aren't Meta's", () => {
  it("GRAPH_API_VERSIONS = ['v1.0', 'beta'] in an Outlook integration isn't Meta Graph v1.0", async () => {
    const d = await repo({
      "src/integrations/outlook/constants.ts": "export const GRAPH_API_VERSIONS = ['v1.0', 'beta'];\nexport const GRAPH_API_VERSION = 'v1.0';\nexport const BASE = 'https://graph.microsoft.com';\n",
      "src/integrations/outlook/mail.ts": "import { GRAPH_API_VERSION } from './constants';\nconst GRAPH_API = `https://graph.microsoft.com/${GRAPH_API_VERSION}`;\nexport const list = () => fetch(`${GRAPH_API}/me/messages`);\n",
    });
    for (const f of ["src/integrations/outlook/constants.ts", "src/integrations/outlook/mail.ts"]) expect(versions(await usagesIn(d, f)).filter((v) => v.includes(" meta ")), f).toEqual([]);
  });

  it("negative of the negative: a Meta-prefixed version name still counts", async () => {
    const d = await repo({ "src/fb.ts": "export const FB_GRAPH_VERSION = 'v19.0';\n" });
    expect(versions(await usagesIn(d, "src/fb.ts"))).toEqual(["1 meta v19.0"]);
  });
});

describe("v13: Stripe params through wrappers and direct calls", () => {
  it("Python: direct kwargs, async calls, and **params into a service method in another file", async () => {
    const d = await repo({
      "requirements.txt": "stripe==11.0.0\n",
      "payments/direct.py": "import stripe\nclass Pay:\n    def charge(self, amount):\n        return stripe.PaymentIntent.create(\n            amount=amount,\n            payment_method_types=[self.method],\n            confirm=True,\n        )\n",
      "payments/service.py": "import stripe\nclass StripeService:\n    async def create_payment_intent(self, **kwargs):\n        return await stripe.PaymentIntent.create_async(**kwargs)\n",
      "payments/checkout.py": "from .service import StripeService\nstripe_service = StripeService()\nasync def checkout(amount):\n    params = {'amount': amount}\n    params['payment_method_types'] = ['card']\n    return await stripe_service.create_payment_intent(**params)\n",
    });
    expect(params(await usagesIn(d, "payments/direct.py")).join("\n")).toContain("payment_method_types");
    expect(params(await usagesIn(d, "payments/checkout.py"))).toContain("5 POST /v1/payment_intents payment_method_types");
  });

  it("Ruby: a hash on the next line, and update(id, k: v)", async () => {
    const d = await repo({
      Gemfile: "gem 'stripe', '~> 10.0'\n",
      "app/services/pay.rb": "class Pay\n  def go(id)\n    Stripe::PaymentIntent.create(\n      {\n        amount: 1,\n        payment_method_types: ['card'],\n      }\n    )\n    Stripe::PaymentIntent.update(id, payment_method_types: ['card'])\n  end\nend\n",
    });
    const p = params(await usagesIn(d, "app/services/pay.rb"));
    expect(p.join("\n")).toContain("POST /v1/payment_intents amount,payment_method_types");
    expect(p).toContain("9 POST /v1/payment_intents/{id} payment_method_types");
  });

  it("C#: target-typed new() and a C# 12 collection expression, handed to the app's adapter", async () => {
    const d = await repo({
      "app.csproj": '<Project><ItemGroup><PackageReference Include="Stripe.net" Version="47.0.0" /></ItemGroup></Project>',
      "Billing.cs": "using Stripe;\nclass Billing {\n  async Task Go() {\n    SetupIntentCreateOptions options = new()\n    {\n      PaymentMethodTypes = [\"card\"],\n    };\n    await _stripeAdapter.CreateSetupIntentAsync(options);\n  }\n}\n",
    });
    expect(params(await usagesIn(d, "Billing.cs"))).toContain("6 POST /v1/setup_intents payment_method_types");
  });

  it("PHP: $options['k'] = … in one method, then $this->createPayment($options) → $this->client->paymentIntents->create", async () => {
    const d = await repo({
      "composer.json": '{"require":{"stripe/stripe-php":"^16.0"}}',
      "src/Gateway.php": "<?php\nuse Stripe\\StripeClient;\nclass Gateway {\n  public function charge($amount) {\n    $options = ['amount' => $amount];\n    $options['payment_method_types'] = ['card'];\n    return $this->createPayment($options);\n  }\n  private function createPayment($options) {\n    return $this->client->paymentIntents->create($options);\n  }\n}\n",
    });
    expect(params(await usagesIn(d, "src/Gateway.php"))).toContain("6 POST /v1/payment_intents payment_method_types");
  });
});

describe("v13: versioned base-URL constants joined with a path", () => {
  it("an imported WHATSAPP_API_BASE (v23.0) + path, resolved through the import", async () => {
    const d = await repo({
      "src/constants.ts": "export const WHATSAPP_API_BASE = 'https://graph.facebook.com/v23.0';\n",
      "src/sender.ts": "import { WHATSAPP_API_BASE } from './constants';\nexport const send = (id: string, body: string) => fetch(`${WHATSAPP_API_BASE}/${id}/messages`, { method: 'POST', body });\n",
      "src/other.ts": "const WHATSAPP_API_BASE = 'https://example.com';\nexport const x = fetch(`${WHATSAPP_API_BASE}/a`);\n",
    });
    expect(versions(await usagesIn(d, "src/sender.ts"))).toContain("2 meta v23.0");
    expect(versions(await usagesIn(d, "src/other.ts"))).toEqual([]);
  });

  it("Google Ads: API_VERSION = 'v25' in googleads.googleapis.com/${API_VERSION}${path}", async () => {
    const d = await repo({ "ads/client.ts": "const API_VERSION = 'v25';\nexport const call = (path: string) => fetch(`https://googleads.googleapis.com/${API_VERSION}${path}`);\n" });
    expect(versions(await usagesIn(d, "ads/client.ts"))).toContain("1 googleads v25");
  });

  it("a base with a path ({ baseUrl: 'https://api.openai.com/v1' }) + '/audio/translations' is that operation", async () => {
    const d = await repo({ "ai/whisper.ts": "const config = { baseUrl: 'https://api.openai.com/v1' };\nexport const translate = (form: FormData) => fetch(config.baseUrl + '/audio/translations', { method: 'POST', body: form });\n" });
    expect((await usagesIn(d, "ai/whisper.ts")).map((u) => u.op)).toContain("POST /v1/audio/translations");
  });

  it("two literal URLs with the same version in one file are two places", async () => {
    const d = await repo({ "auth/fb.ts": "export const token = (q: string) => fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${q}`);\nexport const me = (t: string) => fetch(`https://graph.facebook.com/v19.0/me?access_token=${t}`);\n" });
    const v = versions(await usagesIn(d, "auth/fb.ts"));
    expect(v.some((s) => s.startsWith("1 "))).toBe(true);
    expect(v.some((s) => s.startsWith("2 "))).toBe(true);
  });
});

describe("v13: config objects, Shopify enums, Ruby chains, library defaults, AI SDK models, env files", () => {
  it("WA_BUSINESS.VERSION resolves to the VERSION inside WA_BUSINESS, though other files bind VERSION too", async () => {
    const d = await repo({
      "src/config.ts": "export const WA_BUSINESS = {\n  VERSION: process.env.WA_BUSINESS_VERSION || 'v18.0',\n  PHONE: process.env.WA_PHONE,\n};\n",
      "src/other.ts": "export const SHOP = {\n  VERSION: '2024-10',\n};\nexport const META2 = { VERSION: 'v20.0' };\n",
      "src/wa.ts": "import { WA_BUSINESS } from './config';\nexport const send = (id: string) => fetch(`https://graph.facebook.com/${WA_BUSINESS.VERSION}/${id}/messages`, { method: 'POST' });\n",
    });
    expect(versions(await usagesIn(d, "src/wa.ts"))).toContain("2 meta v18.0");
  });

  it("Shopify ApiVersion.July25 in a codegen config is 2025-07", async () => {
    const d = await repo({ ".graphqlrc.ts": "import { ApiVersion } from '@shopify/shopify-api';\nimport { shopifyApiProject, ApiType } from '@shopify/api-codegen-preset';\nexport default { projects: { default: shopifyApiProject({ apiType: ApiType.Admin, apiVersion: ApiVersion.July25 }) } };\n" });
    expect(versions(await usagesIn(d, ".graphqlrc.ts")).join(" ")).toContain("shopify 2025-07");
  });

  it("Ruby: Context.setup(api_version: ShopifyApp.configuration.api_version) in the same initializer", async () => {
    const d = await repo({
      Gemfile: "gem 'shopify_app'\n",
      "config/initializers/shopify_app.rb": "ShopifyApp.configure do |config|\n  config.api_version = \"2025-10\"\nend\n\nShopifyAPI::Context.setup(\n  api_version: ShopifyApp.configuration.api_version,\n)\n",
    });
    const v = versions(await usagesIn(d, "config/initializers/shopify_app.rb"));
    expect(v).toContain("2 shopify 2025-10");
    expect(v).toContain("6 shopify 2025-10");
  });

  it("AddFacebook() on .NET 10 defaults to v22.0, reported at the use and at the csproj row", async () => {
    const d = await repo({
      "Web/Web.csproj": '<Project>\n  <ItemGroup>\n    <PackageReference Include="Microsoft.AspNetCore.Authentication.Facebook" Version="10.0.2" />\n  </ItemGroup>\n</Project>',
      "Web/Program.cs": "builder.Services.AddAuthentication().AddFacebook(o => { o.AppId = id; });\n",
    });
    const map = await scanRepo(d);
    const at = map.usages.filter((u) => u.apiVersion === "default: v22.0").map((u) => `${u.file}:${u.line} ${u.role}`);
    expect(at).toContain("Web/Program.cs:1 breaks");
    expect(at).toContain("Web/Web.csproj:3 breaks");
  });

  it("messaging-api-messenger through a factory wrapper", async () => {
    const d = await repo({ "package.json": '{"dependencies":{"messaging-api-messenger":"^1.1.0"}}', "bot/messenger.ts": "import { MessengerClient } from 'messaging-api-messenger';\nexport const client = createAuthenticatedMessengerClient({ accessToken: token, appSecret: secret });\n" });
    expect(versions(await usagesIn(d, "bot/messenger.ts"))).toEqual(["2 meta v6.0"]);
  });

  it("an AI SDK model held in a variable", async () => {
    const d = await repo({ "package.json": '{"dependencies":{"ai":"^4.0.0","@ai-sdk/anthropic":"^1.0.0"}}', "chat.ts": "import { streamText } from 'ai';\nimport { anthropic } from '@ai-sdk/anthropic';\nconst model = anthropic('claude-sonnet-4-5');\nexport const go = (options: { temperature?: number }) => streamText({\n  model,\n  temperature: options.temperature,\n  prompt: 'x',\n});\n" });
    expect(params(await usagesIn(d, "chat.ts"))).toContain("6 POST /v1/messages temperature");
  });

  it("env.example (no leading dot) is read", async () => {
    const d = await repo({ "env.example": "WA_BUSINESS_VERSION=v18.0\n" });
    expect(versions(await usagesIn(d, "env.example"))).toEqual(["1 meta v18.0"]);
  });
});
