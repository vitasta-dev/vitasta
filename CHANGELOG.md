# Changelog

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
