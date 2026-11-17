# Vitasta Scanner

Finds where your code calls third-party AI APIs, then tells you what breaks, and when, as providers and clouds retire models, endpoints and parameters.

> Early release, Nov 2026. Deepest for TypeScript/JavaScript, Python and Java; Go, Ruby, PHP and C# are read at the string level.
> AI models: OpenAI, Anthropic, Google Gemini (through their own APIs, Amazon Bedrock, Google Vertex AI and Azure), Mistral, Cohere, Groq, xAI, DeepSeek, Perplexity, Together AI and OpenRouter.
> Versioned APIs: Stripe, Shopify, Meta Graph and Marketing APIs, Google Ads, GitHub, Microsoft Graph, Cloudflare and more.

## What it finds

- **SDK calls.** It follows the client from the import or declaration to the call: `new Client()`, `this.client`, clients imported from other files, factory functions, `require()`, typed parameters, and Java builder chains (`client.messages().create(params)`).
- **Model IDs and parameters** on each call. They're resolved from constants, env-var defaults and Java SDK enum constants (`Model.CLAUDE_SONNET_4_5`, `ChatModel.GPT_4_1` → `gpt-4.1`); the enum table is built from 287 SDK releases.
- **Raw HTTP calls.** It covers `fetch`, `axios` (and `axios.create` instances), `requests`, `httpx` (and `base_url` clients) and Java `HttpClient`. URLs are rebuilt from constants and template strings.
- **Cloud-hosted models, each checked against that host's own schedule:**
  - Bedrock: IDs (`us.anthropic.claude-…-v1:0`), ARNs, boto3 `converse`/`invoke_model`, AWS SDK v3 commands, `modelId` setters
  - Vertex AI: `claude-…@version`, `AnthropicVertex`, Gemini with `vertexai=True`
  - Azure: `AzureOpenAI`
- **Pinned API versions**, e.g. `anthropic-version` headers.
- **Model IDs outside code** (config files, YAML, `.env`, notebooks), reported at "possible" confidence.
- **Model settings in any form:** framework IDs with a provider prefix (`anthropic/claude-…`, `bedrock/…`), flag and option defaults (`--model`), and IDs of a provider's own objects (OpenAI prompt objects, `pmpt_…`).
- **Listed vs used.** A model that's only offered (a model list, enum, picker, registry, alias map or type union) is reported as "listed": it never fails a PR check and comes after the places that call a model. Models found only through such a shape count when the repo shows it really uses that provider.
- **API versions in URLs** wherever they're written: base-URL constants, settings, wrappers and helpers.

It uses tree-sitter, not regex, so strings, comments and look-alike names don't count. Repeated hits in one file are grouped. Findings in tests, examples, fixtures and sample data are listed apart at the end; they never fail a PR check.

## Usage

```bash
npx @vitasta/scanner scan .                      # scan this folder; dates come from the lookup service
npx @vitasta/scanner scan . --feed <dir>         # or a local copy of the feed (nothing is sent)
npx @vitasta/scanner check . --base origin/main  # judge only the lines changed since a branch, like a PR check
```

The lookup service receives only public model IDs, masked API operations and versions: never code, file names or
the repo name. See [SECURITY.md](SECURITY.md). MCP server: `npx -p @vitasta/scanner vitasta-mcp` ([docs/mcp.md](docs/mcp.md)).

From source:

```bash
npm install
npx tsx src/cli.ts scan <path | https://github.com/owner/repo>                 # dates from the lookup service
npx tsx src/cli.ts scan <path> --feed <dir>                                    # or a local copy of the feed
npx tsx src/cli.ts scan <path> --map-only        # just the API map as JSON
npx tsx src/cli.ts scan <path> --json out.json --md report.md
npx tsx scripts/build-java-models.ts             # refresh the Java SDK model-constant table
```

Cloned repos are cached in `~/.cache/vitasta/repos` and only read, never run. Without `--feed`, dates come from
`app.vitasta.dev`, which receives only the model names, API operations and versions found; see
[SECURITY.md](SECURITY.md).

## Licence

[Functional Source License 1.1 (ALv2 future licence)](LICENSE.md). You may use, modify and redistribute it for any purpose except offering a competing product or service. Each release becomes Apache-2.0 two years after it's published. See [TRADEMARKS.md](TRADEMARKS.md) for use of the Vitasta name.
