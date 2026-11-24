import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Manager's review of test sets (24 Nov): generic fixes on hand-written code (never set 19's). A line that puts a
// removed param into the body of a request the function sends is reported whatever the value's source; the
// pass-through exemption is only for setters that send nothing themselves.
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s19r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];
const PKG = "{\"dependencies\":{\"@anthropic-ai/sdk\":\"^0.30.0\",\"openai\":\"^4.0.0\"}}\n";
const lines = (us: any[], p: string) => us.filter((u) => u.provider === "anthropic" && u.params?.includes(p)).map((u) => u.line);

describe("the function that sends the request sends what it sets", () => {
  it("an adapter whose signature takes and returns OpenAI-format types still sends POST /v1/messages", async () => {
    const us = await usages({ "package.json": PKG, "src/adapters/anthropic.ts": "import Anthropic from \"@anthropic-ai/sdk\";\nimport type { ChatCompletion, ChatCompletionCreateParams } from \"openai/resources\";\n\nexport class AnthropicAdapter {\n  private sdk() { return new Anthropic(); }\n\n  async chat(request: ChatCompletionCreateParams): Promise<ChatCompletion> {\n    const params: Anthropic.MessageCreateParams = {\n      model: request.model,\n      max_tokens: request.max_tokens ?? 1024,\n      messages: toAnthropic(request.messages),\n    };\n    if (request.temperature != null) {\n      params.temperature = request.temperature;\n    }\n    if (request.top_p != null) {\n      params.top_p = request.top_p;\n    }\n    const res = await this.sdk().messages.create({ ...params, stream: false });\n    return toOpenAI(res);\n  }\n}\nfunction toAnthropic(m: any) { return m; }\nfunction toOpenAI(r: any): ChatCompletion { return r; }\n" });
    expect(lines(us, "temperature")).toContain(14);
    expect(lines(us, "top_p")).toContain(17);
  });
  it("a value from the sending function's own parameter, inside an if, is reported", async () => {
    const us = await usages({ "package.json": PKG, "src/send.ts": "import Anthropic from \"@anthropic-ai/sdk\";\nexport class A {\n  private sdk() { return new Anthropic(); }\n  async chat(model: string, messages: any[], temperature?: number, topP?: number) {\n    const params: any = { model, max_tokens: 1024, messages };\n    if (temperature !== undefined) {\n      params.temperature = temperature;\n    }\n    params.top_p = topP;\n    return this.sdk().messages.create({ ...params, stream: false });\n  }\n}\n" });
    expect(lines(us, "temperature")).toContain(7);
    expect(lines(us, "top_p")).toContain(9);
  });
  it("setters that send nothing stay exempt: a Go option closure, a constructor storing its argument", async () => {
    const go = await usages({ "go.mod": "module x\n", "llm/opt.go": "package llm\n\ntype cfg struct {\n\tTemperature float64 `json:\"temperature,omitempty\"`\n}\n\ntype Option func(*cfg)\n\nfunc WithTemperature(t float64) Option {\n\treturn func(c *cfg) {\n\t\tc.Temperature = t\n\t}\n}\n", "llm/send.go": 'package llm\n\nimport "net/http"\n\nfunc send(c *cfg) { http.Post("https://api.anthropic.com/v1/messages", "application/json", nil) }\n' });
    expect(go.some((u) => u.file === "llm/opt.go" && u.line === 11)).toBe(false);
    const ts = await usages({ "package.json": PKG, "src/a.ts": "import Anthropic from \"@anthropic-ai/sdk\";\nexport class A {\n  temperature?: number;\n  constructor(temperature?: number) {\n    this.temperature = temperature;\n  }\n}\n" });
    expect(ts.some((u) => u.file === "src/a.ts" && u.line === 5)).toBe(false);
  });
});

