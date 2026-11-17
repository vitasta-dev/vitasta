# Changelog

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
