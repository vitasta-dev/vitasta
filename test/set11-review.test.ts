import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Review: (24 Nov): generic fixes on hand-written code (never set 11's)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-s11r-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const usages = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];

describe("1. Python SDK resources on a client held elsewhere", () => {
  it("self.client.beta.assistants.create and self.tutor.client.beta.assistants.update", async () => {
    const us = await usages({
      "requirements.txt": "openai>=1.30\n",
      "app/quota.py": "from openai import OpenAI\n\ndef make_client(key):\n    return OpenAI(api_key=key)\n",
      "app/tutor.py": 'from app.quota import make_client\n\nclass Tutor:\n    def __init__(self, key):\n        self.client = make_client(key)\n\n    def setup(self):\n        return self.client.beta.assistants.create(name="T", model="gpt-4o")\n\nclass Runner:\n    def update(self, aid):\n        return self.tutor.client.beta.assistants.update(aid)\n',
    });
    const ops = us.filter((u) => u.provider === "openai" && u.op).map((u) => `${u.line} ${u.op}`);
    expect(ops).toContain("8 * /v1/assistants");
    expect(ops).toContain("12 * /v1/assistants");
  });
  it("not without the SDK among the dependencies", async () => {
    const us = await usages({ "app/x.py": "class A:\n    def f(self):\n        return self.client.beta.assistants.create(name='T')\n" });
    expect(us.filter((u) => u.op)).toEqual([]);
  });
});

describe("model defaults in config placeholders", () => {
  it("Java @Value(\"${llm.model:gpt-4o}\") and application.yml ${LLM_MODEL:gpt-4.1}", async () => {
    const us = await usages({
      "src/main/java/a/Llm.java": 'package a;\npublic class Llm {\n    @Value("${llm.model:gpt-4o}")\n    private String model;\n}\n',
      "src/main/resources/application.yml": "llm:\n  default-model: ${LLM_MODEL:gpt-4.1}\n",
    });
    const at = us.filter((u) => u.model).map((u) => `${u.file.split("/").pop()}:${u.line}:${u.model}:${u.role}`);
    expect(at).toContain("Llm.java:3:gpt-4o:breaks");
    expect(at).toContain("application.yml:2:gpt-4.1:breaks");
  });
});

describe("C# model constants chosen by a default", () => {
  it("DefaultModels.Chat = ChatCompletionModels.Gpt4o, and Model = DefaultModels.Chat", async () => {
    const us = await usages({
      "src/Models.cs": 'namespace Lib\n{\n    public static class ChatCompletionModels\n    {\n        public const string Gpt4o = "gpt-4o";\n    }\n    public static class DefaultModels\n    {\n        public static string Chat = ChatCompletionModels.Gpt4o;\n    }\n}\n',
      "src/Client.cs": "namespace Lib\n{\n    public class Client\n    {\n        public string Model { get; set; } = DefaultModels.Chat;\n    }\n}\n",
    });
    const at = us.filter((u) => u.model === "gpt-4o").map((u) => `${u.file}:${u.line}`);
    expect(at).toContain("src/Models.cs:9");
    expect(at).toContain("src/Client.cs:5");
  });
});

describe("users' copies", () => {
  it("a per-environment env template and Markdown aren't failing; a plain .env.example still is the app's default", async () => {
    const us = await usages({ ".env.production.example": "OPENAI_MODEL=gpt-4o\n", "docs/agent.md": "---\nmodel: gpt-4o\n---\n", ".env.example": "OPENAI_MODEL=gpt-4o\n" });
    const role = (f: string) => us.find((u) => u.file === f)?.role;
    expect(role(".env.production.example")).toBe("users-copy");
    if (us.some((u) => u.file === "docs/agent.md")) expect(role("docs/agent.md")).toBe("users-copy");
    expect(role(".env.example")).toBe("breaks");
  });
});
