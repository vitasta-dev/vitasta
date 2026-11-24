import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-fix4-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};

const aiWrapper = [
  'import { generateText, type LanguageModel } from "ai";',
  "type Props = { model: LanguageModel; temperature: number | undefined; prompt: string };",
  "export const runChat = async ({ model, temperature, prompt }: Props) => {",
  "  const r = await generateText({",
  "    model,",
  "    temperature,",
  "    prompt,",
  "  });",
  "  return r.text;",
  "};",
].join("\n");
const caller = (spec: string) => [
  `import { runChat } from "${spec}";`,
  'import { createAnthropic } from "@ai-sdk/anthropic";',
  "export const handler = (apiKey: string, options: { temperature?: number }) =>",
  "  runChat({",
  "    model: createAnthropic({ apiKey })('claude-sonnet-4-5'),",
  "    temperature: options.temperature,",
  "    prompt: 'hi',",
  "  });",
].join("\n");

describe("AI SDK wrappers in the repo", () => {
  it("a setting passed to a function that hands it to generateText, with an Anthropic model from the caller", async () => {
    const us = (await scanRepo(await repo({
      "packages/ai/package.json": JSON.stringify({ name: "@acme/ai" }),
      "packages/ai/src/runChat.ts": aiWrapper,
      "packages/blocks/anthropic/package.json": JSON.stringify({ name: "@acme/anthropic", dependencies: { "@ai-sdk/anthropic": "2.0.0" } }),
      "packages/blocks/anthropic/src/handler.ts": caller("@acme/ai/runChat"),
    }))).usages;
    const t = us.find((u: any) => u.file === "packages/blocks/anthropic/src/handler.ts" && u.params?.includes("temperature"));
    expect(t).toMatchObject({ provider: "anthropic", line: 6, op: "POST /v1/messages", sdkCall: "generateText" });
    expect(t?.reason).toContain("packages/ai/src/runChat.ts");
  });

  it("a workspace package two packages share a name with resolves to neither", async () => {
    const us = (await scanRepo(await repo({
      "a/package.json": JSON.stringify({ name: "@acme/ai" }),
      "a/src/runChat.ts": aiWrapper,
      "b/package.json": JSON.stringify({ name: "@acme/ai" }),
      "b/src/runChat.ts": aiWrapper,
      "c/src/handler.ts": caller("@acme/ai/runChat"),
    }))).usages;
    expect(us.some((u: any) => u.file === "c/src/handler.ts" && u.params?.includes("temperature"))).toBe(false);
  });

  it("a function that makes its own model isn't a wrapper of the caller's", async () => {
    const own = aiWrapper.replace("({ model, temperature, prompt }: Props)", "({ temperature, prompt }: Props)").replace("    model,", "    model: other,");
    const us = (await scanRepo(await repo({
      "src/runChat.ts": own,
      "src/handler.ts": caller("./runChat"),
    }))).usages;
    expect(us.some((u: any) => u.file === "src/handler.ts" && u.params?.includes("temperature"))).toBe(false);
  });
});

describe("request bodies built in pieces", () => {
  it("a named body sent twice (a tool loop re-POST): the key's finding lists both send lines", async () => {
    const us = (await scanRepo(await repo({
      "anthropic/message.ts": [
        "export async function run(this: any, options: any) {",
        "  const body = {",
        "    model: 'claude-sonnet-4-5',",
        "    temperature: options.temperature,",
        "  };",
        "  let response = await this.helpers.httpRequest({ method: 'POST', url: 'https://api.anthropic.com/v1/messages',",
        "    body,",
        "  });",
        "  while (response.stop_reason === 'tool_use') {",
        "    response = await this.helpers.httpRequest({ method: 'POST', url: 'https://api.anthropic.com/v1/messages',",
        "      body,",
        "    });",
        "  }",
        "}",
      ].join("\n"),
    }))).usages;
    const t = us.find((u: any) => u.params?.includes("temperature"));
    expect(t?.line).toBe(4);
    expect(t?.alsoLines).toEqual(expect.arrayContaining([7, 11]));
  });
});

describe("traced keys only when a record could match them", () => {
  const files = {
    "app/__init__.py": "",
    "app/stripe/__init__.py": "import stripe as stripe_lib\n",
    "app/stripe/service.py": "from app.stripe import stripe_lib\n\nclass S:\n    async def create(self, **params):\n        return await stripe_lib.PaymentIntent.create_async(**params)\n\nstripe = S()\n",
    "app/checkout.py": "from app.stripe.service import stripe as svc\n\nasync def go(c):\n    params = {\"amount\": c.amount}\n    params[\"payment_method_types\"] = c.types\n    return await svc.create(**params)\n",
  };
  it("keeps payment_method_types, drops amount, when the records name only the first", async () => {
    const us = (await scanRepo(await repo(files), { watchParams: new Map([["stripe", new Set(["payment_method_types"])]]) })).usages;
    const traced = us.filter((u: any) => u.file === "app/checkout.py" && u.params?.length);
    expect(traced.map((u: any) => u.params[0])).toEqual(["payment_method_types"]);
  });
});
