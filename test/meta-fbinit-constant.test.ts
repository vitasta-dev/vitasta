import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scanRepo } from "../src/scan/index.js";

vi.setConfig({ testTimeout: 120_000 });

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-fbinit-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return ((await scanRepo(d)).usages as any[]).filter((u) => u.provider === "meta" && u.kind === "version-pin");
};
const init = (ref: string, imp: string) => `${imp}\ndeclare const FB: any;\nwindow.fbAsyncInit = function () {\n  FB.init({\n    appId: "123",\n    version: ${ref},\n  });\n};\n`;

describe("FB.init({ version: <constant from another file> })", () => {
  const shapes: [string, Record<string, string>][] = [
    ["an object constant", { "src/constants.ts": `export const Constants = {\n  META_GRAPH_VERSION: "v19.0",\n};\n`, "src/fb.ts": init("Constants.META_GRAPH_VERSION", `import { Constants } from "./constants";`) }],
    ["a class static", { "src/constants.ts": `export class Constants {\n  static META_GRAPH_VERSION = "v19.0";\n}\n`, "src/fb.ts": init("Constants.META_GRAPH_VERSION", `import { Constants } from "./constants";`) }],
    ["a bare exported constant", { "src/constants.ts": `export const META_GRAPH_VERSION = "v19.0";\n`, "src/fb.ts": init("META_GRAPH_VERSION", `import { META_GRAPH_VERSION } from "./constants";`) }],
    ["an aliased import", { "src/constants.ts": `export const Constants = { META_GRAPH_VERSION: "v19.0" };\n`, "src/fb.ts": init("C.META_GRAPH_VERSION", `import { Constants as C } from "./constants";`) }],
  ];
  for (const [name, files] of shapes) {
    it(`${name}: the init line and the constant's line are reported`, async () => {
      const us = await scan(files);
      expect(us.some((u) => u.file === "src/constants.ts" && u.apiVersion === "const: v19.0")).toBe(true);
      expect(us.find((u) => u.file === "src/fb.ts")).toMatchObject({ apiVersion: "setter: v19.0", line: expect.any(Number) });
    });
  }
  it("negatives: a literal is still read; a constant that isn't a version, or one that can't be resolved, gives no pin", async () => {
    expect((await scan({ "src/fb.ts": init(`"v2.8"`, "") })).some((u) => u.file === "src/fb.ts" && /v2\.8/.test(u.apiVersion))).toBe(true);
    expect((await scan({ "src/constants.ts": `export const Constants = { META_GRAPH_VERSION: "latest" };\n`, "src/fb.ts": init("Constants.META_GRAPH_VERSION", `import { Constants } from "./constants";`) })).some((u) => u.file === "src/fb.ts")).toBe(false);
    expect((await scan({ "src/fb.ts": init("config.version", `import { config } from "./cfg";`) })).some((u) => u.file === "src/fb.ts")).toBe(false);
  });
});
