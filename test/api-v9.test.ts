import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v9-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const at = async (d: string) => (await scanRepo(d)).usages;
const params = (us: any[], file: string) => us.filter((u) => u.file === file && u.params?.length).map((u) => `${u.line} ${u.op} ${u.params.join(",")}`);
const versions = (us: any[], file: string) => us.filter((u) => u.file === file && u.apiVersion).map((u) => `${u.line} ${u.provider} ${u.apiVersion.split(": ").pop()} ${u.role}`);
const ops = (us: any[], file: string) => us.filter((u) => u.file === file && u.op).map((u) => `${u.line} ${u.op}`);

describe("v9: PHP Stripe SDK calls (test set 3)", () => {
  it("static resource calls, `use` aliases, and a wrapper whose callers pass the request", async () => {
    const d = await repo({
      "composer.json": '{"require":{"stripe/stripe-php":"^13.0"}}',
      "app/PaymentDrivers/Stripe/EPS.php": [
        "<?php",
        "namespace App\\PaymentDrivers\\Stripe;",
        "use Stripe\\Checkout\\Session;",
        "class EPS {",
        "  public function pay() {",
        "    $intent = \\Stripe\\PaymentIntent::create([",
        "      'amount' => 100,",
        "      'payment_method_types' => ['eps'],",
        "    ]);",
        "    $session = Session::create(['mode' => 'payment', 'payment_method_types' => ['bacs_debit']]);",
        "  }",
        "}",
      ].join("\n"),
      "app/PaymentDrivers/StripePaymentDriver.php": [
        "<?php",
        "use Stripe\\SetupIntent;",
        "class StripePaymentDriver {",
        "  public function getSetupIntent() {",
        "    return $this->createSetupIntent([",
        "      'usage' => 'off_session',",
        "      'payment_method_types' => ['card'],",
        "    ]);",
        "  }",
        "  public function createSetupIntent(array $params) {",
        "    return SetupIntent::create(",
        "      $params,",
        "      ['idempotency_key' => 'x']",
        "    );",
        "  }",
        "  public function amount() { return $this->stripe->convertToStripeAmount(1, 2); }",
        "  public function hash() { return $this->stripe->payment_hash->invoices(); }",
        "}",
      ].join("\n"),
    });
    const us = await at(d);
    expect(params(us, "app/PaymentDrivers/Stripe/EPS.php")).toEqual([
      "6 POST /v1/payment_intents amount,payment_method_types",
      "10 POST /v1/checkout/sessions mode,payment_method_types",
    ]);
    const p = params(us, "app/PaymentDrivers/StripePaymentDriver.php");
    expect(p).toContain("7 POST /v1/setup_intents payment_method_types");
    // Negative: the options array isn't the request; a driver object named $this->stripe isn't the SDK
    expect(p.some((s) => s.includes("idempotency_key"))).toBe(false);
    expect(ops(us, "app/PaymentDrivers/StripePaymentDriver.php").every((s) => s.includes("setup_intents"))).toBe(true);
  });
});

describe("v9: PHP Stripe calls without `use` aliases, and wrappers called from other files", () => {
  it("\\Stripe\\PaymentIntent::create in a file with no aliases; $this->stripe->createPaymentIntent($data) elsewhere", async () => {
    const d = await repo({
      "composer.json": '{"require":{"stripe/stripe-php":"^13.0"}}',
      "app/Drivers/EPS.php": "<?php\nclass EPS {\n  public function pay() {\n    $intent = \\Stripe\\PaymentIntent::create([\n      'payment_method_types' => ['eps'],\n    ]);\n  }\n}\n",
      "app/Drivers/StripeDriver.php": "<?php\nclass StripeDriver {\n  public function createPaymentIntent($data) {\n    return \\Stripe\\PaymentIntent::create($data, ['idempotency_key' => 'x']);\n  }\n}\n",
      "app/Drivers/Charge.php": [
        "<?php",
        "class Charge {",
        "  public function tokenBilling() {",
        "    $data = [",
        "      'amount' => 100,",
        "    ];",
        "    $data['payment_method_types'] = ['sepa_debit'];",
        "    $response = $this->stripe->createPaymentIntent($data);",
        "  }",
        "}",
      ].join("\n"),
    });
    const us = await at(d);
    expect(params(us, "app/Drivers/EPS.php")).toEqual(["4 POST /v1/payment_intents payment_method_types"]);
    expect(params(us, "app/Drivers/Charge.php")).toEqual(["5 POST /v1/payment_intents amount", "7 POST /v1/payment_intents payment_method_types"]);
  });
});

