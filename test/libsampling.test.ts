import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-libsamp-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const scan = async (files: Record<string, string>) => (await scanRepo(await repo(files))).usages as any[];
const sampling = (us: any[]) => us.filter((u) => u.provider === "anthropic" && u.params?.some((p: string) => ["temperature", "top_p", "top_k"].includes(p)));

const npm = (v: string) => ({
  "package.json": JSON.stringify({ name: "app", private: true, dependencies: { "@langchain/anthropic": v } }),
  "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@langchain/anthropic": { version: v } } }),
});
const lcApp = `import { ChatAnthropic } from "@langchain/anthropic";\nexport const llm = new ChatAnthropic({\n  model: "claude-sonnet-4-5",\n  maxTokens: 1024,\n});\n`;

describe("v18 upstream library breaks: settings a release sends that the app never sets", () => {
  it("@langchain/anthropic 0.2.10 sends temperature, top_k and top_p on every request: reported at the client and the lockfile", async () => {
    const us = sampling(await scan({ ...npm("0.2.10"), "src/llm.ts": lcApp }));
    const at = us.find((u) => u.file === "src/llm.ts");
    expect(at?.line).toBe(2);
    expect(at?.params.sort()).toEqual(["temperature", "top_k", "top_p"]);
    expect(at?.reason).toMatch(/0\.2\.10.*sends temperature 1, top_k -1, top_p -1.*1\.0\.0 and later don't/);
    expect(at?.role).toBe("breaks");
    expect(us.some((u) => u.file === "package-lock.json")).toBe(true);
  });
  it("a setting the app sets itself isn't reported twice", async () => {
    const src = lcApp.replace("maxTokens: 1024,", "maxTokens: 1024,\n  temperature: 0.3,");
    const lib = sampling(await scan({ ...npm("0.3.20"), "src/llm.ts": src })).filter((u) => u.libSent);
    expect(lib.find((u) => u.file === "src/llm.ts")?.params.sort()).toEqual(["top_k", "top_p"]);
  });
  it("1.2.0 sends nothing the app didn't set: no finding", async () => {
    expect(sampling(await scan({ ...npm("1.2.0"), "src/llm.ts": lcApp }))).toEqual([]);
  });
  it("tests aren't reported", async () => {
    expect(sampling(await scan({ ...npm("0.2.10"), "test/llm.test.ts": lcApp })).filter((u) => u.libSent)).toEqual([]);
  });
  it("ruby_llm 1.5.0 sends temperature 0.7 for a Claude model; 1.7.0 doesn't; another provider's model isn't Anthropic", async () => {
    const lock = (v: string) => `GEM\n  remote: https://rubygems.org/\n  specs:\n    ruby_llm (${v})\n\nDEPENDENCIES\n  ruby_llm\n`;
    const rb = `class Summary\n  def call(text)\n    RubyLLM.chat(model: "claude-sonnet-4-5").ask(text)\n  end\nend\n`;
    const old = sampling(await scan({ Gemfile: `gem "ruby_llm"\n`, "Gemfile.lock": lock("1.5.0"), "app/summary.rb": rb })).filter((u) => u.libSent);
    expect(old.find((u) => u.file === "app/summary.rb")?.params).toEqual(["temperature"]);
    expect(old.find((u) => u.file === "app/summary.rb")?.reason).toMatch(/temperature 0\.7.*1\.6\.3 and later don't/);
    expect(sampling(await scan({ Gemfile: `gem "ruby_llm"\n`, "Gemfile.lock": lock("1.7.0"), "app/summary.rb": rb })).filter((u) => u.libSent)).toEqual([]);
    const gpt = rb.replace("claude-sonnet-4-5", "gpt-4o");
    expect(sampling(await scan({ Gemfile: `gem "ruby_llm"\n`, "Gemfile.lock": lock("1.5.0"), "app/summary.rb": gpt })).filter((u) => u.libSent)).toEqual([]);
  });
});

describe("v18 sampling settings the app sets through a library, by what its release does with them", () => {
  const req = (pkg: string, v: string) => ({ "requirements.txt": `${pkg}==${v}\n` });
  const py = (model: string) => `from langchain_anthropic import ChatAnthropic\n\nllm = ChatAnthropic(\n    model="${model}",\n    temperature=0.2,\n)\n`;
  it("langchain-anthropic 1.7.5 drops temperature for claude-fable-5 (removed) and sends it for claude-sonnet-4-5", async () => {
    expect(sampling(await scan({ ...req("langchain-anthropic", "1.7.5"), "app/llm.py": py("claude-fable-5") }))).toEqual([]);
    const sent = sampling(await scan({ ...req("langchain-anthropic", "1.7.5"), "app/llm.py": py("claude-sonnet-4-5") }));
    expect(sent.some((u) => u.file === "app/llm.py" && u.params.includes("temperature"))).toBe(true);
  });
  it("langchain-anthropic 1.6.0 sends it for claude-fable-5 too (before the drop)", async () => {
    const sent = sampling(await scan({ ...req("langchain-anthropic", "1.6.0"), "app/llm.py": py("claude-fable-5") }));
    expect(sent.some((u) => u.file === "app/llm.py")).toBe(true);
  });
  const ll = (model: string, extra = "") => `import litellm\n${extra}\ndef ask(q):\n    return litellm.completion(\n        model="${model}",\n        messages=[{"role": "user", "content": q}],\n        temperature=0.5,\n    )\n`;
  it("litellm 1.89.0 rejects temperature for claude-opus-4-7 before sending; with drop_params it drops it (removed)", async () => {
    const raised = sampling(await scan({ ...req("litellm", "1.89.0"), "app/ask.py": ll("anthropic/claude-opus-4-7") }));
    expect(raised.find((u) => u.file === "app/ask.py")?.reason ?? "").toMatch(/already rejects it for claude-opus-4-7/);
    expect(sampling(await scan({ ...req("litellm", "1.89.0"), "app/ask.py": ll("anthropic/claude-opus-4-7", "litellm.drop_params = True") }))).toEqual([]);
  });
  it("litellm 1.85.2 (a patch release on a line without the backported check) sends it", async () => {
    const sent = sampling(await scan({ ...req("litellm", "1.85.2"), "app/ask.py": ll("anthropic/claude-opus-4-7", "litellm.drop_params = True") }));
    expect(sent.some((u) => u.file === "app/ask.py")).toBe(true);
  });
});
