# Changelog

## 0.1.3 (18 Nov 2026)

- **Where a model runs:** a model the code places on a platform gets that platform's dates. Read from an entry's
  provider field, the key, call or branch it sits in (`azure:`, `VertexAIProvider(...)`, `elif api_type == "azure":`),
  the file's path, or the only platform endpoint the file talks to. GitHub Models, Copilot, the ChatGPT app, VS Code's
  model API and SAP AI Core aren't the provider's API, so its API dates don't apply there. Data:
  `src/data/model-platforms.json`.
- **Fewer false alarms:** model names used to test a name (prefix, substring and membership checks, also across files),
  capability and compatibility tables, display labels, tokenizer names, schema and OpenAPI examples, retirement
  knowledge bases, vendored copies under docs/, lint-rule fixtures, demo data files, bundled `.min.js`/`_bundle.js`.
- **More real uses found:** defaults of model-named flags and options (`getArg('--model', …)`, argparse/click
  `default=`, `z.string().default(…)`, `Field(default=…)`), `llm_name`/`deployment_name` settings, a model object's `id`,
  model-info registries keyed by ID and constructor rows (`ModelInfo(id=…)`), model→provider maps, a model config picked
  by ID, embedders.
- **Compatibility data for model moves:** a reader for what a replacement model rejects or does differently (request
  settings, response changes, and the first SDK version per release line that handles it), used by fix pull requests.
  The SDK version a place in the repo runs with is read from its lockfile (npm, Bun, pnpm, Yarn, Poetry, uv, PDM,
  Pipenv) or its manifest's range. Only files are read; nothing is installed.
- Groq's `deepseek-r1-distill-llama-70b`-style IDs are recognised.
- **Fix:** a name holding a short word inside another word (`ClaudeModel` holds "demo") is no longer taken for a
  non-setting.
- **Fix:** the MCP server reports the package's version (it said 0.0.1).

## 0.1.2 (17 Nov 2026)

- **Large repos:** no more out-of-memory crash on repos with thousands of matching files (syntax trees are freed file
  by file; peak memory on an 8,000-file repo went from 2.3 GB to 0.43 GB).
- **API versions in any URL:** a URL on a versioned API's host pins that version wherever it's written: base-URL
  constants, settings fields, wrapped fetch calls, helpers, and Shopify's `/admin/api/YYYY-MM/` even when the store host
  is a variable.
- **Models in more places:** model enums, per-provider maps, alias maps, model lists and preset rows, registry entries
  (code, YAML and JSON) and models passed to model-shaped calls. These count when the repo shows it uses that provider
  (an SDK or HTTP call, an SDK or framework dependency or import, a model CLI or container, or its API key env var).
- **Less noise:** recorded API responses, data files (results, logs, recordings), display-name maps, alias and snapshot
  lists, membership checks, pricing and cost code, placeholders and commented-out config lines don't count. A path
  segment built at runtime no longer matches a specific removed endpoint.
- **Tests listed apart:** findings in tests, examples, fixtures, mocks, samples and seed data are listed at the end of
  the report, and a PR's summary no longer counts ones it didn't touch.
- Groq IDs with a context-length suffix (`llama3-70b-8192`) are recognised.

## 0.1.1 (17 Nov 2026)

- New providers: Together AI, OpenRouter (including through the OpenAI SDK), Google Ads API, and the Meta Marketing
  API, which has its own (shorter) version schedule: the Business SDKs and `/vNN.0/act_…` calls get Marketing dates,
  other Graph calls keep Graph dates.
- Provider-prefixed model IDs as frameworks write them (`anthropic/claude-…`, `bedrock/…`, `vertex_ai/…`), skipped in
  files that use a router whose own IDs look the same.
- Model IDs that are the default of a `model` flag or option (Go `StringVar`, `flag.String`, `.option("--model")`).
- OpenAI prompt objects: `prompt: { id: "pmpt_…" }` in Responses calls, and quoted `pmpt_` IDs kept in constants.
- Fewer false alarms: a model ID used as a lookup-table key (colours, sizes, prices) isn't a use, and models that are
  only offered (lists, pickers, registries, type unions) are reported as "listed" and never fail a PR check.
- Lookup privacy: org/model IDs are sent only for well-known public orgs; a company's own names never are.

## 0.1.0 (16 Nov 2026)

First release: CLI, GitHub Action and MCP server.
