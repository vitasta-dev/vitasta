# Vitasta as a GitHub Action

The action runs the scanner inside your own CI, so your code never leaves GitHub's runners. To find which
retirements apply it sends only the model names, API operations and versions it found to the Vitasta lookup
service, unless you give it a local feed with `feed:`.

```yaml
# .github/workflows/vitasta.yml
name: Vitasta
on: pull_request

permissions:
  contents: read

jobs:
  api-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # needed to diff against the base branch
      - uses: vitasta-dev/vitasta@v0.1.4   # a release tag: it carries the built scanner
```

What it does on each pull request:

- **Fails** if the PR adds or changes a line that calls a model or API that is already retired or due within 30 days. Test and fixture files never fail the check.
- **Annotates** each such line in the PR's "Files changed" view.
- **Writes a job summary** listing what the PR touches, plus known issues elsewhere in the repo (these don't fail the check).

**Dates:** looked up on `app.vitasta.dev` (model names, API operations and versions only, never code). To stay
offline, point `feed:` at a feed directory in the workspace.
