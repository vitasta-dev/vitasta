import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canBlock } from "../src/check.js";
import { scanRepo } from "./helpers/legacy-scan.js";

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-dead-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return ((await scanRepo(d)).usages as any[]).filter((u) => u.provider === "openai");
};
const deadOf = async (files: Record<string, string>) => {
  const us = await scan(files);
  expect(us.length).toBeGreaterThan(0);
  return [...new Set(us.map((u) => !!u.dead))];
};

vi.setConfig({ testTimeout: 60_000 });
describe("dead code: a provider call in a private function nothing refers to", () => {
  it("TS: a non-exported function nobody calls is dead; called, exported or a script file is live", async () => {
    const call = (n: string) => `async function ${n}() { return client.chat.completions.create({ model: "gpt-4o", messages: [] }); }\n`;
    const head = `import OpenAI from "openai";\nconst client = new OpenAI();\n`;
    expect(await deadOf({ "a.ts": head + call("unusedHelper") })).toEqual([true]);
    expect(await deadOf({ "a.ts": head + call("usedHelper") + "usedHelper();\n" })).toEqual([false]);
    expect(await deadOf({ "a.ts": head + "export " + call("exported") })).toEqual([false]);
    // called from a file that names no provider
    expect(await deadOf({ "a.ts": head + call("viaOther") + "export { viaOther };\n" })).toEqual([false]);
    // script file with no module syntax: a global an HTML page may call
    expect(await deadOf({ "a.js": `const client = new OpenAI();\n` + call("globalFn") })).toEqual([false]);
  });
  it("TS: private methods and #private; decorators, public methods and name-in-another-file are live", async () => {
    const cls = (m: string) => `import OpenAI from "openai";\nconst client = new OpenAI();\nexport class S {\n  ${m} {\n    return client.chat.completions.create({ model: "gpt-4o", messages: [] });\n  }\n}\n`;
    expect(await deadOf({ "s.ts": cls("private async ask()") })).toEqual([true]);
    expect(await deadOf({ "s.ts": cls("async #ask()") })).toEqual([true]);
    expect(await deadOf({ "s.ts": cls("async ask()") })).toEqual([false]);
    expect(await deadOf({ "s.ts": cls("@OnEvent('x')\n  private async ask()") })).toEqual([false]);
    expect(await deadOf({ "s.ts": cls("private async ask()"), "other.ts": `import { S } from "./s";\nnew S()["ask"]();\n` })).toEqual([false]);
    expect(await deadOf({ "s.ts": cls("private async ask()") + "// ask() is used by the cron\n" })).toEqual([false]);
  });
  it("Python: _private function or method nobody calls; nested unused; public, decorated, called, getattr", async () => {
    const f = (sig: string, extra = "") => `from openai import OpenAI\nclient = OpenAI()\n${sig}\n    return client.chat.completions.create(model="gpt-4o", messages=[])\n${extra}`;
    expect(await deadOf({ "a.py": f("def _ask():") })).toEqual([true]);
    expect(await deadOf({ "a.py": f("def _ask():", "_ask()\n") })).toEqual([false]);
    // a public module function or class: dead only when nothing in the repo names it (here another module imports it)
    expect(await deadOf({ "a.py": f("def ask():"), "b.py": "from a import ask\nask()\n" })).toEqual([false]);
    expect(await deadOf({ "a.py": f("@app.task\ndef _ask():") })).toEqual([false]);
    expect(await deadOf({ "a.py": f("def _ask():", "getattr(mod, name)()\n") })).toEqual([false]);
    expect(await deadOf({ "a.py": f("def _ask():"), "b.py": "from a import _ask\n" })).toEqual([false]);
  });
  it("Java: private method nobody calls is dead; annotated, public and used ones are live", async () => {
    const j = (m: string, extra = "") => `import com.openai.client.OpenAIClient;\nclass S {\n  OpenAIClient client;\n  ${m} {\n    client.chat().completions().create(ChatCompletionCreateParams.builder().model("gpt-4o").build());\n  }\n${extra}}\n`;
    expect(await deadOf({ "S.java": j("private void ask()") })).toEqual([true]);
    expect(await deadOf({ "S.java": j("private void ask()", "  void go() { ask(); }\n"), "T.java": "class T { S s; }\n" })).toEqual([false]);
    expect(await deadOf({ "S.java": j("public void ask()"), "T.java": "class T { S s; }\n" })).toEqual([false]);
    expect(await deadOf({ "S.java": j("@Scheduled(fixedRate = 1000)\n  private void ask()") })).toEqual([false]);
  });
  it("Go: unexported func nobody calls is dead; exported, main, and calls from other files are live", async () => {
    const g = (name: string) => `package main\nimport "github.com/openai/openai-go"\nfunc ${name}() {\n  c := openai.NewClient()\n  c.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{Model: "gpt-4o"})\n}\n`;
    expect(await deadOf({ "a.go": g("ask") })).toEqual([true]);
    // (an exported function in package main nothing calls is dead since the Go-app rule; named elsewhere it is live)
    expect(await deadOf({ "a.go": g("Ask"), "b.go": "package main\nfunc run() { Ask() }\n" })).toEqual([false]);
    expect(await deadOf({ "a.go": g("main") })).toEqual([false]);
    expect(await deadOf({ "a.go": g("ask"), "b.go": "package main\nfunc run() { ask() }\n" })).toEqual([false]);
  });
  it("Ruby: private method nobody calls is dead; public, send and used ones are live", async () => {
    const r = (vis: string, extra = "") => `require "openai"\nclass S\n  def go; end\n${vis}\n  def ask\n    OpenAI::Client.new.chat(parameters: { model: "gpt-4o", messages: [] })\n  end\n${extra}end\n`;
    expect(await deadOf({ "s.rb": r("  private") })).toEqual([true]);
    expect(await deadOf({ "s.rb": r("  public"), "t.rb": "S.new.ask\n" })).toEqual([false]);
    expect(await deadOf({ "s.rb": r("  private", "  def run; ask; end\n"), "t.rb": "S.new.run\n" })).toEqual([false]);
    expect(await deadOf({ "s.rb": r("  private", "  def run(n); send(n); end\n") })).toEqual([false]);
  });
  it("C# and PHP: private methods", async () => {
    const cs = (m: string, extra = "") => `using OpenAI.Chat;\nclass S {\n  ${m} {\n    ChatClient client = new(\"gpt-4o\", key);\n    client.CompleteChat(messages);\n  }\n${extra}}\n`;
    expect(await deadOf({ "S.cs": cs("private void Ask()") })).toEqual([true]);
    expect(await deadOf({ "S.cs": cs("public void Ask()"), "T.cs": "class T { S s; }\n" })).toEqual([false]);
    expect(await deadOf({ "S.cs": cs("[HttpPost] private void Ask()") })).toEqual([false]);
    expect(await deadOf({ "S.cs": cs("private void Ask()", "  void Go() { Ask(); }\n"), "T.cs": "class T { S s; }\n" })).toEqual([false]);
    const php = (m: string, extra = "") => `<?php\nuse OpenAI;\nclass S {\n  ${m} {\n    return OpenAI::client($k)->chat()->create(['model' => 'gpt-4o', 'messages' => []]);\n  }\n${extra}}\n`;
    expect(await deadOf({ "S.php": php("private function ask()") })).toEqual([true]);
    expect(await deadOf({ "S.php": php("public function ask()"), "t.php": "<?php\n$s = new S();\n" })).toEqual([false]);
    expect(await deadOf({ "S.php": php("private function ask()", "  function go() { return $this->ask(); }\n"), "t.php": "<?php\n$s = new S();\n" })).toEqual([false]);
  });
  it("a dead usage never blocks a check and sits one confidence step lower", async () => {
    const [u] = await scan({ "a.ts": `import OpenAI from "openai";\nconst client = new OpenAI();\nfunction unusedHelper() { return client.chat.completions.create({ model: "gpt-4o", messages: [] }); }\n` });
    expect(u.dead).toBe(true);
    expect(u.reason).toMatch(/nothing in the repo calls/);
    const change: any = { selector: {}, effective: "2020-01-01" };
    expect(canBlock({ change, usage: { ...u, dead: true, role: "breaks", confidence: "certain" }, daysLeft: -1, status: "broken" } as any)).toBe(false);
    //
    expect(u.tier).toBe("also");
    expect(canBlock({ change, usage: { ...u, dead: false, context: undefined, tier: "action", role: "breaks", confidence: "certain" }, daysLeft: -1, status: "broken" } as any)).toBe(true);
  });
});
