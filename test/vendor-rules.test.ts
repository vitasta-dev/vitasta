import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";
import { compatibleHosts, fileOfVendor, foreignVendorOf, vendorDirs } from "../src/scan/vendors.js";

// Review, 23 Nov: false positives fixed as generic rules (src/scan/vendors.ts, src/scan/flow.ts)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-vendor-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const sampling = async (files: Record<string, string>) =>
  ((await scanRepo(await repo(files))).usages as any[]).filter((u) => u.provider === "anthropic" && u.params?.some((p: string) => /temperature|top_p|top_k/.test(p)));
const places = (us: any[]) => us.flatMap((u) => [u.line, ...(u.alsoLines ?? [])].map((l: number) => `${u.file}:${l}`));

const J = "src/main/java/app";
const chat = (pkg: string, cls: string, extra = "") => `package app.${pkg};
import org.springframework.ai.anthropic.AnthropicChatOptions;
class ${cls} {
${extra}  Object options() {
    return AnthropicChatOptions.builder().model("m").temperature(0.7).build();
  }
}
`;

describe("1. a provider's client pointed at another vendor's compatible endpoint", () => {
  it("drops the provider's findings in that vendor's code; keeps the provider's own", async () => {
    const us = await sampling({
      [`${J}/provider/minimax/MinimaxChatService.java`]: chat("provider.minimax", "MinimaxChatService", '  @Value("${minimax.base-url:https://api.minimax.io/anthropic}") String baseUrl;\n'),
      [`${J}/provider/anthropic/AnthropicChatService.java`]: chat("provider.anthropic", "AnthropicChatService"),
    });
    expect(us.map((u) => u.file)).toEqual([`${J}/provider/anthropic/AnthropicChatService.java`]);
  });
  it("a gateway that passes requests through isn't a vendor", () => {
    expect(compatibleHosts([{ source: '"https://gateway.ai.cloudflare.com/v1/a/b/anthropic"' }], "anthropic", ["api.anthropic.com"]).size).toBe(0);
    expect([...compatibleHosts([{ source: '"https://api.minimax.io/anthropic"' }], "anthropic", ["api.anthropic.com"]).keys()]).toEqual(["minimax"]);
    expect(compatibleHosts([{ source: '"https://api.anthropic.com/v1"' }], "anthropic", ["api.anthropic.com"]).size).toBe(0);
  });
  it("a vendor's code: its directory or a file name word, not a reverse-domain package root", () => {
    expect(fileOfVendor("a/provider/minimax/X.java", "minimax")).toBe(true);
    expect(fileOfVendor("a/SpringAIMinimaxService.java", "minimax")).toBe(true);
    expect(fileOfVendor("src/com/minimax/llm/AnthropicClient.java", "minimax")).toBe(false);
    expect(fileOfVendor("a/OpenAIClient.java", "openai")).toBe(true);
    expect(fileOfVendor("a/Reopen.java", "openai")).toBe(false);
  });
});

describe("2. a call without a receiver resolves to its own class, an ancestor or a static import", () => {
  const svc = `package app.ai;
import org.springframework.ai.anthropic.AnthropicChatOptions;
class Svc {
  Object options(Cfg req, Cfg base) {
    Double t = defaultValue(req.getTemperature(), base.getTemperature());
    Long id = defaultValue(req.getUserId(), 0L);
    return AnthropicChatOptions.builder().model("m").temperature(t).build();
  }
  private static <T> T defaultValue(T value, T fallback) {
    return value != null ? value : fallback;
  }
}
`;
  const cfg = `package app.ai;
class Cfg {
  private Double temperature = 0.3;
  private Long userId;
  Double getTemperature() { return temperature; }
  Long getUserId() { return userId; }
}
`;
  const sql = `package app.sql;
class SqlDefaults {
  public static String defaultValue(String type) {
    return "0.0";
  }
}
`;
  it("a generic method of the class (private static <T> T name(…)), never another class's method of that name", async () => {
    const ps = places(await sampling({ [`${J}/ai/Svc.java`]: svc, [`${J}/ai/Cfg.java`]: cfg, [`${J}/sql/SqlDefaults.java`]: sql }));
    expect(ps).toContain(`${J}/ai/Cfg.java:3`);
    expect(ps.some((p) => p.includes("SqlDefaults"))).toBe(false);
    // the call entered through line 5 takes that call's arguments, not line 6's (0L is a user id)
    expect(ps).not.toContain(`${J}/ai/Svc.java:6`);
  });
});

