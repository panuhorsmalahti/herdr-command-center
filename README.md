# herdr-command-center

> herdr plugin: a pane listing the work you have in flight. For now, your open
> pull requests, marked the way
> [herdr-space-topic](https://github.com/panuhorsmalahti/herdr-space-topic)
> marks a Space.

```text
 Pull requests 12                                       updated 13:49

 acme/api-server 6
     ✅ 💬 #482  feat(auth): rotate session tokens when a role ch…   6m
     ❌    #479  fix(billing): round invoice totals per line item   25m
     🟡    #476  chore(deps): bump the Go toolchain to 1.25         52m
  📝 ✅    #471  perf(search): cache query plans across requests     3h
     🔀 💬 #463  refactor(storage): put the blob store behind an…    2d

 acme/web-app 3
  📝 ✅ 💬 #1290 feat(dashboard): add a weekly usage chart          48m
     ❌ 💬 #1284 fix(forms): keep focus on the first invalid field   5h

 ↑↓ move  ⏎ open  r refresh  q quit
```

<sub>Illustration with made-up repositories and PRs.</sub>

herdr plugins cannot draw into herdr's own UI, but they can own a terminal
pane, so this one draws its list there. It opens as a normal split pane that
you can move, resize or zoom like any other.

## Install

```bash
herdr plugin install panuhorsmalahti/herdr-command-center
```

Requires herdr >= 0.9.0, `node` >= 18 on your `PATH`, and the GitHub CLI,
[`gh`](https://cli.github.com), logged in. No npm dependencies, no build step.

## Open it

```bash
herdr plugin action invoke phorsmalahti.command-center.open
```

The `open` action splits the focused pane and puts the list on the right. If
the pane is already open, it focuses that one rather than opening another. Bind
it to a key in your herdr `config.toml`:

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "phorsmalahti.command-center.open"
description = "command center"
```

In the pane:

| key | does |
| --- | --- |
| `↑` `↓` / `k` `j` | move |
| `PgUp` `PgDn`, `g` `G` | page, top, bottom |
| `⏎` / `o` | open the PR in your browser (through `gh`, so `GH_BROWSER` applies) |
| `r` | refresh now |
| `q` / `Esc` | close the pane |

## The marks

The same as herdr-space-topic's, so a PR reads the same in the sidebar and
here. Each kind of mark has its own column, so they line up down the list. A
column no PR uses is left out.

| mark | means |
| --- | --- |
| 📝 | approved |
| ✅ | every check passed |
| ❌ | a check failed, even while others still run |
| 🟡 | checks still running |
| 🔀 | merge conflicts, shown instead of the CI mark |
| 💬 | review threads nobody has resolved |
| 🟣 | merged (only with a `query` that includes merged PRs) |

Draft PRs are dimmed. The column on the right is how long ago each PR was last
updated.

PRs are grouped by repository. The repository with the most recently updated
PR comes first, and each group runs newest first.

## Configuration

Optional. Every key has a default; see
[`examples/default-config.toml`](examples/default-config.toml).

```bash
cp examples/default-config.toml "$(herdr plugin config-dir phorsmalahti.command-center)/config.toml"
```

| key | default | what it does |
| --- | --- | --- |
| `query` | `"is:pr is:open author:@me archived:false"` | the GitHub search that picks the PRs |
| `exclude_repos` | `[]` | repositories (`"owner/name"`) whose PRs are never listed |
| `refresh_seconds` | `120` | how often the list refreshes by itself (at least 30) |

`query` takes anything GitHub's search box does:

```toml
query = "is:pr is:open author:@me org:acme"             # one organisation
query = "is:pr is:open review-requested:@me"            # waiting on your review
query = "is:pr author:@me merged:>=2026-10-01"          # recently merged, 🟣
```

To hide a few repositories without rewriting the query, list them in
`exclude_repos`:

```toml
exclude_repos = [
  "acme/website",
  "acme/marketing-site",
]
```

They are added to the search as `-repo:` qualifiers, so excluded PRs don't use
up any of the 50 slots. A name that matches no repository is ignored.

The config is re-read on every refresh, so an edit shows up without reopening
the pane.

## Notes

- **One call per refresh.** A single GraphQL search through `gh api graphql`
  fetches every PR together with its checks, review decision, mergeability and
  review threads. The first 50 PRs are shown, and up to 100 checks and 100
  review threads are counted per PR.
- **Offline or logged out**, the pane keeps the last list it had and shows the
  error in its header.
- **Pane bookkeeping.** The pane records its id and process id in
  `HERDR_PLUGIN_STATE_DIR`, so `open` can find it again. The record is removed
  when the pane closes.
- **Demo mode.** With `COMMAND_CENTER_DEMO=1` the pane lists made-up PRs in
  made-up repositories, for screenshots that must not show your own:

  ```bash
  herdr plugin pane open --plugin phorsmalahti.command-center --entrypoint tasks \
    --placement tab --env COMMAND_CENTER_DEMO=1
  ```

- **Verified** against herdr 0.9.0 on macOS.

## License

MIT
