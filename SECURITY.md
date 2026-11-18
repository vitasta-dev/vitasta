# Security

Vitasta reads other people's code. Our first rule is that it must never leak it.

## What Vitasta does with your code

| Part | Where it runs | What it reads | What leaves |
|---|---|---|---|
| CLI and GitHub Action | Your machine or your CI runner | Your repo, on disk | The model names, API operations (e.g. `POST /v1/messages`) and pinned API versions found, to look up dates on `app.vitasta.dev`. No code, file names or repo name. Nothing with `--feed <dir>`. Reports go to your terminal, files you name, or your own job summary |
| MCP server | Your machine, over stdio | The paths your agent asks about | The model names, API operations (e.g. `POST /v1/messages`) and pinned API versions found, to look up dates on `app.vitasta.dev`. No code, file names or repo name. Nothing with `--feed <dir>` |
| GitHub App | Vitasta's server | One commit of each installed repo | Findings posted back to **that same repo** (check run, tracking issue, fix PRs) |

The scanner never sends code to Vitasta, to a model provider, or to anyone else. It does not use an LLM.

**Date lookups.** Without a local feed, the CLI, Action and MCP server ask `https://app.vitasta.dev/v1/lookup`
which retirements apply. They send as little as possible and do the exact matching on your machine. For each
distinct thing found, they send only:

- the provider, for built-in providers only (custom providers in your `.vitasta.yml` are never sent);
- the kind of use (SDK call, HTTP call, model string, version pin);
- the model ID, only if it has the shape of a public model ID (a fine-tuned ID is reduced to its base model,
  a Bedrock ARN loses the account, and Azure deployment names aren't sent);
- the HTTP method and the API version prefix of the path, with every other path segment replaced by `{}`
  (`GET /repos/acme/app/issues` is sent as `GET /{}/{}/{}/{}`);
- a pinned API version, and the cloud host (Azure, Bedrock, Vertex).

They never send code, snippets, file names, line numbers, the repo name, SDK method names, parameter names or
your `.vitasta.yml`. The service answers with every record that could apply, and the scanner keeps only the ones
that really do. The service logs request counts only, never what was asked or who asked, and rate-limits by IP
address in memory. The scanner prints a one-line notice whenever it looks something up, and only sends to the
https address it names (redirects are refused).

## GitHub App: how a scan works

1. A webhook arrives. Its HMAC-SHA256 signature is checked against the app's secret, or it is dropped.
2. The app asks GitHub for a one-hour installation token, scoped to that installation's repos.
3. It fetches **one commit**, shallow, into a fresh private temp directory (mode 0700):
   - the token goes in an HTTP header passed through the environment, never in the URL, the command line,
     `.git/config` or logs
   - git runs with no hooks, no LFS or other filters, no submodules, no local or `ext::` protocols, no user
     or system git config, and symlinks checked out as plain files
   - repo names and commit ids are checked against a strict pattern before git runs
4. The scanner parses the files in memory. **Nothing in the repo is ever executed**: no installs, builds,
   scripts or tests. Source files over 1 MB, config and notebook files over 2 MB, and symlinks are skipped.
5. The temp directory is deleted when the job ends, whether it succeeded or failed. If the server stops
   mid-job, leftovers are deleted when it starts again. Temp space is on disk, capped, and never backed up.
6. Results are posted to the same repo. Nothing is stored: no database, no copy of code, no cache.

## What can appear in output

Findings name a file, a line, the model or endpoint, and a snippet of **one line**, cut to 200 characters.
Before any snippet is printed, posted or logged, Vitasta removes anything that looks like a secret:
OpenAI, Anthropic, Stripe, GitHub, Google, AWS, Slack, Shopify, Meta, Twilio, Hugging Face, Groq and xAI keys,
JWTs, private keys, `Bearer`/`Basic` headers, passwords in URLs, and quoted values assigned to names like
`password`, `secret` or `api_key`. Vitasta does not repeat a hard-coded key even into your own repo's issues.

Server logs hold event type, repo name, PR number and counts. They never hold code, snippets, tokens, or
git's error output.

## "Not an issue" and what we count

Each finding in the tracking issue has a "Not an issue" checkbox. Which boxes are ticked is stored in your own
issue, not on our server. When a box is ticked or unticked, the App adds one to a counter for that rule (for
example `openai/model-ref/ts`) and that feed record. Nothing else is kept: no repo name, file, code or user.
The CLI, the Action and the MCP server send nothing at all, dismissals included. The operator can turn the
counters off with `DISMISS_COUNTS=off`.

## Repo config is data, not code

`.vitasta.yml` is parsed as YAML with an alias limit and a 200 KB cap. Custom patterns are length-limited and
rejected if they could backtrack badly. Custom providers and change records from one repo apply only to that
repo's scan and are removed before the next job starts.

## Permissions the App asks for

`contents: write`, `pull_requests: write`, `checks: write`, `issues: write`, `metadata: read`. GitHub can't limit
`contents: write` to some branches; the limit is the App's own behaviour: it writes only `vitasta/*` fix branches,
never the default branch, and never a branch a person has committed to. There is no per-repository switch for fix
pull requests yet; to stop them, uninstall the App. (`FIX_PRS=off` is a setting on Vitasta's own server.)

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository. Don't open a public issue.
We aim to reply within 3 working days.
