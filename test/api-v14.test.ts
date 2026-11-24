import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v14-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usagesIn = async (d: string, file: string) => (await scanRepo(d)).usages.filter((u) => u.file === file);
const versions = (us: any[]) => us.filter((u) => u.apiVersion && u.role === "breaks").map((u) => `${u.line} ${u.provider} ${u.apiVersion.split(": ").pop()}`);
const params = (us: any[]) => us.filter((u) => u.params?.length).map((u) => `${u.line} ${u.op} ${u.params.join(",")}`);

describe("v14: real-world shapes for the remaining patterns", () => {
  it("Python: a service class method wrapping create_async, called as self.stripe_service.create_payment_intent(**params); SetupIntentCreateParams(...)", async () => {
    const d = await repo({
      "requirements.txt": "stripe==11.0.0\n",
      "app/services/stripe_service.py": "import stripe\nfrom stripe.params import SetupIntentCreateParams\n\nclass StripeService:\n    async def create_payment_intent(self, **params) -> stripe.PaymentIntent:\n        return await stripe.PaymentIntent.create_async(**params)\n\n    async def create_setup_intent(self, params: SetupIntentCreateParams) -> stripe.SetupIntent:\n        return await stripe.SetupIntent.create_async(**params)\n",
      "app/api/checkout.py": "from app.services.stripe_service import StripeService\nfrom stripe.params import SetupIntentCreateParams\n\nclass Checkout:\n    def __init__(self):\n        self.stripe_service = StripeService()\n\n    async def pay(self, amount):\n        params = {\"amount\": amount, \"currency\": \"usd\"}\n        params[\"payment_method_types\"] = [\"card\"]\n        return await self.stripe_service.create_payment_intent(**params)\n\n    async def setup(self, customer):\n        p = SetupIntentCreateParams(customer=customer, payment_method_types=[\"card\"])\n        return await self.stripe_service.create_setup_intent(p)\n",
    });
    const p = params(await usagesIn(d, "app/api/checkout.py"));
    expect(p).toContain("10 POST /v1/payment_intents payment_method_types");
    expect(p.join("\n")).toMatch(/14 POST \/v1\/setup_intents (customer,)?payment_method_types|14 POST \/v1\/setup_intents payment_method_types/);
  });

  it("PHP: a trait in another file holds the wrapper; the client comes from a method call", async () => {
    const d = await repo({
      "composer.json": '{"require":{"stripe/stripe-php":"^16.0"}}',
      "app/Concerns/ManagesStripe.php": "<?php\nnamespace App\\Concerns;\nuse Stripe\\StripeClient;\ntrait ManagesStripe {\n  protected function createPayment(array $options) {\n    return $this->stripeClient()->paymentIntents->create($options);\n  }\n}\n",
      "app/Billing/Charge.php": "<?php\nnamespace App\\Billing;\nuse App\\Concerns\\ManagesStripe;\nclass Charge {\n  use ManagesStripe;\n  public function run($amount) {\n    $options = ['amount' => $amount];\n    $options['payment_method_types'] = ['card'];\n    return $this->createPayment($options);\n  }\n}\n",
    });
    expect(params(await usagesIn(d, "app/Billing/Charge.php"))).toContain("8 POST /v1/payment_intents payment_method_types");
  });

  it("C#: an inline options object handed to a wrapper service", async () => {
    const d = await repo({
      "app.csproj": '<Project><ItemGroup><PackageReference Include="Stripe.net" Version="47.0.0" /></ItemGroup></Project>',
      "Billing.cs": "using Stripe;\nclass Billing {\n  async Task Go() {\n    await service.CreateSetupIntentAsync(new SetupIntentCreateOptions\n    {\n      Customer = id,\n      PaymentMethodTypes = [\"card\"],\n    });\n  }\n}\n",
    });
    expect(params(await usagesIn(d, "Billing.cs"))).toContain("7 POST /v1/setup_intents payment_method_types");
  });

  it("PHP: a typed class property default joined by concatenation", async () => {
    const d = await repo({ "src/Facebook.php": "<?php\nclass Facebook {\n  protected string $version = 'v23.0';\n  public function me($token) {\n    return Http::get('https://graph.facebook.com/'.$this->version.'/me', ['access_token' => $token]);\n  }\n}\n" });
    expect(versions(await usagesIn(d, "src/Facebook.php")).join(" ")).toContain("v23.0");
  });

  it("TS: a config object read through a config service", async () => {
    const d = await repo({
      "src/config/wa.config.ts": "export default () => ({\n  WA_BUSINESS: {\n    VERSION: process.env.WA_BUSINESS_VERSION || 'v18.0',\n  },\n});\n",
      "src/wa/wa.service.ts": "export class WaService {\n  constructor(private readonly configService: ConfigService) {}\n  send(id: string) {\n    return this.http.post(`https://graph.facebook.com/${this.configService.get<WaBusiness>('WA_BUSINESS').VERSION}/${id}/messages`, {});\n  }\n}\n",
    });
    expect(versions(await usagesIn(d, "src/wa/wa.service.ts"))).toContain("4 meta v18.0");
  });

  it("plain literals inside object literals handed to axios / fetch", async () => {
    const d = await repo({
      "src/auth.ts": "import axios from 'axios';\nexport const token = (code: string) => axios.get('https://graph.facebook.com/v19.0/oauth/access_token', { params: { code } });\nexport const send = (id: string, body: unknown) => axios.request({ method: 'POST', url: `https://graph.instagram.com/v21.0/${id}/messages`, data: body });\n",
    });
    const v = versions(await usagesIn(d, "src/auth.ts"));
    expect(v).toContain("2 meta v19.0");
    expect(v).toContain("3 meta v21.0");
  });

  it("Shopify: an imported version set from the SDK enum, in Admin and Storefront URL templates", async () => {
    const d = await repo({
      "app/constants.ts": "import { ApiVersion } from '@shopify/shopify-api';\nexport const SHOPIFY_API_VERSION = ApiVersion.October24;\n",
      "app/admin.ts": "import { SHOPIFY_API_VERSION } from './constants';\nexport const admin = (shop: string) => fetch(`https://${shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);\n",
      "app/storefront.ts": "const v = '2024-10';\nexport const sf = (shop: string) => fetch(`https://${shop}.myshopify.com/api/${v}/graphql.json`);\n",
    });
    expect(versions(await usagesIn(d, "app/admin.ts"))).toContain("2 shopify 2024-10");
    expect(versions(await usagesIn(d, "app/storefront.ts")).join(" ")).toContain("shopify 2024-10");
  });

  it("AI SDK: an inline factory call as the model", async () => {
    const d = await repo({ "package.json": '{"dependencies":{"ai":"^4.0.0","@ai-sdk/anthropic":"^1.0.0"}}', "gen.ts": "import { generateText } from 'ai';\nimport { createAnthropic } from '@ai-sdk/anthropic';\nexport const go = (apiKey: string, modelName: string, options: { temperature?: number }) => generateText({\n  model: createAnthropic({ apiKey })(modelName),\n  temperature: options.temperature,\n  prompt: 'x',\n});\n" });
    expect(params(await usagesIn(d, "gen.ts"))).toContain("5 POST /v1/messages temperature");
  });

  it("Anthropic: a request built in one function and sent in another (same file)", async () => {
    const d = await repo({ "package.json": '{"dependencies":{"@anthropic-ai/sdk":"^0.30.0"}}', "llm.ts": "import Anthropic from '@anthropic-ai/sdk';\nconst client = new Anthropic();\nfunction buildRequest(prompt: string, t: number) {\n  return {\n    model: 'claude-sonnet-4-5',\n    max_tokens: 100,\n    temperature: t,\n    messages: [{ role: 'user', content: prompt }],\n  };\n}\nexport async function ask(prompt: string) {\n  const request = buildRequest(prompt, 0.2);\n  return client.messages.create(request);\n}\n" });
    expect(params(await usagesIn(d, "llm.ts"))).toContain("7 POST /v1/messages temperature");
  });

  it("WhatsAppAPI { v } with an imported constant; Google Ads root constant with an inline /v25", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"whatsapp-api-js":"^6.2.0"}}',
      "src/constants.ts": "export const WA_VERSION = 'v22.0';\nexport const GOOGLE_ADS_API_ROOT = 'https://googleads.googleapis.com/v25';\n",
      "src/bot.ts": "import WhatsAppAPI from 'whatsapp-api-js';\nimport { WA_VERSION } from './constants';\nexport const wa = new WhatsAppAPI({ token, appSecret, v: WA_VERSION });\n",
    });
    expect(versions(await usagesIn(d, "src/bot.ts"))).toContain("3 meta v22.0");
    expect(versions(await usagesIn(d, "src/constants.ts")).join(" ")).toContain("googleads v25");
  });
  it("negatives: /api/2024-10/ on another host; a config key with no version binding; v: from env; a setter-like name in a comment", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"whatsapp-api-js":"^6.2.0","@shopify/shopify-api":"^11.0.0"}}',
      "src/other.ts": "const v = '2024-10';\nexport const x = () => fetch(`https://api.example.com/api/${v}/items`);\n",
      "src/cfg.ts": "export class S {\n  go() { return fetch(`https://graph.facebook.com/${this.config.get('APP').VERSION}/me`); }\n}\n",
      "src/bot.ts": "import WhatsAppAPI from 'whatsapp-api-js';\nconst WA_V = process.env.WA_V;\nexport const wa = new WhatsAppAPI({ token, v: WA_V });\n",
    });
    const all = (await scanRepo(d)).usages.filter((u: any) => u.apiVersion && u.role === "breaks");
    expect(all.filter((u: any) => u.file === "src/other.ts")).toEqual([]);
    expect(all.filter((u: any) => u.file === "src/cfg.ts")).toEqual([]);
    // the app sets v itself (from env): neither the library default nor a guess
    expect(all.filter((u: any) => u.file === "src/bot.ts")).toEqual([]);
  });
});
