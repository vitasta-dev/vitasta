# Adding a provider

Most providers need no code. There are two halves.

## 1. Scanner: recognise the calls (`src/providers/<id>.json`)

```json
{
  "id": "groq",
  "hosts": ["api.groq.com"],
  "packages": { "ts": ["groq-sdk"], "py": ["groq"] },
  "clientClasses": ["Groq", "AsyncGroq"],
  "modelPattern": "^[a-z0-9.-]+-(versatile|instant)$",
  "sdkOps": { "chat.completions.create": "POST /openai/v1/chat/completions" }
}
```

| Field | What it does |
|---|---|
| `hosts` | URLs on these hosts become HTTP usages. A client of another SDK pointed here (`baseURL`) is credited to this provider. |
| `packages` | Per language (`ts js py java go rb php cs`), for manifests and imports |
| `clientClasses` | Class names that build a client. Only counted when imported from one of `packages`. |
| `modelPattern` | Regex for this provider's model IDs. Loose strings still have to be in a model setting. Keep it tight. |
| `sdkOps` | SDK call path → `METHOD /path`. Longest prefix wins. |
| `opTemplate` | For APIs whose methods are URLs, e.g. Slack `"POST /api/{call}"` (Python `snake_case` handled) |
| `versionHeaders`, `versionKeys`, `urlVersion` | Where a pinned API version can appear |
| `keywords` | Extra words for the fast file filter |

Repos can add their own (internal APIs) the same way under `providers:` in `.vitasta.yml`.

## 2. Feed: know what's changing (`feed/src/sources-generic.ts`, private)

If the provider publishes either of these, it's one config entry:

- **A table** with a model column and a retirement or shutdown date → `modelTableSource`
- **An OpenAPI spec** with a removal date on operations → `specDeprecationSource` with the extension key

Anything else needs an extractor in `feed/src/sources-extra.ts`. Run the build and read
`data/_coverage.md` for rows that didn't map.

## 3. Test

Add a fixture under `test/fixtures/` and a case in `test/breadth.test.ts`, then run the tests:

```bash
npm test
```

To check a new provider for noise on real code, scan a few public repos that use it with `--map-only` and read
what it reports (see `bench/README.md`).
