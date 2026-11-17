import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ApiMap, ChangeRecord, Usage } from "../src/types.js";

let map: ApiMap;
const at = (file: string, line: number, kind?: Usage["kind"]): Usage | undefined =>
  map.usages.find((u) => u.file === file && u.line === line && (!kind || u.kind === kind));

beforeAll(async () => {
  map = await scanRepo(resolve(import.meta.dirname, "fixtures/apis"));
});

describe("Stripe, Twilio, GitHub, Shopify, Meta", () => {
  it("maps Stripe SDK calls to REST operations by naming rule (JS and Python class style)", () => {
    expect(at("web/payments.ts", 12)).toMatchObject({ provider: "stripe", op: "POST /v1/checkout/sessions" });
    expect(at("web/payments.ts", 13)).toMatchObject({ provider: "stripe", op: "GET /v1/payment_intents/{id}" });
    expect(at("py/billing.py", 11)).toMatchObject({ provider: "stripe", op: "POST /v1/customers" });
  });

  it("maps Twilio shorthand resources and Octokit methods (from GitHub's spec)", () => {
    expect(at("web/payments.ts", 14)).toMatchObject({ provider: "twilio", op: "POST /2010-04-01/Accounts/{AccountSid}/Messages.json" });
    expect(at("web/payments.ts", 15)).toMatchObject({ provider: "github", op: "GET /repos/{owner}/{repo}" });
    expect(at("web/payments.ts", 16)).toMatchObject({ provider: "github", op: "GET /classrooms" });
  });

  it("reads pinned API versions from SDK options, assignments, kwargs and URLs", () => {
    expect(at("web/payments.ts", 6, "version-pin")?.apiVersion).toBe("apiVersion: 2023-10-16");
    expect(at("web/payments.ts", 9, "version-pin")?.apiVersion).toBe("apiVersion: 2025-07"); // ApiVersion.July25
    expect(at("web/payments.ts", 17)).toMatchObject({ provider: "shopify", apiVersion: "url: 2025-04" });
    expect(at("web/payments.ts", 20)).toMatchObject({ provider: "meta", op: "POST /v21.0/{id}/feed", apiVersion: "url: v21.0" });
    expect(at("py/billing.py", 6, "version-pin")?.apiVersion).toBe("api_version: 2022-11-15");
    expect(at("py/billing.py", 7, "version-pin")?.apiVersion).toBe("api_version: v20.0");
  });

  it("matches version cut-offs and spec-parameter path wildcards", () => {
    const feed: ChangeRecord[] = [
      { id: "shop", provider: "shopify", type: "version_sunset", title: "x", selector: { versions: ["2025-04", "2025-07"] }, effective: "2026-07-16", trigger: "date", sources: [] },
      { id: "meta", provider: "meta", type: "version_sunset", title: "x", selector: { versions: ["v21.0"] }, effective: "2027-01-21", trigger: "date", sources: [] },
      { id: "gh", provider: "github", type: "endpoint_shutdown", title: "x", selector: { ops: ["GET /repos/{owner}/{repo}"] }, effective: "2026-01-01", trigger: "date", sources: [] },
      { id: "stripe", provider: "stripe", type: "param_removed", title: "x", selector: { ops: ["POST /v1/checkout/sessions"], params: ["payment_method_types"] }, effective: "2026-11-13", trigger: "upgrade", unconfirmed: true, sources: [] },
    ];
    const got = findImpacts(map, feed, "2026-11-13").map((f) => `${f.change.id}@${f.usage.file}:${f.usage.line}`).sort();
    expect(got).toEqual([
      "gh@web/payments.ts:15",
      "meta@py/billing.py:13",
      "meta@web/payments.ts:20",
      "shop@web/payments.ts:17",
      "shop@web/payments.ts:9",
      "stripe@web/payments.ts:12",
    ]);
  });
});
