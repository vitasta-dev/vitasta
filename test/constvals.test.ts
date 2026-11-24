import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan/index.js";

const FILES: Record<string, string> = {
  "jv/src/main/java/com/acme/app/PageService.java": "package com.acme.app;\n\nimport com.acme.fb.ApiVersion;\nimport org.springframework.web.client.RestTemplate;\n\npublic class PageService {\n    private final RestTemplate rest = new RestTemplate();\n    public String pages(String token) {\n        String url = \"https://graph.facebook.com/\" + ApiVersion.DEFAULT.getValue() + \"/me/accounts?access_token=\" + token;\n        return rest.getForObject(url, String.class);\n    }\n}\n",
  "jv/src/main/java/com/acme/fb/ApiVersion.java": "package com.acme.fb;\n\npublic enum ApiVersion {\n    V18(\"v18.0\"),\n    V21(\"v21.0\");\n\n    public static final ApiVersion DEFAULT = V21;\n    private final String value;\n    ApiVersion(String value) { this.value = value; }\n    public String getValue() { return value; }\n}\n",
  "jv/src/main/java/com/acme/fb/GraphClient.java": "package com.acme.fb;\n\nimport java.net.http.HttpClient;\nimport java.net.http.HttpRequest;\nimport java.net.URI;\n\npublic class GraphClient {\n    private final HttpClient http = HttpClient.newHttpClient();\n    public String me(String token) throws Exception {\n        HttpRequest req = HttpRequest.newBuilder(URI.create(GraphConstants.GRAPH_URL + \"/me?access_token=\" + token)).build();\n        return http.send(req, java.net.http.HttpResponse.BodyHandlers.ofString()).body();\n    }\n}\n",
  "jv/src/main/java/com/acme/fb/GraphConstants.java": "package com.acme.fb;\n\npublic final class GraphConstants {\n    public static final String API_VERSION = \"v19.0\";\n    public static final String GRAPH_URL = \"https://graph.facebook.com/\" + API_VERSION;\n    private GraphConstants() {}\n}\n",
  "csv/Graph/DefaultVersion.cs": "namespace Acme.Graph\n{\n    public static class DefaultVersion\n    {\n        public const string Value = \"v20.0\";\n        public static readonly string BaseUrl = \"https://graph.facebook.com/\" + Value;\n    }\n}\n",
  "csv/Services/PageService.cs": "using System.Net.Http;\nusing Acme.Graph;\n\nnamespace Acme.Graph.Services\n{\n    public class PageService\n    {\n        private readonly HttpClient _http = new HttpClient();\n        public Task<string> Pages(string token) => _http.GetStringAsync($\"https://graph.facebook.com/{DefaultVersion.Value}/me/accounts?access_token={token}\");\n        public Task<string> Me(string token) => _http.GetStringAsync(DefaultVersion.BaseUrl + \"/me?access_token=\" + token);\n    }\n}\n"
};

describe("Java and C#: versions in constants, enums and defaults reaching a URL in another file", () => {
  it("a constants class, an enum's DEFAULT, a C# const and its base URL, in files that import or share the package", async () => {
    const d = await mkdtemp(join(tmpdir(), "vitasta-constvals-"));
    for (const [p, t] of Object.entries(FILES)) {
      await mkdir(dirname(join(d, p)), { recursive: true });
      await writeFile(join(d, p), t);
    }
    const us = (await scanRepo(d)).usages.filter((u: any) => u.apiVersion);
    const at = (f: string) => us.filter((u: any) => u.file === f).map((u: any) => `${u.line}:${u.apiVersion}`);
    expect(at("jv/src/main/java/com/acme/fb/GraphClient.java")).toEqual(["10:url: v19.0"]);
    expect(at("jv/src/main/java/com/acme/app/PageService.java")).toEqual(["9:url: v21.0"]);
    expect(at("csv/Services/PageService.cs")).toEqual(["9:url: v20.0"]);
    expect(us.find((u: any) => u.file === "csv/Services/PageService.cs")?.alsoLines).toEqual([10]);
  });
});
