/**
 * Find public repos that call the APIs we cover, for the corpus and the weekly real-world sample.
 *
 * Uses GitHub search (code search, falling back to repository search) through the `gh` CLI or a GITHUB_TOKEN.
 * Only public metadata is read; nothing is cloned here.
 */
import { execFileSync } from "node:child_process";

/** One query per provider/language pair, so every rule gets repos. */
export const QUERIES: { code: string; repo: string }[] = [
  { code: '"from openai import" language:Python', repo: "openai language:Python" },
  { code: '"from openai" language:TypeScript', repo: "openai language:TypeScript" },
  { code: '"require(\'openai\')" language:JavaScript', repo: "openai language:JavaScript" },
  { code: '"from anthropic import" language:Python', repo: "anthropic language:Python" },
  { code: '"@anthropic-ai/sdk" language:TypeScript', repo: "claude language:TypeScript" },
  { code: '"from google import genai" language:Python', repo: "gemini language:Python" },
  { code: '"@google/genai" language:TypeScript', repo: "gemini language:TypeScript" },
  { code: '"bedrock-runtime" boto3 language:Python', repo: "bedrock language:Python" },
  { code: '"@aws-sdk/client-bedrock-runtime" language:TypeScript', repo: "bedrock language:TypeScript" },
  { code: '"vertexai" "GenerativeModel" language:Python', repo: "vertex-ai language:Python" },
  { code: '"AzureOpenAI" language:Python', repo: "azure-openai language:Python" },
  { code: '"import com.openai" language:Java', repo: "openai language:Java" },
  { code: '"import com.anthropic" language:Java', repo: "anthropic language:Java" },
  { code: '"bedrockruntime" language:Java', repo: "bedrock language:Java" },
  { code: '"import stripe" language:Python', repo: "stripe language:Python" },
  { code: '"from \'stripe\'" language:TypeScript', repo: "stripe language:TypeScript" },
  { code: '"from twilio.rest import Client" language:Python', repo: "twilio language:Python" },
  { code: '"@octokit/rest" language:TypeScript', repo: "octokit language:TypeScript" },
  { code: '"@shopify/shopify-api" language:TypeScript', repo: "shopify-app language:TypeScript" },
  { code: '"graph.facebook.com" language:Python', repo: "facebook-graph-api language:Python" },
  { code: '"from mistralai" language:Python', repo: "mistral language:Python" },
  { code: '"from groq import" language:Python', repo: "groq language:Python" },
  { code: '"slack_sdk" language:Python', repo: "slack-bot language:Python" },
  { code: '"@notionhq/client" language:TypeScript', repo: "notion-api language:TypeScript" },
  { code: '"graph.microsoft.com/v1.0" language:TypeScript', repo: "microsoft-graph language:TypeScript" },
  { code: '"api.cloudflare.com/client/v4" language:TypeScript', repo: "cloudflare-api language:TypeScript" },
  { code: '"api.x.ai" language:Python', repo: "grok language:Python" },
  { code: '"api.deepseek.com" language:Python', repo: "deepseek language:Python" },
];

/** The providers' own SDK and sample orgs: their code is the API, not a user of it */
const PROVIDER_ORGS = /^(openai|anthropics|googleapis|google-gemini|google|GoogleCloudPlatform|aws|awslabs|boto|Azure|Azure-Samples|microsoft|microsoftgraph|stripe|stripe-samples|twilio|twilio-samples|octokit|Shopify|facebook|mistralai|groq|slackapi|makenotion|cloudflare|xai-org|deepseek-ai)$/i;

function gh(path: string, params: Record<string, string>): any {
  const args = ["api", "-X", "GET", path, ...Object.entries(params).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Found {
  repo: string;
  query: string;
}

/** Candidate repos per query (code search first; repository search if code search is refused). */
export async function discover(opts: { perQuery: number; page?: number; log?: (s: string) => void }): Promise<Found[]> {
  const out: Found[] = [];
  let codeSearch = true;
  for (const q of QUERIES) {
    let names: string[] = [];
    try {
      if (codeSearch) {
        const r = gh("search/code", { q: q.code, per_page: "100", page: String(opts.page ?? 1) });
        names = r.items.map((i: any) => i.repository.full_name);
        await sleep(6500); // code search allows 10 requests a minute
      }
    } catch (e) {
      opts.log?.(`code search refused (${(e as Error).message.split("\n")[0].slice(0, 80)}); using repository search`);
      codeSearch = false;
    }
    if (!codeSearch) {
      const r = gh("search/repositories", { q: `${q.repo} fork:false archived:false size:<51200`, sort: "updated", per_page: "100", page: String(opts.page ?? 1) });
      names = r.items.map((i: any) => i.full_name);
      await sleep(2500);
    }
    const unique = [...new Set(names)].filter((n) => !PROVIDER_ORGS.test(n.split("/")[0]));
    opts.log?.(`${q.code}: ${unique.length} repos`);
    for (const repo of unique.slice(0, opts.perQuery * 3)) out.push({ repo, query: q.code });
  }
  return out;
}

/** Public, not a fork, not archived, under 50 MB, pushed in the last two years. */
export function eligible(repo: string): boolean {
  try {
    const r = gh(`repos/${repo}`, {});
    const recent = Date.parse(r.pushed_at) > Date.now() - 2 * 365 * 86_400_000;
    return !r.private && !r.fork && !r.archived && r.size < 51_200 && recent;
  } catch {
    return false;
  }
}
