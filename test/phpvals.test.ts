import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const FILES: Record<string, string> = {
  "phpv/src/Social/FacebookProvider.php": "<?php\nnamespace App\\Social;\n\nuse GuzzleHttp\\Client;\n\nclass FacebookProvider extends BaseProvider\n{\n    public function user($token)\n    {\n        $version = config('services.facebook.version', $this->graphVersion);\n        $res = (new Client)->get('https://graph.facebook.com/' . $version . '/me', ['query' => ['access_token' => $token]]);\n        return json_decode($res->getBody(), true);\n    }\n    public function pages($token)\n    {\n        return (new Client)->get('https://graph.facebook.com/' . self::API_VERSION . '/me/accounts');\n    }\n}\n",
  "phpv/src/Social/BaseProvider.php": "<?php\nnamespace App\\Social;\n\nabstract class BaseProvider\n{\n    protected $graphVersion = 'v19.0';\n    const API_VERSION = 'v20.0';\n}\n"
};

describe("PHP: class constants, property defaults and config fallbacks reaching a URL, through a parent class", () => {
  it("$this->prop and self::CONST from a parent class in another file", async () => {
    const d = await mkdtemp(join(tmpdir(), "vitasta-phpvals-"));
    for (const [p, t] of Object.entries(FILES)) {
      await mkdir(dirname(join(d, p)), { recursive: true });
      await writeFile(join(d, p), t);
    }
    const us = (await scanRepo(d)).usages.filter((u: any) => u.file === "phpv/src/Social/FacebookProvider.php" && u.apiVersion);
    expect(us.map((u: any) => `${u.line}:${u.apiVersion}`).sort()).toEqual(["11:url: v19.0", "16:url: v20.0"]);
  });
});
