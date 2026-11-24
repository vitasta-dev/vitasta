import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Python: a LangChain chat model whose provider comes from configuration, "possible" (set 7: etendo get_llm)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-pyprov-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const temps = async (files: Record<string, string>) =>
  ((await scanRepo(await repo(files))).usages as any[]).filter((u) => u.provider === "anthropic" && u.params?.includes("temperature")).map((u) => `${u.file}:${u.line}:${u.confidence}`);

const getLlm = `from langchain.chat_models import init_chat_model


def get_llm(model, provider, temperature):
    if get_proxy_url() is not None:
        return init_chat_model(
            model_provider="openai",
            model=provider + "/" + model,
            base_url=get_proxy_url(),
            temperature=temperature,
        )
    return init_chat_model(
        model_provider=provider,
        model=model,
        temperature=temperature,
    )
`;
const caller = `from app.llm import get_llm


def run(q):
    llm = get_llm("claude-x", "anthropic", temperature=0.2)
    return llm.invoke(q)
`;

describe("Python: provider from configuration", () => {
  it("both init_chat_model shapes are possible Anthropic calls, and the caller's value is traced", async () => {
    const r = await temps({ "requirements.txt": "langchain\nlangchain-anthropic==1.5.0\n", "app/llm.py": getLlm, "app/run.py": caller });
    expect(r).toEqual(expect.arrayContaining(["app/llm.py:10:possible", "app/llm.py:15:possible"]));
    expect(r.some((x) => x.startsWith("app/run.py:5:"))).toBe(true);
  });
  it("without an Anthropic dependency or name, a config provider isn't Anthropic", async () => {
    const r = await temps({ "requirements.txt": "langchain\nlangchain-openai\n", "app/llm.py": getLlm.replace(/        return init_chat_model\(\n            model_provider="openai"[\s\S]*?\)\n/, "        pass\n") });
    expect(r).toEqual([]);
  });
});
