import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-ef-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};

describe("E: a pinned Stripe client made in another module", () => {
  it("Python: a module-level StripeClient imported and used for checkout sessions", async () => {
    const us = (await scanRepo(await repo({
      "pay/__init__.py": "",
      "pay/client.py": 'from stripe import StripeClient\nclient = StripeClient("sk_test_x", stripe_version="2024-06-20")\n',
      "pay/checkout.py": 'from pay.client import client\n\ndef checkout(c):\n    return client.checkout.sessions.create(params={\n        "customer": c,\n        "payment_method_types": ["card"],\n    })\n',
    }))).usages;
    expect(us.find((u: any) => u.file === "pay/checkout.py" && u.params?.includes("payment_method_types"))).toMatchObject({ op: "POST /v1/checkout/sessions", provider: "stripe" });
  });
});

describe("F: settings set on other lines of the request's function", () => {
  it("a params dict filled before the call: the setting's line is one of the request's", async () => {
    const us = (await scanRepo(await repo({
      "a.py": 'import stripe\n\ndef create(customer, items, methods):\n    params = {\n        "customer": customer,\n        "line_items": items,\n        "mode": "payment",\n    }\n    if methods:\n        params["payment_method_types"] = methods\n    params["success_url"] = "https://x/ok"\n    params["cancel_url"] = "https://x/no"\n    return stripe.checkout.Session.create(**params)\n',
    }))).usages;
    const u = us.find((x: any) => x.params?.includes("payment_method_types"));
    expect(u?.alsoLines).toContain(10);
  });
});