describe("a table of setting names the sending code copies into the request", () => {
  it("Python: a module dict looped over by a helper of the sending method, written under the loop variable", async () => {
    const us = await usages({ "requirements.txt": "anthropic\n", "app/backend.py": "from anthropic import Anthropic\n\n_PARAM_NAMES = {\n    \"temperature\": \"temperature\",\n    \"top_p\": \"top_p\",\n    \"top_k\": \"top_k\",\n}\n\n_DEFAULTS = {\"max_tokens\": 1024}\n\n\nclass Backend:\n    def __init__(self, model: str):\n        self.model = model\n        self.client = Anthropic()\n\n    def _params(self, settings: dict) -> dict:\n        out = dict(_DEFAULTS)\n        for key, wire in _PARAM_NAMES.items():\n            value = settings.get(key)\n            if value is not None:\n                out[wire] = value\n        return out\n\n    def generate(self, prompt: str, **settings):\n        kwargs = self._params(settings)\n        return self.client.messages.create(\n            model=self.model,\n            messages=[{\"role\": \"user\", \"content\": prompt}],\n            **kwargs,\n        )\n" });
    expect(lines(us, "temperature")).toContain(4);
    expect(lines(us, "top_p")).toContain(5);
    expect(lines(us, "top_k")).toContain(6);
  });
  it("TS and Go: Object.entries / range over the table, body[wire] = …", async () => {
    const t = await usages({ "package.json": PKG, "src/ask.ts": "import Anthropic from \"@anthropic-ai/sdk\";\nconst PARAM_NAMES = {\n  temp: \"temperature\",\n  nucleus: \"top_p\",\n};\nconst client = new Anthropic();\nexport async function ask(model: string, opts: Record<string, number>) {\n  const body: any = { model, max_tokens: 512, messages: [] };\n  for (const [ours, wire] of Object.entries(PARAM_NAMES)) {\n    if (opts[ours] !== undefined) body[wire] = opts[ours];\n  }\n  return client.messages.create(body);\n}\n" });
    expect(lines(t, "temperature")).toContain(3);
    expect(lines(t, "top_p")).toContain(4);
    const g = await usages({ "go.mod": "module x\n", "llm/ask.go": "package llm\n\nimport (\n\t\"bytes\"\n\t\"encoding/json\"\n\t\"net/http\"\n)\n\nvar paramNames = map[string]string{\n\t\"temp\":    \"temperature\",\n\t\"nucleus\": \"top_p\",\n}\n\nfunc Ask(opts map[string]float64) (*http.Response, error) {\n\tbody := map[string]any{\"model\": \"claude-sonnet-4-5\"}\n\tfor ours, wire := range paramNames {\n\t\tif v, ok := opts[ours]; ok {\n\t\t\tbody[wire] = v\n\t\t}\n\t}\n\tb, _ := json.Marshal(body)\n\treturn http.Post(\"https://api.anthropic.com/v1/messages\", \"application/json\", bytes.NewReader(b))\n}\n" });
    expect(lines(g, "temperature")).toContain(10);
    expect(lines(g, "top_p")).toContain(11);
  });
  it("a loop that only reads the table (a log line) doesn't make it a request's", async () => {
    const us = await usages({ "requirements.txt": "anthropic\n", "app/backend.py": "from anthropic import Anthropic\n\n_PARAM_NAMES = {\n    \"temperature\": \"temperature\",\n    \"top_p\": \"top_p\",\n    \"top_k\": \"top_k\",\n}\n\n_DEFAULTS = {\"max_tokens\": 1024}\n\n\nclass Backend:\n    def __init__(self, model: str):\n        self.model = model\n        self.client = Anthropic()\n\n    def _params(self, settings: dict) -> dict:\n        out = dict(_DEFAULTS)\n        for key, wire in _PARAM_NAMES.items():\n            value = settings.get(key)\n            if value is not None:\n                log.info(\"%s=%s\", wire, value)\n        return out\n\n    def generate(self, prompt: str, **settings):\n        kwargs = self._params(settings)\n        return self.client.messages.create(\n            model=self.model,\n            messages=[{\"role\": \"user\", \"content\": prompt}],\n            **kwargs,\n        )\n" });
    expect(lines(us, "temperature")).not.toContain(4);
  });
});

