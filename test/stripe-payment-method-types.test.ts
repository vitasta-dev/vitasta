import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { FILES, FX } from "./stripe-shapes.fixtures.js";

vi.setConfig({ testTimeout: 120_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-stripe-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};

// Stripe `payment_method_types` coverage audit: the common shapes in every language
describe("Stripe payment_method_types in the common shapes, all 7 languages", () => {
  for (const [shape, byLang] of Object.entries(FX)) {
    for (const lang of Object.keys(FILES)) {
      it(`${shape} · ${lang}`, async () => {
        const us = await scan({ [FILES[lang]]: byLang[lang] });
        const u = us.find((x) => x.provider === "stripe" && x.params?.includes("payment_method_types"));
        expect(u, JSON.stringify(us.filter((x) => x.provider === "stripe").map((x) => [x.line, x.op, x.params]))).toBeTruthy();
        expect(u.op).toMatch(/^POST \/v1\/(payment_intents|checkout\/sessions|setup_intents)/);
      });
    }
  }
});

describe("form bodies posted to a provider URL: negatives", () => {
  it("a form to a host that isn't a provider, a form in another function, and a body with no form shape give nothing", async () => {
    const other = await scan({ "a.py": 'import requests\ndef f():\n    requests.post("https://example.com/v1/payment_intents", data={"payment_method_types[]": "card"})\n' });
    expect(other.filter((u) => u.params?.includes("payment_method_types"))).toEqual([]);
    const apart = await scan({ "a.py": 'import requests\ndef g():\n    return {"payment_method_types[]": "card"}\n\ndef f():\n    return requests.post("https://api.stripe.com/v1/customers")\n' });
    expect(apart.filter((u) => u.params?.includes("payment_method_types"))).toEqual([]);
    const plain = await scan({ "a.ts": 'export const f = () => fetch("https://api.stripe.com/v1/customers", { method: "GET" });\n' });
    expect(plain.filter((u) => u.params?.length)).toEqual([]);
  });
  it("bracket suffixes are dropped to the top-level field; nested form fields name their parent", async () => {
    const us = await scan({ "a.go": 'package main\nimport ("net/http";"net/url";"strings")\nfunc f() {\n\tform := url.Values{}\n\tform.Add("payment_method_data[type]", "card")\n\tform.Add("line_items[0][price]", "p")\n\thttp.Post("https://api.stripe.com/v1/checkout/sessions", "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))\n}\n' });
    const names = us.filter((u) => u.provider === "stripe").flatMap((u) => u.params ?? []);
    expect(names).toEqual(expect.arrayContaining(["payment_method_data", "line_items"]));
    expect(names.some((n: string) => n.includes("["))).toBe(false);
  });
});
