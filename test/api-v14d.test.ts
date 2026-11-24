import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const repo = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-v14d-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return d;
};
const defaults = (us: any[]) => us.filter((u) => u.apiVersion?.startsWith("default: ") && u.role === "breaks").map((u) => `${u.file}:${u.line} ${u.apiVersion.slice(9)}`);

describe("v14d: library defaults (pattern 3)", () => {
  it("passport-facebook 3.0.0 from yarn.lock, new Strategy({...}) without graphAPIVersion → v3.2; with it → nothing", async () => {
    const d = await repo({
      "package.json": '{"dependencies":{"passport-facebook":"^3.0.0"}}',
      "yarn.lock": 'passport-facebook@^3.0.0:\n  version "3.0.0"\n',
      "auth/fb.js": "const { Strategy } = require('passport-facebook');\npassport.use(new Strategy({ clientID, clientSecret, callbackURL }, verify));\n",
      "auth/fb2.js": "const FacebookStrategy = require('passport-facebook').Strategy;\npassport.use(new FacebookStrategy({ clientID, clientSecret, graphAPIVersion: 'v19.0' }, verify));\n",
      "auth/google.js": "const { Strategy } = require('passport-google-oauth20');\npassport.use(new Strategy({ clientID }, verify));\n",
    });
    const d1 = defaults((await scanRepo(d)).usages);
    expect(d1).toContain("auth/fb.js:2 v3.2");
    expect(d1.join(" ")).not.toMatch(/fb2\.js|google\.js/);
  });

  it("laravel/socialite via composer.lock: buildProvider(FacebookProvider::class) and a subclass without $version", async () => {
    const d = await repo({
      "composer.json": '{"require":{"laravel/socialite":"^5.10"}}',
      "composer.lock": '{"packages":[{"name": "laravel/socialite", "version": "v5.12.1"}]}',
      "app/Auth/Login.php": "<?php\nuse Laravel\\Socialite\\Two\\FacebookProvider;\nclass Login {\n  public function go() {\n    return Socialite::buildProvider(FacebookProvider::class, $config)->redirect();\n  }\n}\n",
      "app/Auth/MyFacebook.php": "<?php\nuse Laravel\\Socialite\\Two\\FacebookProvider;\nclass MyFacebook extends FacebookProvider {\n  protected $fields = ['name'];\n}\n",
      "app/Auth/Pinned.php": "<?php\nuse Laravel\\Socialite\\Two\\FacebookProvider;\nclass Pinned extends FacebookProvider {\n  protected $version = 'v19.0';\n}\n",
    });
    const d1 = defaults((await scanRepo(d)).usages);
    expect(d1).toContain("app/Auth/Login.php:5 v3.3");
    expect(d1).toContain("app/Auth/MyFacebook.php:3 v3.3");
    expect(d1.join(" ")).not.toMatch(/Pinned/);
  });

  it("fbgraph 1.4.4: API v2.9 at the import, dialog v2.0 at getOauthUrl; none when the repo calls setVersion", async () => {
    const files = {
      "package.json": '{"dependencies":{"fbgraph":"1.4.4"}}',
      "package-lock.json": '{"packages":{"node_modules/fbgraph":{"version":"1.4.4"}}}',
      "lib/fb.js": "const graph = require('fbgraph');\nexports.login = () => graph.getOauthUrl({ client_id: id, redirect_uri: uri });\n",
    };
    const d1 = defaults((await scanRepo(await repo(files))).usages);
    expect(d1).toContain("lib/fb.js:1 v2.9");
    expect(d1).toContain("lib/fb.js:2 v2.0");
    const d2 = defaults((await scanRepo(await repo({ ...files, "lib/setup.js": "const graph = require('fbgraph');\ngraph.setVersion('19.0');\n" }))).usages);
    expect(d2.join(" ")).not.toMatch(/lib\/fb\.js/);
  });
});
