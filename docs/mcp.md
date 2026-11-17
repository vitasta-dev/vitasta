# Vitasta for coding agents (MCP)

Vitasta ships an MCP server so Claude Code, Cursor, Codex, Windsurf and other agents can check code for
retiring AI models and APIs while they work, and pick a current model when they write new code.

It runs on your machine over stdio and reads the repo on disk. It never sends code anywhere. Dates come from a
local feed (`--feed <dir>`) or, without one, from the Vitasta lookup service, which receives only the model
names, API operations and versions found (see [SECURITY.md](../SECURITY.md)). Every tool is read-only.

## Tools

| Tool | Ask it | Returns |
|---|---|---|
| `check_repo` | "Does this repo call anything retiring?" | Each problem with file:line, the date, and the replacement |
| `api_usage` | "Which APIs and models does this repo use?" | SDKs and every call, model ID and pinned API version, per provider |
| `model_status` | "When does claude-3-5-sonnet retire on Bedrock?" | Dates per platform (provider API, Bedrock, Vertex, Azure) and the replacement |
| `upcoming_changes` | "What's retiring at OpenAI in the next 60 days?" | Announced retirements, shutdowns and version sunsets |

## Set up

Claude Code (once the package is on npm; the feed snapshot is bundled):

```bash
claude mcp add vitasta -- npx -y -p @vitasta/scanner vitasta-mcp
```

From a checkout, before then:

```bash
claude mcp add vitasta -- npx tsx /path/to/vitasta/scanner/src/mcp.ts --feed /path/to/vitasta/feed/data
```

Cursor and others (`mcp.json`):

```json
{
  "mcpServers": {
    "vitasta": {
      "command": "npx",
      "args": ["tsx", "/path/to/vitasta/scanner/src/mcp.ts", "--feed", "/path/to/vitasta/feed/data"]
    }
  }
}
```

The feed directory can also be set with `VITASTA_FEED`.

## Suggested agent rule

Add to `CLAUDE.md`, `AGENTS.md` or `.cursorrules`:

> Before adding or changing a call to an AI model or third-party API, call `model_status` for the model you
> plan to use. Before finishing a change that touches API code, run `check_repo` and fix anything new.