describe("3. vendor directories: another vendor's options class doesn't feed this provider", () => {
  it("vendor directories need a sibling vendor directory", () => {
    const d = vendorDirs(["a/providers/anthropic/A.java", "a/providers/cohere/C.java", "b/writer/W.java"]);
    expect(d.get("a/providers/cohere")).toBe("cohere");
    expect(d.has("b/writer")).toBe(false);
    expect(foreignVendorOf("a/providers/cohere/C.java", "anthropic", d)).toBe("cohere");
    expect(foreignVendorOf("a/providers/anthropic/A.java", "anthropic", d)).toBeUndefined();
  });
  it("an interface's implementer in another vendor's directory is skipped", async () => {
    const opts = (pkg: string, cls: string, v: string) => `package app.providers.${pkg};
class ${cls} implements ChatOptions {
  private Double temperature = ${v};
  public Double getTemperature() { return this.temperature; }
}
`;
    const ps = places(await sampling({
      [`${J}/providers/ChatOptions.java`]: "package app.providers;\ninterface ChatOptions { Double getTemperature(); }\n",
      [`${J}/providers/anthropic/AnthropicModel.java`]: `package app.providers.anthropic;
import org.springframework.ai.anthropic.AnthropicChatOptions;
class AnthropicModel {
  Object call(ChatOptions options) {
    return AnthropicChatOptions.builder().model("m").temperature(options.getTemperature()).build();
  }
}
`,
      [`${J}/providers/anthropic/AnthropicOptions.java`]: opts("anthropic", "AnthropicOptions", "0.5"),
      [`${J}/providers/cohere/CohereOptions.java`]: opts("cohere", "CohereOptions", "0.3"),
    }));
    expect(ps.some((p) => p.includes("AnthropicOptions.java"))).toBe(true);
    expect(ps.some((p) => p.includes("CohereOptions"))).toBe(false);
  });
});

describe("5. the same object gets another provider next to the setting", () => {
  it("a robot's defaults with provider = a constant naming another provider aren't Anthropic's", async () => {
    const files = (prov: string) => ({
      [`${J}/core/Defaults.java`]: `package app.core;\npublic class Defaults {\n  public static final String PROVIDER = "${prov}";\n}\n`,
      [`${J}/robot/Llm.java`]: "package app.robot;\npublic class Llm {\n  private Double temperature;\n  public Double getTemperature() { return temperature; }\n  public void setTemperature(Double t) { this.temperature = t; }\n  public void setProvider(String p) { }\n}\n",
      [`${J}/robot/Setup.java`]: `package app.robot;
class Setup {
  Llm create() {
    Llm llm = new Llm();
    llm.setProvider(app.core.Defaults.PROVIDER);
    llm.setTemperature(0.0);
    return llm;
  }
}
`,
      [`${J}/ai/Chat.java`]: `package app.ai;
import org.springframework.ai.anthropic.AnthropicChatOptions;
class Chat {
  Object options(app.robot.Llm llm) {
    return AnthropicChatOptions.builder().model("m").temperature(llm.getTemperature()).build();
  }
}
`,
    });
    expect(places(await sampling(files("dashscope")))).not.toContain(`${J}/robot/Setup.java:6`);
    expect(places(await sampling(files("anthropic")))).toContain(`${J}/robot/Setup.java:6`);
  });
});

describe("6. a catch-and-retry that drops the settings is said in the why", () => {
  it("Go: retry without temperature after a 400; still reported", async () => {
    const us = await sampling({
      "go.mod": "module x\n\nrequire github.com/anthropics/anthropic-sdk-go v1.2.0\n",
      "ai.go": `package ai

import "github.com/anthropics/anthropic-sdk-go"

func Complete(c anthropic.Client, t float64) error {
	params := anthropic.MessageNewParams{MaxTokens: 100}
	params.Temperature = anthropic.Float(t)
	_, err := c.Messages.New(ctx, params)
	if err != nil && rejected(err) {
		params.Temperature = anthropic.MessageNewParams{}.Temperature
		_, err = c.Messages.New(ctx, params)
	}
	return err
}
`,
    });
    const u = us.find((x) => x.line === 7);
    expect(u).toBeTruthy();
    expect(u.handled).toMatch(/retried without temperature/);
    expect(u.reason).toMatch(/handled: retried/);
  });
});
