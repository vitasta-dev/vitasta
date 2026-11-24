import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const FILES: Record<string, string> = {
  "gov/go.mod": "module github.com/acme/app\n\ngo 1.22\n",
  "gov/cmd/main.go": "package main\n\nimport (\n\t\"fmt\"\n\t\"net/http\"\n\n\t\"github.com/acme/app/internal/fb\"\n)\n\nfunc main() {\n\turl := fmt.Sprintf(\"https://graph.facebook.com/%s/me/accounts\", fb.APIVersion)\n\thttp.Get(url)\n}\n",
  "gov/internal/fb/consts.go": "package fb\n\nconst (\n\tAPIVersion = \"v19.0\"\n\tGraphURL   = \"https://graph.facebook.com/\" + APIVersion\n)\n",
  "gov/internal/fb/client.go": "package fb\n\nimport \"net/http\"\n\nfunc Me(token string) (*http.Response, error) {\n\treturn http.Get(GraphURL + \"/me?access_token=\" + token)\n}\n"
};

describe("Go: package-level versions reaching a URL in another file or package", () => {
  it("the same package (GraphURL + path) and another package through go.mod's module path (fmt.Sprintf)", async () => {
    const d = await mkdtemp(join(tmpdir(), "vitasta-govals-"));
    for (const [p, t] of Object.entries(FILES)) {
      await mkdir(dirname(join(d, p)), { recursive: true });
      await writeFile(join(d, p), t);
    }
    const us = (await scanRepo(d)).usages.filter((u: any) => u.apiVersion?.startsWith("url: "));
    expect(us.map((u: any) => `${u.file}:${u.line}:${u.apiVersion}`).sort()).toEqual(["gov/cmd/main.go:11:url: v19.0", "gov/internal/fb/client.go:6:url: v19.0"]);
  });
});
