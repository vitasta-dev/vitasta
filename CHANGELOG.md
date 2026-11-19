# Changelog

## 0.1.5 (19 Nov 2026)

**Where a model is used decides what happens with it.** Every place now has a role:
- **Live code, defaults, config:** the only places that fail a check.
- **Examples and docs, including README code blocks and code samples in strings and docstrings:** shown and
  annotated, never failing.
- **Tests:** split into tests that set or check the model (a fix updates them) and tests that only store, show or look
  it up.
- **Model lists, catalogs, price tables, model-to-model maps:** never renamed.
- **Recorded data (telemetry, recorded responses, saved runs):** information only.

Nothing is silently dropped any more: price tables, recorded responses and lists the code only checks names
against are reported in their roles.
- **Reports** group places by role. A pull request's check annotates what it touches in live code and in examples.
- **More model places found:**
  - environment-variable defaults (`os.getenv("X", "gpt-4o")`, `process.env.X ?? "…"`);
  - gateway prefixes (`mastra/openai/gpt-5-mini`);
  - commander `.option(flags, description, default)`;
  - form fields named "Model";
  - framework model classes (`Claude(id=…)`, `OpenAIChat(id=…)`);
  - destructured parameter defaults;
  - provider/model routes in provider- or LLM-named constants;
  - code blocks in Markdown and code samples in template strings and Python docstrings.
- **Partner vendors' model IDs on Azure and Bedrock** are recognised by vendor family, from
  `src/data/partner-models.json`. Examples: Llama, Phi, MAI, DeepSeek, Cohere, Mistral, Kimi and FLUX on Azure;
  `<vendor>.<model>` IDs, with region prefixes, on Bedrock. Partner IDs count only where the code runs the model on
  that platform.
- **Fewer false alarms:** a router named only in a comment no longer turns provider routes into router IDs. Token and
  size helpers' default models aren't uses.
- **Security:**
  - A repository's own `.vitasta.yml` patterns can't stall a scan: bounded repeats up to 32, a shared time budget
    per scan, and V8's linear-time regex fallback.
  - Scans of large or unusual files stay linear. Each scan has a cap on source size, and each manifest a 1 MB cap.
  - No symlink is followed.
- **Lookups and MCP:**
  - The date lookup sends only IDs made of public model words, never deployment names, codenames or anything
    secret-looking.
  - The MCP server scans only inside the client's roots, `--root` or `VITASTA_MCP_ROOTS`, never `/` or the home
    folder.
  - MCP answers quote repository text as JSON strings.
- **Output and redaction:**
  - Report and annotation text drops control and bidirectional characters.
  - About fifteen more secret formats are redacted in snippets.
  - A repository's provider can't reuse a built-in provider's name.
- Dev dependency: vitest 4.1.12 (npm audit clean).

## 0.1.4 (18 Nov 2026)

- **What a date means:** records can say what happens on the date: it stops working, it can stop any day from then
  ("not sooner than"), calls silently move to another model, or the API becomes read-only. Reports, checks and the
  MCP server word each one accordingly ("can be retired", "will silently change to …", "becomes read-only").
- **Models whose versions retire on different dates** (Azure): with no version in the code, a model is "partly
  retired" until its last version's date, with each version's date, instead of "retired" from the first one.
- **Replacements that are themselves retiring:** "Move to" follows the provider's named replacement through the feed
  to the first model that isn't retired or retiring soon on the same platform, and says why
  ("gpt-5.6-terra (the provider names o4-mini, retired since 2026-10-23)").
- **One clock:** dates are judged in UTC everywhere, and a model on its retirement day reads "retires today".
- **Every finding says when it was last checked** against the provider's page.
- **PR checks use the base branch's policy:** `vitasta check` (and the Action) read `.vitasta.yml` from the base
  branch, so a pull request can't loosen its own check. Without one on the base, the default policy applies.
- **GitHub Action:** runs the built scanner with production dependencies only (no build tools in your CI), and
  `actions/setup-node` is pinned by commit. Use a release tag: `uses: vitasta-dev/vitasta@v0.1.4`.
- **Lookup answers are checked field by field** (lengths, characters, dates; links only on providers' docs sites),
  and MCP answers say they are data, not instructions.
- **MCP `model_status` sends only public model IDs** (a fine-tune by its base model; deployment names never) and
  prints the same lookup notice as the CLI.
- **More model settings found:** a property descriptor's default for a model setting, including resource locators
  (`{ name: "model", default: { mode: "list", value: "…" } }`).
- Dependencies: `yaml` 2.9.1 and `zod` 4.6.7 (security fixes).

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
