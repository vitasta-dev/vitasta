import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 120_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-springver-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return (await scanRepo(d)).usages as any[];
};
const pins = (us: any[]) => us.filter((u) => u.provider === "meta" && u.kind === "version-pin");

const PROJECT = `package app;\npublic class Project {\n  private String apiVersion;\n  public String getApiVersion() { return apiVersion; }\n  public void setApiVersion(String v) { this.apiVersion = v; }\n}\n`;
const sender = (fallback = `(v != null && !v.isBlank()) ? v : "v23.0"`) => `package app;
import org.springframework.web.client.RestTemplate;
public class Sender {
  RestTemplate restTemplate = new RestTemplate();
  void send(Project project, String id, String body) {
    String v = project.getApiVersion();
    String version = ${fallback};
    String url = "https://graph.facebook.com/" + version + "/" + id + "/messages";
    restTemplate.postForEntity(url, body, String.class);
  }
}
`;
const valueSetup = (key: string) => `package app;\nimport org.springframework.beans.factory.annotation.Value;\npublic class Setup {\n  @Value("\${${key}}")\n  private String defaultVersion;\n  void init(Project project) {\n    project.setApiVersion(defaultVersion);\n  }\n}\n`;
const J = "src/main/java/app";

describe("a Graph version read from Spring config, stored on an entity, read back into the URL (Java)", () => {
  it("@Value on a field: reported at the URL line (with the property file and line), at the @Value line, and the literal fallback too", async () => {
    const us = pins(await scan({ "src/main/resources/application.properties": "spring.facebook.app.version=v22.0\n", [`${J}/Project.java`]: PROJECT, [`${J}/Setup.java`]: valueSetup("spring.facebook.app.version"), [`${J}/Sender.java`]: sender() }));
    const at8 = us.filter((u) => u.file === `${J}/Sender.java` && u.line === 8).map((u) => u.apiVersion).sort();
    expect(at8).toEqual(["url: v22.0", "url: v23.0"]);
    const cfg = us.find((u) => u.file === `${J}/Sender.java` && u.line === 8 && u.apiVersion === "url: v22.0");
    expect(cfg.alsoAt).toEqual(["src/main/resources/application.properties:1"]);
    expect(cfg.reason).toMatch(/@Value\(spring\.facebook\.app\.version\)/);
    expect(us.some((u) => u.file === `${J}/Setup.java` && u.line === 4 && u.apiVersion === "url: v22.0")).toBe(true);
    // the literal fallback is its own place
    expect(us.some((u) => u.file === `${J}/Sender.java` && u.line === 7 && u.apiVersion === "url: v23.0")).toBe(true);
    expect(us.some((u) => u.file === "src/main/resources/application.properties")).toBe(true);
  });
  it("env.getProperty(\"key\") and a YAML value", async () => {
    const setup = `package app;\nimport org.springframework.core.env.Environment;\npublic class Setup {\n  Environment env;\n  void init(Project project) {\n    project.setApiVersion(env.getProperty("spring.facebook.app.version"));\n  }\n}\n`;
    const us = pins(await scan({ "src/main/resources/application.yml": "spring:\n  facebook:\n    app:\n      version: v22.0\n", [`${J}/Project.java`]: PROJECT, [`${J}/Setup.java`]: setup, [`${J}/Sender.java`]: sender() }));
    const cfg = us.find((u) => u.file === `${J}/Sender.java` && u.line === 8 && u.apiVersion === "url: v22.0");
    expect(cfg?.alsoAt).toEqual(["src/main/resources/application.yml:4"]);
  });
  it("negatives: another key, a property that isn't a version, no entity link", async () => {
    // a different key than the one the code reads
    let us = pins(await scan({ "src/main/resources/application.properties": "spring.other.version=v22.0\n", [`${J}/Project.java`]: PROJECT, [`${J}/Setup.java`]: valueSetup("spring.facebook.app.version"), [`${J}/Sender.java`]: sender() }));
    expect(us.filter((u) => u.file === `${J}/Sender.java` && u.line === 8).map((u) => u.apiVersion)).toEqual(["url: v23.0"]);
    // a property whose value isn't a version never makes a URL pin
    us = pins(await scan({ "src/main/resources/application.properties": "spring.facebook.app.version=latest\n", [`${J}/Project.java`]: PROJECT, [`${J}/Setup.java`]: valueSetup("spring.facebook.app.version"), [`${J}/Sender.java`]: sender() }));
    expect(us.some((u) => u.apiVersion === "url: latest")).toBe(false);
    // nothing sets the entity's version: only the fallback
    us = pins(await scan({ "src/main/resources/application.properties": "spring.facebook.app.version=v22.0\n", [`${J}/Project.java`]: PROJECT, [`${J}/Sender.java`]: sender() }));
    expect(us.filter((u) => u.file === `${J}/Sender.java` && u.line === 8).map((u) => u.apiVersion)).toEqual(["url: v23.0"]);
  });
});
