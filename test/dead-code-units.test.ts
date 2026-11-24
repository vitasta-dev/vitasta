import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "./helpers/legacy-scan.js";

vi.setConfig({ testTimeout: 120_000 });

const deadOf = async (files: Record<string, string>, file: string) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-deadunit-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  const us = ((await scanRepo(d)).usages as any[]).filter((u) => u.provider === "openai" && u.file === file);
  expect(us.length, file).toBeGreaterThan(0);
  return [...new Set(us.map((u) => !!u.dead))];
};
const PHP_CALL = "    return OpenAI::client($k)->chat()->create(['model' => 'gpt-4o', 'messages' => []]);\n";
const php = (head: string, cls = "Chat") => `<?php\nuse OpenAI;\n${head}class ${cls} {\n  public function go() {\n${PHP_CALL}  }\n}\n`;
const PY_CALL = "from openai import OpenAI\nclient = OpenAI()\n";
const pyFn = (name: string) => `${PY_CALL}def ${name}():\n    return client.chat.completions.create(model="gpt-4o", messages=[])\n`;

describe("dead code: an unreferenced class or function, and code after a top-level stop", () => {
  it("PHP: a class after a file-scope die() / exit never runs (chat_old.php)", async () => {
    expect(await deadOf({ "chat_old.php": php(`die("retired");\n`) }, "chat_old.php")).toEqual([true]);
    expect(await deadOf({ "chat_old.php": php("exit;\n") }, "chat_old.php")).toEqual([true]);
    expect(await deadOf({ "chat_old.php": php("exit(0);\n"), "other.php": "<?php\n$c = new Chat();\n" }, "chat_old.php")).toEqual([true]);
  });
  it("PHP: an unreferenced plain class is dead; one named by `new`, `::class`, a route file or a config string is live", async () => {
    expect(await deadOf({ "chat_old.php": php(""), "other.php": "<?php\n$x = 1;\n" }, "chat_old.php")).toEqual([true]);
    expect(await deadOf({ "chat_old.php": php(""), "x.php": "<?php\n$c = new chat();\n" }, "chat_old.php")).toEqual([false]);
    expect(await deadOf({ "app/ChatController.php": php("", "ChatController"), "routes/web.php": "<?php\nRoute::get('/chat', [ChatController::class, 'go']);\n" }, "app/ChatController.php")).toEqual([false]);
    expect(await deadOf({ "app/Chat.php": php(""), "config/handlers.yaml": "handler: App\\Chat\n" }, "app/Chat.php")).toEqual([false]);
  });
  it("PHP negatives: a die() inside a function or an if, a class with a base, attributes, a published library", async () => {
    expect(await deadOf({ "chat.php": `<?php\nfunction bail() { die("x"); }\nif (!defined('X')) die;\n` + php("").slice(6), "use.php": "<?php\nnew Chat();\n" }, "chat.php")).toEqual([false]);
    expect(await deadOf({ "app/Chat.php": php("").replace("class Chat {", "class Chat extends Controller {") }, "app/Chat.php")).toEqual([false]);
    expect(await deadOf({ "app/Chat.php": php("").replace("  public function go", "  #[Route('/x')]\n  public function go") }, "app/Chat.php")).toEqual([false]);
    expect(await deadOf({ "src/Chat.php": php(""), "composer.json": '{ "name": "a/b", "type": "library" }' }, "src/Chat.php")).toEqual([false]);
  });
  it("Python: code after sys.exit() / raise SystemExit at module top never runs; inside a function or an if it does", async () => {
    expect(await deadOf({ "old.py": `import sys\nsys.exit(1)\n${pyFn("chat")}` }, "old.py")).toEqual([true]);
    expect(await deadOf({ "old.py": `${PY_CALL}raise SystemExit\ndef chat():\n    return client.chat.completions.create(model="gpt-4o", messages=[])\n` }, "old.py")).toEqual([true]);
    expect(await deadOf({ "old.py": `import sys\ndef quit_now():\n    sys.exit(1)\nif len(sys.argv) < 2:\n    sys.exit(2)\n${pyFn("chat")}`, "main.py": "from old import chat\nchat()\n" }, "old.py")).toEqual([false]);
    // a call before the stop still runs
    expect(await deadOf({ "run.py": `${PY_CALL}client.chat.completions.create(model="gpt-4o", messages=[])\nimport sys\nsys.exit(0)\n` }, "run.py")).toEqual([false]);
  });
  it("Python: an unreferenced class or module function is dead; referenced, in a __main__ script, decorated, with a base class, or in a published package is live", async () => {
    const cls = `${PY_CALL}class Chat:\n    def go(self):\n        return client.chat.completions.create(model="gpt-4o", messages=[])\n`;
    expect(await deadOf({ "chat_old.py": cls, "other.py": "x = 1\n" }, "chat_old.py")).toEqual([true]);
    // a public module function is left alone (scripts and notebooks import those); a lone file is a script
    expect(await deadOf({ "chat_old.py": pyFn("chat"), "other.py": "x = 1\n" }, "chat_old.py")).toEqual([false]);
    expect(await deadOf({ "chat_old.py": cls }, "chat_old.py")).toEqual([false]);
    expect(await deadOf({ "chat_old.py": cls, "b.py": "from chat_old import Chat\nChat().go()\n" }, "chat_old.py")).toEqual([false]);
    // Django: a view named in urls.py
    expect(await deadOf({ "app/views.py": pyFn("chat"), "app/urls.py": "from . import views\nurlpatterns = [path('chat/', views.chat)]\n" }, "app/views.py")).toEqual([false]);
    // only a string in config
    expect(await deadOf({ "chat_old.py": cls, "settings.yaml": "handler: chat_old.Chat\n" }, "chat_old.py")).toEqual([false]);
    expect(await deadOf({ "chat_old.py": cls + 'if __name__ == "__main__":\n    pass\n' }, "chat_old.py")).toEqual([false]);
    expect(await deadOf({ "chat_old.py": cls.replace("class Chat:", "@register\nclass Chat:") }, "chat_old.py")).toEqual([false]);
    expect(await deadOf({ "chat_old.py": cls.replace("class Chat:", "class Chat(View):") }, "chat_old.py")).toEqual([false]);
    expect(await deadOf({ "pkg/chat.py": cls, "setup.py": "from setuptools import setup\nsetup(name='x')\n" }, "pkg/chat.py")).toEqual([false]);
  });
  it("TS, Java, C#, Ruby: unreferenced plain classes; exported, public, annotated, based or named elsewhere stay live", async () => {
    const ts = (head: string) => `import OpenAI from "openai";\nconst client = new OpenAI();\n${head}class Chat {\n  go() {\n    return client.chat.completions.create({ model: "gpt-4o", messages: [] });\n  }\n}\n`;
    expect(await deadOf({ "chat.ts": ts("") }, "chat.ts")).toEqual([true]);
    expect(await deadOf({ "chat.ts": ts("export ") }, "chat.ts")).toEqual([false]);
    expect(await deadOf({ "chat.ts": ts(""), "use.ts": "const x = Chat;\n" }, "chat.ts")).toEqual([false]);
    expect(await deadOf({ "chat.ts": ts("").replace("class Chat {", "class Chat extends Base {") }, "chat.ts")).toEqual([false]);
    const java = (head: string) => `import com.openai.client.OpenAIClient;\n${head}class Chat {\n  OpenAIClient client;\n  void go() {\n    client.chat().completions().create(ChatCompletionCreateParams.builder().model("gpt-4o").build());\n  }\n}\n`;
    expect(await deadOf({ "Chat.java": java("") }, "Chat.java")).toEqual([true]);
    expect(await deadOf({ "Chat.java": java("public ") }, "Chat.java")).toEqual([false]);
    expect(await deadOf({ "Chat.java": java("@Component\n") }, "Chat.java")).toEqual([false]);
    expect(await deadOf({ "Chat.java": java("").replace("class Chat {", "class Chat extends Base {") }, "Chat.java")).toEqual([false]);
    const cs = (head: string, base = "") => `using OpenAI.Chat;\n${head}class Talker${base} {\n  public void Go() {\n    ChatClient client = new(\"gpt-4o\", key);\n    client.CompleteChat(messages);\n  }\n}\n`;
    expect(await deadOf({ "Chat.cs": cs("") }, "Chat.cs")).toEqual([true]);
    expect(await deadOf({ "Chat.cs": cs("public ") }, "Chat.cs")).toEqual([false]);
    expect(await deadOf({ "Chat.cs": cs("", " : ControllerBase") }, "Chat.cs")).toEqual([false]);
    const rb = (sup = "") => `require "openai"\nclass Chat${sup}\n  def go\n    OpenAI::Client.new.chat(parameters: { model: "gpt-4o", messages: [] })\n  end\nend\n`;
    expect(await deadOf({ "chat.rb": rb(), "other.rb": "x = 1\n" }, "chat.rb")).toEqual([true]);
    expect(await deadOf({ "chat.rb": rb(" < ApplicationController") }, "chat.rb")).toEqual([false]);
    expect(await deadOf({ "chat.rb": rb(), "x.gemspec": "Gem::Specification.new { |s| s.name = 'x' }\n" }, "chat.rb")).toEqual([false]);
  });
  it("Node: process.exit() at the top level before the code", async () => {
    const body = `import OpenAI from "openai";\nconst client = new OpenAI();\nprocess.exit(0);\nexport async function go() {\n  return client.chat.completions.create({ model: "gpt-4o", messages: [] });\n}\n`;
    expect(await deadOf({ "old.ts": body }, "old.ts")).toEqual([true]);
    expect(await deadOf({ "old.ts": body.replace("process.exit(0);", "if (process.argv.length < 3) process.exit(0);") }, "old.ts")).toEqual([false]);
  });
  it("loaded by convention, not by name: a class-name string built at run time, importlib, entry points", async () => {
    // PSR-4 autoload + a container binding with a name built from a string
    const svc = php("namespace App\\Services;\n".replace("namespace", "// namespace"), "Chat");
    expect(await deadOf({ "app/Services/Chat.php": svc, "other.php": "<?php\n$x = 1;\n" }, "app/Services/Chat.php")).toEqual([true]);
    expect(await deadOf({ "app/Services/Chat.php": svc, "app/Http/Boot.php": '<?php\nfunction boot($name) { return app()->make("App\\\\Services\\\\" . $name); }\n' }, "app/Services/Chat.php")).toEqual([false]);
    expect(await deadOf({ "app/Services/Chat.php": svc, "app/Http/Boot.php": '<?php\nfunction boot($class) { return new $class(); }\n' }, "app/Services/Chat.php")).toEqual([false]);
    // Python: importlib, and a plugin group in pyproject / setup.cfg that lists the module only
    const cls = `${PY_CALL}class Chat:\n    def go(self):\n        return client.chat.completions.create(model="gpt-4o", messages=[])\n`;
    expect(await deadOf({ "plugins/chat_old.py": cls, "other.py": "x = 1\n" }, "plugins/chat_old.py")).toEqual([true]);
    expect(await deadOf({ "plugins/chat_old.py": cls, "loader.py": "import importlib\ndef load(n):\n    return importlib.import_module('plugins.' + n)\n" }, "plugins/chat_old.py")).toEqual([false]);
    expect(await deadOf({ "plugins/chat_old.py": cls, "other.py": "x = 1\n", "pyproject.toml": '[project.entry-points."myapp.plugins"]\nchat = "plugins.chat_old"\n' }, "plugins/chat_old.py")).toEqual([false]);
    expect(await deadOf({ "plugins/chat_old.py": cls, "other.py": "x = 1\n", "setup.cfg": "[options.entry_points]\nmyapp.plugins =\n    chat = plugins.chat_old\n" }, "plugins/chat_old.py")).toEqual([false]);
    // Ruby and Java load by name too
    expect(await deadOf({ "chat.rb": `require "openai"\nclass Chat\n  def go\n    OpenAI::Client.new.chat(parameters: { model: "gpt-4o", messages: [] })\n  end\nend\n`, "other.rb": "def load(n)\n  Object.const_get(n).new\nend\n" }, "chat.rb")).toEqual([false]);
  });
});
