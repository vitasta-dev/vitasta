import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

// golang.org/x/oauth2's facebook.Endpoint pins Graph v3.2 in every release read (src/data/library-defaults.json)
const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-oauth2-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const conf = `package conf

import (
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/facebook"
)

var Facebook = &oauth2.Config{
	ClientID: "id",
	Endpoint: facebook.Endpoint,
}
`;
const mod = "module x\n\ngo 1.22\n\nrequire (\n\tgolang.org/x/oauth2 v0.27.0\n)\n";

describe("golang.org/x/oauth2 facebook.Endpoint", () => {
  it("the default Graph version at the use and at the go.mod line", async () => {
    const us = ((await scanRepo(await repo({ "go.mod": mod, "conf/env.go": conf }))).usages as any[]).filter((u) => u.apiVersion === "default: v3.2");
    expect(us.map((u) => `${u.file}:${u.line}`).sort()).toEqual(["conf/env.go:10", "go.mod:6"]);
    expect(us[0].reason).toMatch(/golang\.org\/x\/oauth2 0\.27\.0/);
  });
  it("not when the app writes its own endpoint", async () => {
    const own = conf.replace("Endpoint: facebook.Endpoint,", 'Endpoint: facebook.Endpoint,\n\t// AuthURL: "https://www.facebook.com/v21.0/dialog/oauth"').replace("// AuthURL", "AuthURL");
    const us = ((await scanRepo(await repo({ "go.mod": mod, "conf/env.go": own }))).usages as any[]).filter((u) => u.apiVersion === "default: v3.2");
    expect(us).toEqual([]);
  });
});
