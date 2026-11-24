import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 120_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-stripe-idx-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};
const URL_ = "https://api.stripe.com/v1/checkout/sessions";
const KEYS = ["payment_method_types[0]", "payment_method_types[]", "line_items[0][price]"];
const q = (k: string) => `"${k}"`;

// the form keys written as literal, bracket-indexed keys (not lists): the param is the top-level field
const FIX: Record<string, [string, string]> = {
  ts: ["a.ts", `export async function f() {\n  const body = new URLSearchParams({ mode: "payment", ${KEYS.map((k) => `${q(k)}: "x"`).join(", ")} });\n  return fetch("${URL_}", { method: "POST", body });\n}\n`],
  js: ["a.js", `async function f() {\n  const body = new URLSearchParams({ mode: "payment", ${KEYS.map((k) => `${q(k)}: "x"`).join(", ")} });\n  return fetch("${URL_}", { method: "POST", body });\n}\n`],
  py: ["a.py", `import httpx\ndef f():\n    return httpx.post(\n        "${URL_}",\n        headers={"Stripe-Version": "2022-11-15"},\n        data={\n            "mode": "payment",\n${KEYS.map((k) => `            ${q(k)}: "x",`).join("\n")}\n        },\n    )\n`],
  rb: ["a.rb", `require "net/http"\ndef f\n  Net::HTTP.post_form(URI("${URL_}"), "mode" => "payment", ${KEYS.map((k) => `${q(k)} => "x"`).join(", ")})\nend\n`],
  php: ["a.php", `<?php\nfunction f() {\n  $ch = curl_init('${URL_}');\n  curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query(['mode' => 'payment', ${KEYS.map((k) => `'${k}' => 'x'`).join(", ")}]));\n  return curl_exec($ch);\n}\n`],
  go: ["a.go", `package main\nimport ("net/http";"net/url";"strings")\nfunc f() {\n\tform := url.Values{}\n${KEYS.map((k) => `\tform.Add(${q(k)}, "x")`).join("\n")}\n\thttp.Post("${URL_}", "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))\n}\n`],
  java: ["A.java", `import java.net.http.*;\nimport java.net.URI;\nclass A {\n  void f() throws Exception {\n    String body = "mode=payment&payment_method_types[0]=card&payment_method_types[]=card&line_items[0][price]=p";\n    HttpRequest req = HttpRequest.newBuilder(URI.create("${URL_}")).POST(HttpRequest.BodyPublishers.ofString(body)).build();\n  }\n}\n`],
  cs: ["A.cs", `using System.Net.Http;\nclass A {\n  async void F() {\n    var client = new HttpClient();\n    var content = new FormUrlEncodedContent(new Dictionary<string,string> { {"mode","payment"}, ${KEYS.map((k) => `{${q(k)},"x"}`).join(", ")} });\n    await client.PostAsync("${URL_}", content);\n  }\n}\n`],
};

describe("bracket-indexed form keys become the top-level field, in every language", () => {
  for (const [lang, [file, src]] of Object.entries(FIX)) {
    it(lang, async () => {
      const us = (await scan({ [file]: src })).filter((u) => u.provider === "stripe" && u.op === "POST /v1/checkout/sessions");
      const names = new Set(us.flatMap((u) => u.params ?? []));
      expect([...names]).toEqual(expect.arrayContaining(["payment_method_types", "line_items"]));
      expect([...names].some((n) => n.includes("["))).toBe(false);
    });
  }
  it("the set-17 shape: a connector module's httpx form POST with a pinned Stripe-Version header", async () => {
    const us = await scan({ "connectors/stripe_connector.py": FIX.py[1] });
    const u = us.find((x) => x.provider === "stripe" && x.params?.includes("payment_method_types"));
    expect(u).toMatchObject({ op: "POST /v1/checkout/sessions", line: 8 });
    expect(us.some((x) => x.provider === "stripe" && x.apiVersion?.includes("2022-11-15"))).toBe(true);
  });
});
