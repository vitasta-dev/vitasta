import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// Spring AI's Anthropic chat model by release (feed data/_springai-anthropic-sampling.json, read from the published
// sources): 1.x and 2.0.x send the app's temperature / topP / topK, 2.1.0 sends none of them
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-springai-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const sampling = async (files: Record<string, string>) =>
  ((await scanRepo(await repo(files))).usages as any[]).filter((u) => u.provider === "anthropic" && u.params?.some((p: string) => /temperature|top_p/.test(p)));

const J = "src/main/java/app";
const chat = `package app;
import org.springframework.ai.anthropic.AnthropicChatOptions;
class Chat {
  @Value("\${app.temperature:0.4}")
  private Double temperature;
  Object options() {
    return AnthropicChatOptions.builder()
        .model("claude-sonnet-4-5")
        .temperature(temperature)
        .topP(0.9)
        .build();
  }
}
`;
const pom = (version: string, prop = false) => `<project>
  ${prop ? `<properties><spring-ai.version>${version}</spring-ai.version></properties>` : ""}
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-starter-model-anthropic</artifactId>
      <version>${prop ? "${spring-ai.version}" : version}</version>
    </dependency>
  </dependencies>
</project>
`;

describe("Spring AI Anthropic sampling settings by release", () => {
  it("2.1.0 drops them: the builder's settings and the traced default aren't findings", async () => {
    const us = await sampling({ "pom.xml": pom("2.1.0"), [`${J}/Chat.java`]: chat });
    expect(us).toEqual([]);
  });
  it("2.0.3 sends them: reported, with the release named", async () => {
    const us = await sampling({ "pom.xml": pom("2.0.3"), [`${J}/Chat.java`]: chat });
    const t = us.find((u) => u.file === `${J}/Chat.java` && u.line === 9);
    expect(t).toBeTruthy();
    expect(t.reason).toMatch(/spring-ai-anthropic 2\.0\.3/);
    expect(us.some((u) => u.line === 4)).toBe(true);
  });
  it("a version from a pom property, and from Gradle", async () => {
    expect(await sampling({ "pom.xml": pom("2.1.0", true), [`${J}/Chat.java`]: chat })).toEqual([]);
    expect(await sampling({ "build.gradle": "dependencies {\n  implementation platform('org.springframework.ai:spring-ai-bom:2.1.0')\n}\n", [`${J}/Chat.java`]: chat })).toEqual([]);
  });
  it("no Spring AI version anywhere: left as found", async () => {
    const us = await sampling({ [`${J}/Chat.java`]: chat });
    expect(us.some((u) => u.line === 9)).toBe(true);
  });
});
