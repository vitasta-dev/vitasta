import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findImpacts } from "../src/feed/match.js";
import { scanRepo } from "../src/scan/index.js";
import type { ChangeRecord } from "../src/types.js";

vi.setConfig({ testTimeout: 120_000 });

const FEED = [{ id: "ga-v23", provider: "googleads", type: "version_sunset", title: "Google Ads API v23 sunsets", selector: { versions: ["v23"] }, effective: "2027-02-01", trigger: "date", sources: [{ url: "https://developers.google.com/google-ads/api/docs/sunset-dates" }] }] as unknown as ChangeRecord[];

const F: Record<string, Record<string, string>> = {
php: {"src/Campaigns.php": `<?php\nnamespace App;\nuse Google\\Ads\\GoogleAds\\Lib\\V23\\GoogleAdsClientBuilder;\nuse Google\\Ads\\GoogleAds\\V23\\Services\\GoogleAdsRow;\nuse Google\\Ads\\GoogleAds\\V23\\Services\\SearchGoogleAdsRequest;\nuse Google\\Ads\\GoogleAds\\V22\\Common\\Foo;\nclass Campaigns {}\n`},
py: {"a.py": `from google.ads.googleads.client import GoogleAdsClient\nfrom google.ads.googleads.v23.services.types import SearchGoogleAdsRequest\nfrom google.ads.googleads.v23.enums import X\nclient = GoogleAdsClient.load_from_storage()\nsvc = client.get_service("GoogleAdsService", version="v22")\n`},
java: {"A.java": `import com.google.ads.googleads.v23.services.GoogleAdsServiceClient;\nimport com.google.ads.googleads.v23.services.*;\nclass A {}\n`},
cs: {"A.cs": `using Google.Ads.GoogleAds.V23.Services;\nusing Google.Ads.GoogleAds.V23.Common;\nclass A {}\n`},
rb: {"a.rb": `require 'google/ads/google_ads/v23/services/google_ads_service_pb'\nclient = Google::Ads::GoogleAds::V23::Services::GoogleAdsService::Client.new\n`},
};

const scan = async (files: Record<string, string>) => {
  const d = await mkdtemp(join(tmpdir(), "vitasta-gans-"));
  for (const [p, t] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true });
    await writeFile(join(d, p), t);
  }
  return scanRepo(d);
};
const pins = (m: Awaited<ReturnType<typeof scan>>, file?: string) => m.usages.filter((u) => u.provider === "googleads" && u.kind === "version-pin" && (!file || u.file === file));

describe("Google Ads: the API version in the SDK's import paths", () => {
  it("PHP: one finding per file and version at the first import, the rest as alsoLines (Lib\\V23 counts too)", async () => {
    const m = await scan({ ...F.php, "src/Other.php": F.php["src/Campaigns.php"].replace(/V22/g, "V23") });
    const a = pins(m, "src/Campaigns.php");
    expect(a.map((u) => `${u.apiVersion} ${u.line} ${(u.alsoLines ?? []).join(",")}`).sort()).toEqual(["setter: v22 6 ", "setter: v23 3 4,5"]);
    expect(pins(m, "src/Other.php").map((u) => u.apiVersion)).toEqual(["setter: v23"]);
  });
  it("Python: google.ads.googleads.v23 imports, and version=\"v22\" on get_service", async () => {
    const m = await scan(F.py);
    expect(pins(m, "a.py").map((u) => u.apiVersion).sort()).toEqual(["const: v22", "setter: v23"]);
  });
  it("Java, C# and Ruby", async () => {
    for (const lang of ["java", "cs", "rb"]) {
      const m = await scan(F[lang]);
      const u = pins(m);
      expect(u.map((x) => x.apiVersion), lang).toEqual(["setter: v23"]);
      expect(u[0].line, lang).toBe(1);
    }
  });
  it("the feed's version record matches each file once", async () => {
    const m = await scan({ ...F.php, ...F.java, ...F.cs });
    const f = findImpacts(m, FEED, "2026-11-25");
    expect(f.map((x) => x.usage.file).sort()).toEqual(["A.cs", "A.java", "src/Campaigns.php"]);
  });
  it("negatives: a comment, an unversioned Google Ads namespace, another vendor's V23, a one-digit version", async () => {
    const m = await scan({
      "a.php": "<?php\n// use Google\\Ads\\GoogleAds\\V23\\Services\\X;\nuse Google\\Ads\\GoogleAds\\Lib\\OAuth2TokenBuilder;\nclass A {}\n",
      "b.cs": "using Acme.Billing.V23.Services;\nclass B {}\n",
      "c.py": "# from google.ads.googleads.v23.services import x\nfrom google.ads.googleads.client import GoogleAdsClient\nimport google.ads.googleads.v9.services\n",
      "D.java": "import com.example.v23.services.X;\nclass D {}\n",
    });
    expect(pins(m)).toEqual([]);
  });
});