describe("v9: conditional spreads in params", () => {
  it("...(cond ? { k: v } : {}) and ...(cond && { k: v }) add their keys", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"stripe":"^14.0.0"}}',
      "billing/session.ts": [
        "import Stripe from 'stripe'",
        "const stripe = new Stripe('sk_test_x')",
        "export const go = (upgrade: boolean, trial: boolean) => stripe.checkout.sessions.create({",
        "  mode: 'setup',",
        "  ...(upgrade ? { payment_method_types: ['card'] } : {}),",
        "  ...(trial && { subscription_data: { trial_period_days: 7 } }),",
        "})",
      ].join("\n"),
    });
    expect(params(await at(d), "billing/session.ts")).toEqual(["3 POST /v1/checkout/sessions mode,payment_method_types,subscription_data"]);
  });
});

describe("v9: the first entry of a version list is the default", () => {
  it("PHP current(self::versions()) makes the first version break; the rest stay a catalog; the readers are reported", async () => {
    const d = await repo({
      "src/Services/FacebookService.php": [
        "<?php",
        "class FacebookService {",
        "  public static function versions(): array",
        "  {",
        "    return ['v25.0', 'v24.0', 'v23.0'];",
        "  }",
        "  public static function form(): array",
        "  {",
        "    return ['api_version' => current(self::versions())];",
        "  }",
        "}",
      ].join("\n"),
      "src/Meta/ManagesConfig.php": "<?php\ntrait ManagesConfig {\n  public static function getApiVersionConfig(): string {\n    $versions = FacebookService::versions();\n    return ServiceManager::get('facebook', 'api_version') ?? current($versions);\n  }\n}\n",
    });
    const us = await at(d);
    const v = versions(us, "src/Services/FacebookService.php");
    expect(v).toContain("5 meta v25.0 breaks");
    expect(v).toContain("5 meta v24.0 catalog");
    expect(v).toContain("9 meta v25.0 breaks");
    expect(versions(us, "src/Meta/ManagesConfig.php")).toEqual(["5 meta v25.0 breaks"]);
  });

  it("a version list nothing takes the first entry of stays a catalog", async () => {
    const d = await repo({ "src/Services/FacebookService.php": "<?php\nclass FacebookService {\n  public static function versions(): array\n  {\n    return ['v25.0', 'v24.0', 'v23.0'];\n  }\n}\n" });
    expect(versions(await at(d), "src/Services/FacebookService.php").every((s) => s.endsWith("catalog"))).toBe(true);
  });
});

describe("v9: Conversions API and Stripe's local helpers", () => {
  it("graph.facebook.com/vNN/{pixel}/events is the Marketing API; webhooks.constructEvent isn't an API op", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"stripe":"^14.0.0"}}',
      "track.ts": "export const send = (pixel: string) => fetch(`https://graph.facebook.com/v25.0/${pixel}/events`, { method: 'POST' })\n",
      "hook.ts": "import Stripe from 'stripe'\nconst stripe = new Stripe('sk_test_x')\nexport const verify = (b: string, s: string) => stripe.webhooks.constructEvent(b, s, 'whsec')\n",
    });
    const us = await at(d);
    expect(us.find((u) => u.file === "track.ts" && u.apiVersion)?.provider).toBe("meta-marketing");
    expect(ops(us, "hook.ts")).toEqual([]);
  });
});