describe("a library helper sets a removed setting through a backend method that forwards **kwargs", () => {
  const A = "from anthropic import Anthropic\n\n\nclass AnthropicBackend:\n    def __init__(self, model=\"claude-sonnet-4-5\"):\n        self.client = Anthropic()\n        self.model = model\n\n    def generate(self, prompt, **kwargs):\n        resp = self.client.messages.create(model=self.model, max_tokens=1024, messages=[{\"role\": \"user\", \"content\": prompt}], **kwargs)\n        return resp.content[0].text\n";
  const O = "from openai import OpenAI\n\n\nclass OpenAIBackend:\n    def __init__(self, model=\"gpt-4o\"):\n        self.client = OpenAI()\n        self.model = model\n\n    def generate(self, prompt, **kwargs):\n        resp = self.client.chat.completions.create(model=self.model, messages=[{\"role\": \"user\", \"content\": prompt}], **kwargs)\n        return resp.choices[0].message.content\n";
  it("any backend: reported at the call and where the value is set, labelled provider-unresolved (also tier)", async () => {
    const us = await usages({ "requirements.txt": "anthropic\nopenai\n", "mylib/backends/anthropic_backend.py": A, "mylib/backends/openai_backend.py": O, "mylib/structured.py": "import json\n\n\nclass ParseError(Exception):\n    pass\n\n\ndef generate_json(backend, prompt, max_retries=3):\n    temperature = 0.0\n    for attempt in range(max_retries):\n        text = backend.generate(prompt, temperature=temperature)\n        try:\n            return json.loads(text)\n        except json.JSONDecodeError:\n            temperature = min(1.0, temperature + 0.3)\n    raise ParseError(prompt)\n" });
    const t = us.filter((u) => u.file === "mylib/structured.py" && u.provider === "anthropic" && u.params?.includes("temperature"));
    expect(t.map((u) => u.line).sort()).toEqual([11, 9].sort());
    expect(t.every((u) => u.context === "provider-unresolved" && u.tier === "also")).toBe(true);
  });
  it("a caller that builds the Anthropic backend itself: action", async () => {
    const us = await usages({ "requirements.txt": "anthropic\n", "mylib/backends/anthropic_backend.py": A, "mylib/summary.py": "from mylib.backends.anthropic_backend import AnthropicBackend\n\n\ndef summarize(prompt):\n    backend = AnthropicBackend()\n    return backend.generate(prompt, temperature=0.2)\n" });
    const t = us.filter((u) => u.file === "mylib/summary.py" && u.params?.includes("temperature"));
    expect(t.map((u) => u.line)).toContain(6);
    expect(t.every((u) => u.tier === "action")).toBe(true);
  });
});

describe("stripe-go payment_method_types (coverage check)", () => {
  it("PaymentMethodTypes: stripe.StringSlice(…) on checkout.Session and PaymentIntent params, literal and assigned", async () => {
    const us = await usages({ "go.mod": "module example.com/shop\n\ngo 1.22\n\nrequire github.com/stripe/stripe-go/v76 v76.25.0\n", "billing/checkout.go": "package billing\n\nimport (\n\t\"github.com/stripe/stripe-go/v76\"\n\t\"github.com/stripe/stripe-go/v76/checkout/session\"\n\t\"github.com/stripe/stripe-go/v76/paymentintent\"\n)\n\nfunc NewCheckout(price string) (*stripe.CheckoutSession, error) {\n\tparams := &stripe.CheckoutSessionParams{\n\t\tMode:               stripe.String(string(stripe.CheckoutSessionModePayment)),\n\t\tPaymentMethodTypes: stripe.StringSlice([]string{\"card\"}),\n\t\tLineItems: []*stripe.CheckoutSessionLineItemParams{\n\t\t\t{Price: stripe.String(price), Quantity: stripe.Int64(1)},\n\t\t},\n\t\tSuccessURL: stripe.String(\"https://example.com/ok\"),\n\t}\n\treturn session.New(params)\n}\n\nfunc NewIntent(amount int64) (*stripe.PaymentIntent, error) {\n\tparams := &stripe.PaymentIntentParams{\n\t\tAmount:             stripe.Int64(amount),\n\t\tCurrency:           stripe.String(string(stripe.CurrencyUSD)),\n\t\tPaymentMethodTypes: stripe.StringSlice([]string{\"card\"}),\n\t}\n\treturn paymentintent.New(params)\n}\n\nfunc NewIntentClient(sc *stripe.Client, amount int64) (*stripe.PaymentIntent, error) {\n\tparams := &stripe.PaymentIntentCreateParams{\n\t\tAmount:             stripe.Int64(amount),\n\t\tCurrency:           stripe.String(\"usd\"),\n\t\tPaymentMethodTypes: []*string{stripe.String(\"card\")},\n\t}\n\treturn sc.V1PaymentIntents.Create(context.TODO(), params)\n}\n\nfunc Builder(amount int64) *stripe.PaymentIntentParams {\n\tp := &stripe.PaymentIntentParams{Amount: stripe.Int64(amount)}\n\tp.PaymentMethodTypes = stripe.StringSlice([]string{\"card\", \"us_bank_account\"})\n\treturn p\n}\n" });
    const at = (op: string) => us.filter((u) => u.op === op && u.params?.includes("payment_method_types")).map((u) => u.line);
    expect(at("POST /v1/checkout/sessions")).toContain(12);
    expect(at("POST /v1/payment_intents")).toEqual(expect.arrayContaining([25, 34, 41]));
  });
});

