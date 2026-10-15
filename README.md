# herdr-command-center

> herdr plugin: a pane listing the work you have in flight. For now, your open
> pull requests, marked the way
> [herdr-space-topic](https://github.com/panuhorsmalahti/herdr-space-topic)
> marks a Space.

![Command Center pane listing pull requests from four repositories, each marked with its checks, review state, conflicts and open threads](docs/screenshot.png?v=e3b3202)

<sub>Demo mode: the repositories and PRs are made up.</sub>

herdr plugins cannot draw into herdr's own UI, but they can own a terminal
pane, so this one draws its list there. It opens as a normal split pane that
you can move, resize or zoom like any other, and it follows you from Space to
Space.

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

The `open` action puts the list at the right edge of the tab you are in. If
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
| click a PR | select it, and switch to [its Space](#jump-to-a-prs-space), if one is working on it |
| double-click a PR | open it in your browser |
| mouse wheel | move |
| `PgUp` `PgDn`, `g` `G` | page, top, bottom |
| `⏎` / `o` | open the PR in your browser (through `gh`, so `GH_BROWSER` applies) |
| `r` | refresh now |
| `q` / `Esc` | close the pane (herdr would otherwise leave a shell in it) |

## It follows you

A herdr pane belongs to one tab of one Space; herdr has no pane that shows in
all of them. So when you switch Space or tab, the plugin moves the pane to the
right edge of the tab you switched to, at the width it had. Resize it once and
it keeps that width everywhere. The list keeps running through the move, so
nothing reloads.

Set `follow = false` to leave the pane where you opened it.

Following needs a herdr **server** of 0.9.1 or newer. A 0.9.0 server only
fires focus events for switches made through its API, not for the ones you
make yourself (fixed in 0.9.1, #4077). After a client-only update the old
server keeps running: `herdr status` shows `server_binary_stale: yes`. Restart
it onto the new binary with `herdr update --handoff`.

## Jump to a PR's Space

Click a PR and you switch to the Space working on it: a Space with a pane
whose checkout has the PR's branch, in a clone of its repository. With
[herdr-space-topic](https://github.com/panuhorsmalahti/herdr-space-topic),
that's the Space named after the PR. When no Space is working on it, the click
just selects the PR, and so does a click on the PR of the Space you're in.

A branch counts under its own name and under the one it was pushed as, so a
worktree's `worktree/fix-login` pushed as `fix/login` finds that PR. A Claude
Code session that moved into a worktree is found there, from its transcript,
rather than in the directory herdr saw it start in. When several Spaces have
the branch, one where an agent has it wins.

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

Draft PRs are dimmed, or left out with `show_drafts = false`. The column on the right is how long ago each PR was last
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
| `show_drafts` | `true` | list draft PRs (dimmed); `false` leaves them out |
| `refresh_seconds` | `120` | how often the list refreshes by itself (at least 30) |
| `follow` | `true` | move the pane to the tab you switch to; `false` leaves it put |

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
- **Pane bookkeeping.** The pane records its terminal and process id in
  `HERDR_PLUGIN_STATE_DIR`, so `open` and the focus hooks can find it again.
  The terminal, because a pane gets a new id each time it moves to another tab
  but keeps its terminal. The record is removed when the pane closes.
- **Following** runs on herdr's `workspace.focused` and `tab.focused` events.
  Both fire on a Space switch, so runs take turns through a lock file, and each
  one reads where you are when its turn comes. Moving the pane changes no
  focus, so it cannot trigger itself.
- **Resizing.** herdr resizes a pane it moves or opens, but not the pane that
  pane split, so the program there would keep drawing at its old width, over
  the list, until you focused it. After each move or open the plugin nudges the
  new split out and back, which makes herdr resize both sides.
- **Demo mode.** With `COMMAND_CENTER_DEMO=1` the pane lists made-up PRs in
  made-up repositories, for screenshots that must not show your own:

  ```bash
  herdr plugin pane open --plugin phorsmalahti.command-center --entrypoint tasks \
    --placement tab --env COMMAND_CENTER_DEMO=1
  ```

- **Verified** against herdr 0.9.0 on macOS.

## License

MIT