describe("a request built in a builder the sending method gets as a callback", () => {
  it("TS: an inner arrow typed Anthropic.MessageCreateParams, sent by another method; a chatCompletion() method name isn't OpenAI's type", async () => {
    const us = await usages({ "package.json": PKG, "src/providers/claude.ts": "import Anthropic from \"@anthropic-ai/sdk\";\nimport { BaseProvider, type ChatInput, type ChatOutput } from \"./base\";\n\ntype Knob = \"temperature\" | \"top_p\";\n\nexport class ClaudeProvider extends BaseProvider {\n  private client = new Anthropic();\n\n  private async sendWithRetry<T>(model: string, build: (skip: ReadonlySet<Knob>) => Anthropic.MessageCreateParams): Promise<T> {\n    const skip = new Set<Knob>();\n    for (let i = 0; i < 2; i++) {\n      try {\n        return (await this.client.messages.create(build(skip))) as T;\n      } catch (e) {\n        skip.add(\"temperature\");\n      }\n    }\n    throw new Error(model);\n  }\n\n  async chatCompletion(input: ChatInput): Promise<ChatOutput> {\n    const model = input.model;\n    const build = (skip: ReadonlySet<Knob>): Anthropic.MessageCreateParams => {\n      const params: Anthropic.MessageCreateParams = { model, max_tokens: 1024, messages: input.messages, stream: false };\n      if (input.thinking) {\n        params.thinking = input.thinking;\n      } else {\n        if (!skip.has(\"temperature\") && typeof input.temperature === \"number\") {\n          params.temperature = input.temperature;\n        }\n        if (!skip.has(\"top_p\") && typeof input.topP === \"number\") {\n          params.top_p = input.topP;\n        }\n      }\n      return params;\n    };\n    return this.sendWithRetry<ChatOutput>(model, build);\n  }\n}\n", "src/providers/base.ts": "export class BaseProvider {}\nexport type ChatInput = any;\nexport type ChatOutput = any;\n" });
    expect(lines(us, "temperature")).toContain(29);
    expect(lines(us, "top_p")).toContain(32);
  });
  it("JS, untyped: the builder passed as an argument to the method that calls messages.create(build(skip))", async () => {
    const us = await usages({ "package.json": PKG, "lib/llm.js": "const Anthropic = require(\"@anthropic-ai/sdk\");\n\nclass ClaudeProvider {\n  constructor() {\n    this.client = new Anthropic();\n  }\n\n  async sendWithRetry(model, build, opts) {\n    const skip = new Set();\n    for (let i = 0; i < 2; i++) {\n      try {\n        return await this.client.messages.create(build(skip), opts);\n      } catch (e) {\n        skip.add(\"temperature\");\n      }\n    }\n    throw new Error(model);\n  }\n\n  async ask(input) {\n    const model = input.model;\n    const build = (skip) => {\n      const params = { model, max_tokens: 1024, messages: input.messages };\n      if (!skip.has(\"temperature\") && typeof input.temperature === \"number\") {\n        params.temperature = input.temperature;\n      }\n      if (!skip.has(\"top_p\") && typeof input.topP === \"number\") {\n        params.top_p = input.topP;\n      }\n      return params;\n    };\n    return this.sendWithRetry(model, build, { timeout: 1000 });\n  }\n}\nmodule.exports = { ClaudeProvider };\n" });
    expect(lines(us, "temperature")).toContain(25);
    expect(lines(us, "top_p")).toContain(28);
  });
  it("the same builder handed to a method that sends to OpenAI isn't an Anthropic request", async () => {
    const us = await usages({ "package.json": '{"dependencies":{"openai":"^4.0.0"}}\n', "lib/llm.js": "const OpenAI = require(\"openai\");\n\nclass ClaudeProvider {\n  constructor() {\n    this.client = new OpenAI();\n  }\n\n  async sendWithRetry(model, build, opts) {\n    const skip = new Set();\n    for (let i = 0; i < 2; i++) {\n      try {\n        return await this.client.chat.completions.create(build(skip), opts);\n      } catch (e) {\n        skip.add(\"temperature\");\n      }\n    }\n    throw new Error(model);\n  }\n\n  async ask(input) {\n    const model = input.model;\n    const build = (skip) => {\n      const params = { model, max_tokens: 1024, model_family: \"gpt\", messages: input.messages };\n      if (!skip.has(\"temperature\") && typeof input.temperature === \"number\") {\n        params.temperature = input.temperature;\n      }\n      if (!skip.has(\"top_p\") && typeof input.topP === \"number\") {\n        params.top_p = input.topP;\n      }\n      return params;\n    };\n    return this.sendWithRetry(model, build, { timeout: 1000 });\n  }\n}\nmodule.exports = { ClaudeProvider };\n" });
    expect(lines(us, "temperature")).toEqual([]);
  });
});
