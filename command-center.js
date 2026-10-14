#!/usr/bin/env node
//
// Command Center -- a herdr pane listing the work you have in flight. For now
// that is your open pull requests, each marked the way herdr-space-topic marks
// a Space: 📝 approved, ✅ ❌ 🟡 for its checks, 🔀 for merge conflicts, 💬 for
// unresolved review threads, 🟣 once merged.
//
// herdr runs this in the terminal pane declared in herdr-plugin.toml. It draws
// the list, refreshes it on a timer, and exits when you quit the pane.
//
//   node command-center.js           run the pane (what herdr launches)
//   node command-center.js --open    open the pane, or focus it if it is open
//   node command-center.js --follow  move the open pane to the tab you are in
//   node command-center.js --once    print the list once and exit
//
// With COMMAND_CENTER_DEMO=1 it lists made-up PRs instead of yours, for
// screenshots that must not show private repositories.
//
// Requires: node >= 18 and the GitHub CLI (`gh`), logged in. No npm
// dependencies, no build step.

"use strict";

const { execFile, spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "phorsmalahti.command-center";
const ENTRYPOINT = "tasks";
const DEMO = process.env.COMMAND_CENTER_DEMO === "1";
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || ".";
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || ".";
const PANE_PATH = join(STATE_DIR, "command-center-pane.json");

const argv = process.argv.slice(2);

// ---------------------------------------------------------------------------
// Config
//
// The same small TOML subset as herdr-space-topic: flat `key = value` pairs,
// where a value is a quoted string, a bare number, a bool, or an array of
// strings -- which, unlike there, may run over several lines.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // The GitHub search that picks the PRs. Anything the search box takes
  // works: add `org:acme`, or swap `is:open` for `merged:>=2026-10-01`.
  // Newest-updated first, unless the query names its own `sort:`.
  query: "is:pr is:open author:@me archived:false",
  // Repositories ("owner/name") whose PRs are never listed.
  exclude_repos: [],
  // How often the list refreshes by itself. `r` refreshes on demand.
  refresh_seconds: 120,
  // Move the pane along when you switch Space or tab, so it is always in
  // view. false leaves it where it was opened.
  follow: true,
};

// Drop a trailing `# comment`, but not a `#` inside a quoted value.
function stripComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseToml(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (!key) continue;
    if (val.startsWith("[")) {
      // A list of repos reads best one per line: gather lines up to the `]`.
      while (!val.includes("]") && i + 1 < lines.length) val += ` ${stripComment(lines[++i]).trim()}`;
      out[key] = [...val.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    } else if (/^"(.*)"$|^'(.*)'$/.test(val)) {
      out[key] = val.slice(1, -1);
    } else if (val === "true" || val === "false") {
      out[key] = val === "true";
    } else if (/^-?\d+$/.test(val)) {
      out[key] = Number(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

// Read fresh on every refresh, so an edit shows up without reopening the pane.
function loadConfig() {
  let user = {};
  try {
    user = parseToml(readFileSync(join(CONFIG_DIR, "config.toml"), "utf8"));
  } catch {
    // No config file is the normal case; every key has a default.
  }
  const cfg = { ...DEFAULTS, ...user };
  if (typeof cfg.query !== "string" || !cfg.query.trim()) cfg.query = DEFAULTS.query;
  if (!Array.isArray(cfg.exclude_repos)) cfg.exclude_repos = [];
  cfg.refresh_seconds = Math.max(30, Number(cfg.refresh_seconds) || DEFAULTS.refresh_seconds);
  cfg.follow = cfg.follow !== false;
  return cfg;
}

// ---------------------------------------------------------------------------
// Pull requests
//
// One GraphQL search fetches every PR with its checks, review decision,
// mergeability and review threads, so a refresh is a single `gh` call however
// many PRs there are.
// ---------------------------------------------------------------------------

const SEARCH_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number title url state isDraft mergeable reviewDecision updatedAt
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          ... on CheckRun { status conclusion }
          ... on StatusContext { state }
        } } } } } }
        reviewThreads(first: 100) { nodes { isResolved } }
      }
    }
  }
}`;

// The marks below are herdr-space-topic's, so a PR reads the same in the
// sidebar and in this pane.
const CI_MARKS = { pass: "✅", fail: "❌", pending: "🟡" };
// Shown instead of the CI mark when the PR has merge conflicts: it cannot be
// merged whatever its checks say, so that is the thing to know.
const CONFLICT_MARK = "🔀";
// From GitHub's reviewDecision. Only approval has one.
const REVIEW_MARKS = { APPROVED: "📝" };
// The PR has review threads nobody has resolved.
const COMMENTS_MARK = "💬";
// A merged PR's only mark: its checks, conflicts and reviews no longer matter.
const MERGED_MARK = "🟣";

function prMarks(pr) {
  if (pr.state === "MERGED") return { review: "", ci: MERGED_MARK, comments: "" };
  return {
    review: REVIEW_MARKS[pr.review] || "",
    ci: pr.mergeable === "CONFLICTING" ? CONFLICT_MARK : CI_MARKS[pr.ci] || "",
    comments: pr.comments > 0 ? COMMENTS_MARK : "",
  };
}

// Conclusions and commit-status states that mean a check did not pass.
const CI_FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

// Roll a PR's checks up into one verdict, as GitHub's own badge does: any
// failure fails (a red cross will not turn green by waiting), anything still
// running is pending, otherwise it passes. "" when the PR has no checks.
function ciState(checks) {
  if (!Array.isArray(checks) || !checks.length) return "";
  let pending = false;
  for (const c of checks) {
    // A CheckRun (Actions) has status + conclusion; a legacy commit
    // StatusContext has only state.
    const verdict = c.conclusion || c.state || "";
    if (CI_FAILED.has(verdict)) return "fail";
    if ((c.status && c.status !== "COMPLETED") || verdict === "PENDING" || verdict === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "pass";
}

function toPr(node) {
  const checks = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
  const threads = node.reviewThreads?.nodes || [];
  return {
    number: node.number,
    title: oneLine(node.title),
    url: node.url,
    repo: oneLine(node.repository?.nameWithOwner),
    draft: !!node.isDraft,
    updatedAt: Date.parse(node.updatedAt) || 0,
    state: node.state,
    ci: ciState(checks),
    // MERGEABLE, CONFLICTING, or UNKNOWN while GitHub works it out.
    mergeable: node.mergeable || "UNKNOWN",
    // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or "" with no rules.
    review: node.reviewDecision || "",
    // Only the first 100 threads are counted.
    comments: threads.filter((t) => !t.isResolved).length,
  };
}

function gh(args) {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      {
        timeout: 30000,
        maxBuffer: 16 << 20,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

// The first useful line of whatever went wrong, short enough for a header.
function ghError(r) {
  if (r.error?.code === "ENOENT") return "gh not found: install the GitHub CLI";
  if (r.error?.killed) return "gh timed out";
  const line = `${r.stderr || ""}`.split(/\r?\n/).find((l) => l.trim());
  return oneLine(line || r.error?.message || "gh failed");
}

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

// The search actually sent. Excluded repos become `-repo:` qualifiers rather
// than a filter on the results, so their PRs do not use up the 50 the search
// returns; GitHub ignores a `-repo:` naming a repo that does not exist. An
// entry that is not a plain owner/name is dropped, so it cannot rewrite the
// rest of the query.
function searchQuery(cfg) {
  const parts = [cfg.query];
  for (const repo of cfg.exclude_repos) if (REPO_NAME.test(repo.trim())) parts.push(`-repo:${repo.trim()}`);
  if (!/\bsort:/.test(cfg.query)) parts.push("sort:updated-desc");
  return parts.join(" ");
}

// Made-up PRs in made-up repositories, covering every mark, a draft, and ages
// from minutes to weeks. Newest first, as the search returns them.
function demoPrs() {
  const pr = (repo, number, title, minutes, extra) => ({
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    repo,
    draft: false,
    updatedAt: Date.now() - minutes * 60000,
    state: "OPEN",
    ci: "pass",
    mergeable: "MERGEABLE",
    review: "",
    comments: 0,
    ...extra,
  });
  return [
    pr("acme/api-server", 482, "feat(auth): rotate session tokens when a role changes", 6, { comments: 2 }),
    pr("acme/api-server", 479, "fix(billing): round invoice totals per line item", 25, { ci: "fail" }),
    pr("acme/web-app", 1290, "feat(dashboard): add a weekly usage chart", 48, { review: "APPROVED", comments: 1 }),
    pr("acme/api-server", 476, "chore(deps): bump the Go toolchain to 1.25", 52, { ci: "pending" }),
    pr("acme/infra", 88, "ci: run the integration tests on arm64 runners", 130, { ci: "pending" }),
    pr("acme/api-server", 471, "perf(search): cache query plans across requests", 190, { review: "APPROVED" }),
    pr("acme/web-app", 1284, "fix(forms): keep focus on the first invalid field", 310, { ci: "fail", comments: 3 }),
    pr("acme/api-server", 463, "refactor(storage): put the blob store behind an interface", 2900, { mergeable: "CONFLICTING", comments: 4 }),
    pr("acme/infra", 85, "feat(terraform): add a read replica to staging", 5800),
    pr("acme/api-server", 455, "feat(export): stream large exports instead of buffering", 8700, { draft: true }),
    pr("acme/handbook", 31, "docs: explain how the on-call rotation works", 13000, { ci: "" }),
    pr("acme/web-app", 1271, "feat(settings): let teams pick a default region", 26000, { draft: true, mergeable: "CONFLICTING" }),
  ];
}

async function fetchPrs(cfg) {
  if (DEMO) return demoPrs();
  const r = await gh(["api", "graphql", "-f", `query=${SEARCH_QUERY}`, "-f", `q=${searchQuery(cfg)}`]);
  let body;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    throw new Error(ghError(r));
  }
  if (body.errors?.length) throw new Error(oneLine(body.errors[0].message));
  if (r.error) throw new Error(ghError(r));
  return (body.data?.search?.nodes || []).filter((n) => n?.number).map(toPr);
}

// PRs grouped by repository, in the order the search returned them: the repo
// with the most recently updated PR comes first.
function groupByRepo(prs) {
  const groups = new Map();
  for (const pr of prs) {
    if (!groups.has(pr.repo)) groups.set(pr.repo, []);
    groups.get(pr.repo).push(pr);
  }
  return [...groups].map(([repo, items]) => ({ repo, prs: items }));
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// A PR title is someone else's text: no control character from it may reach
// the terminal.
function oneLine(value) {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Terminal cells a character takes. Emoji and East Asian wide characters take
// two -- every PR mark is one -- and combining marks, joiners and variation
// selectors take none. Close enough to wcwidth for PR titles.
const WIDE =
  /[\p{Emoji_Presentation}ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;
const ZERO = /[\p{Mn}\p{Me}\p{Cf}]/u;

function charWidth(ch) {
  return ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
}

function width(str) {
  let w = 0;
  for (const ch of str) w += charWidth(ch);
  return w;
}

// Cut `str` to at most `max` cells, ending in … when anything was cut.
function fit(str, max) {
  if (max <= 0) return "";
  if (width(str) <= max) return str;
  let out = "";
  let w = 0;
  for (const ch of str) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out.trimEnd()}…`;
}

function pad(str, cells) {
  return str + " ".repeat(Math.max(0, cells - width(str)));
}

// Styles close themselves with their own off code rather than a full reset,
// so a dim title inside the selected (reversed) row stays reversed.
const COLOR = !!process.stdout.isTTY;
const style = (on, off) => (s) => (COLOR && s ? `\x1b[${on}m${s}\x1b[${off}m` : s);
const bold = style(1, 22);
const dim = style(2, 22);
const red = style(31, 39);
const yellow = style(33, 39);
const inverse = style(7, 27);

function age(ms) {
  const m = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
}

function clock(ms) {
  const t = new Date(ms);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Layout
//
// The list is lines of three kinds: a repository heading, a PR, and the blank
// line between repositories. Only PR lines can be selected.
// ---------------------------------------------------------------------------

const AGE_WIDTH = 4; // "11mo"
const MIN_WIDTH_FOR_AGE = 50;

function buildLines(groups) {
  const lines = [];
  let index = 0;
  for (const g of groups) {
    if (lines.length) lines.push({ kind: "gap" });
    lines.push({ kind: "repo", repo: g.repo, count: g.prs.length });
    for (const pr of g.prs) lines.push({ kind: "pr", pr, index: index++ });
  }
  return lines;
}

// Shared across rows so every column lines up: the mark columns any PR uses
// (a column nobody uses is left out), and the width of the widest #number.
function columns(prs, w) {
  const marks = prs.map(prMarks);
  return {
    slots: ["review", "ci", "comments"].filter((k) => marks.some((m) => m[k])),
    numWidth: Math.max(0, ...prs.map((pr) => width(`#${pr.number}`))),
    age: w >= MIN_WIDTH_FOR_AGE,
  };
}

function repoLine(line, w) {
  const slash = line.repo.lastIndexOf("/");
  const owner = line.repo.slice(0, slash + 1);
  const name = line.repo.slice(slash + 1);
  const count = ` ${line.count}`;
  if (1 + width(line.repo) + width(count) > w) return ` ${bold(fit(line.repo, w - 1))}`;
  return ` ${dim(owner)}${bold(name)}${dim(count)}`;
}

//   📝 ✅ 💬 #1290 feat(dashboard): add a weekly usage chart     1h
function prLine(pr, cols, w, selected) {
  const m = prMarks(pr);
  const marks = cols.slots.map((k) => pad(m[k], 2)).join(" ");
  const lead = `  ${marks}${marks ? " " : ""}`;
  const num = pad(`#${pr.number}`, cols.numWidth);
  const when = cols.age ? ` ${age(pr.updatedAt).padStart(AGE_WIDTH)}` : "";
  const room = w - width(lead) - width(num) - 1 - width(when);
  const title = fit(pr.title, room);
  const gap = " ".repeat(Math.max(0, room - width(title)));
  const text = pr.draft ? dim(`${num} ${title}`) : `${num} ${title}`;
  const row = `${lead}${text}${gap}${dim(when)}`;
  return selected ? inverse(row) : row;
}

function bodyLines(lines, cols, w, selected) {
  return lines.map((line) => {
    if (line.kind === "gap") return "";
    if (line.kind === "repo") return repoLine(line, w);
    return prLine(line.pr, cols, w, line.index === selected);
  });
}

// ---------------------------------------------------------------------------
// --once: print the list and exit
// ---------------------------------------------------------------------------

async function printOnce(cfg) {
  let prs;
  try {
    prs = await fetchPrs(cfg);
  } catch (err) {
    process.stderr.write(`command-center: ${err.message}\n`);
    return 1;
  }
  const w = (process.stdout.columns || Number(process.env.COLUMNS) || 100) - 1;
  const lines = buildLines(groupByRepo(prs));
  for (const line of bodyLines(lines, columns(prs, w), w, -1)) process.stdout.write(`${line.trimEnd()}\n`);
  if (!prs.length) process.stdout.write(`No pull requests match: ${cfg.query}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

const ui = {
  cfg: DEFAULTS,
  prs: [],
  groups: [],
  lines: [],
  selected: 0,
  selectedUrl: "",
  scroll: 0,
  loaded: false,
  loading: false,
  error: "",
  fetchedAt: 0,
  flash: "",
  flashTimer: null,
  refreshTimer: null,
};

// The PRs in the order they are drawn, which is the order selection walks.
function ordered() {
  return ui.groups.flatMap((g) => g.prs);
}

function select(index) {
  const prs = ordered();
  if (!prs.length) return;
  ui.selected = Math.max(0, Math.min(prs.length - 1, index));
  ui.selectedUrl = prs[ui.selected].url;
}

function flash(message) {
  ui.flash = message;
  clearTimeout(ui.flashTimer);
  ui.flashTimer = setTimeout(() => {
    ui.flash = "";
    draw();
  }, 3000);
  draw();
}

async function refresh() {
  if (ui.loading) return;
  clearTimeout(ui.refreshTimer);
  ui.cfg = loadConfig();
  ui.loading = true;
  draw();
  try {
    ui.prs = await fetchPrs(ui.cfg);
    ui.error = "";
    ui.loaded = true;
    ui.fetchedAt = Date.now();
  } catch (err) {
    // Keep showing the last list: a network blip should not empty the pane.
    ui.error = err.message;
  }
  ui.loading = false;
  ui.groups = groupByRepo(ui.prs);
  ui.lines = buildLines(ui.groups);
  // Stay on the same PR across a refresh, wherever it moved to.
  const at = ordered().findIndex((pr) => pr.url === ui.selectedUrl);
  select(at >= 0 ? at : ui.selected);
  draw();
  ui.refreshTimer = setTimeout(refresh, ui.cfg.refresh_seconds * 1000);
}

function header(w) {
  const title = "Pull requests";
  const count = ui.loaded ? ` ${ui.prs.length}` : "";
  const left = ` ${title}${count}`;
  let status = "";
  let paint = dim;
  if (ui.loading) {
    status = "refreshing…";
    paint = yellow;
  } else if (ui.error) {
    status = `⚠ ${ui.error}`;
    paint = red;
  } else if (ui.fetchedAt) {
    status = `updated ${clock(ui.fetchedAt)}`;
  }
  status = fit(status, w - width(left) - 2);
  const gap = " ".repeat(Math.max(1, w - width(left) - width(status)));
  return ` ${bold(title)}${dim(count)}${gap}${paint(status)}`;
}

// Keep the selected PR on screen, and its repository heading with it when it
// is the first PR of its group.
function scrollTo(selLine, height) {
  const prev = ui.lines[selLine - 1];
  const top = prev?.kind === "repo" ? selLine - 1 : selLine;
  if (top < ui.scroll) ui.scroll = top;
  if (selLine >= ui.scroll + height) ui.scroll = selLine - height + 1;
  ui.scroll = Math.max(0, Math.min(ui.scroll, ui.lines.length - height));
}

function body(w, height) {
  if (!ui.lines.length) {
    if (!ui.loaded && !ui.error) return [`  ${dim("Loading pull requests…")}`];
    if (!ui.loaded) return [`  ${red(fit(ui.error, w - 2))}`, `  ${dim("r to retry")}`];
    return [`  No pull requests match`, `  ${dim(fit(ui.cfg.query, w - 2))}`];
  }
  const selLine = ui.lines.findIndex((l) => l.kind === "pr" && l.index === ui.selected);
  scrollTo(selLine, height);
  const visible = ui.lines.slice(ui.scroll, ui.scroll + height);
  return bodyLines(visible, columns(ui.prs, w), w, ui.selected);
}

const HINT = "↑↓ move  ⏎ open  r refresh  q quit";
// The screen row (1-based, as mouse reports count) of the first list line:
// below the header and the blank line under it.
const BODY_ROW = 3;

function draw() {
  if (!process.stdout.isTTY) return;
  // One cell short of the edge: a line that fills the last column would wrap
  // in a terminal whose idea of an emoji's width differs from ours.
  const w = Math.max(10, (process.stdout.columns || 80) - 1);
  const rows = Math.max(4, process.stdout.rows || 24);
  const height = rows - 3;
  const lines = [header(w), "", ...body(w, height)]; // the list starts on BODY_ROW
  while (lines.length < rows - 1) lines.push("");
  lines.length = rows - 1;
  lines.push(` ${dim(fit(ui.flash || HINT, w - 1))}`);
  process.stdout.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\r\n")}\x1b[J`);
}

function openSelected() {
  const pr = ordered()[ui.selected];
  if (!pr) return;
  if (DEMO) return flash(`Demo data: #${pr.number} is made up`);
  flash(`Opening #${pr.number} in your browser…`);
  // gh knows how to reach the browser on every platform, and honours
  // GH_BROWSER and BROWSER.
  gh(["pr", "view", pr.url, "--web"]).then((r) => {
    if (r.error) flash(`Could not open #${pr.number}: ${ghError(r)}`);
  });
}

// Escape sequences for the keys we handle. A mouse report becomes an object;
// anything else starting with ESC is skipped whole, and a lone ESC is the
// Escape key.
const SEQUENCES = [
  ["\x1b[A", "up"],
  ["\x1bOA", "up"],
  ["\x1b[B", "down"],
  ["\x1bOB", "down"],
  ["\x1b[5~", "pageup"],
  ["\x1b[6~", "pagedown"],
  ["\x1b[H", "home"],
  ["\x1bOH", "home"],
  ["\x1b[1~", "home"],
  ["\x1b[F", "end"],
  ["\x1bOF", "end"],
  ["\x1b[4~", "end"],
];

function* keys(data) {
  let i = 0;
  while (i < data.length) {
    const hit = SEQUENCES.find(([seq]) => data.startsWith(seq, i));
    if (hit) {
      yield hit[1];
      i += hit[0].length;
      continue;
    }
    // SGR mouse report: ESC [ < button ; column ; row, then M (press) or m
    // (release).
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i));
    if (mouse) {
      yield { button: Number(mouse[1]), row: Number(mouse[3]), press: mouse[4] === "M" };
      i += mouse[0].length;
      continue;
    }
    if (data[i] === "\x1b") {
      const unknown = /^\x1b(?:\[[0-9;?<=>]*[ -/]*[@-~]|O.)/.exec(data.slice(i));
      yield unknown ? "" : "esc";
      i += unknown ? unknown[0].length : 1;
      continue;
    }
    yield data[i];
    i += 1;
  }
}

// Mouse reports carry no click count, so a double-click is two presses on the
// same PR this close together.
const DOUBLE_CLICK_MS = 400;
let lastClick = { index: -1, at: 0 };

// A left click on a PR selects it, and a double-click opens it; the wheel
// moves the selection, since the list scrolls to follow it. Clicks elsewhere,
// other buttons, releases and drags do nothing.
function onMouse({ button, row, press }) {
  if (!press || button & 32) return; // 32: motion
  if (button & 64) return select(ui.selected + ((button & 3) === 0 ? -1 : 1)); // 64: wheel
  if ((button & 3) !== 0 || row < BODY_ROW) return; // 0: left button
  const line = ui.lines[ui.scroll + row - BODY_ROW];
  if (line?.kind !== "pr") return;
  select(line.index);
  const now = Date.now();
  const double = lastClick.index === line.index && now - lastClick.at < DOUBLE_CLICK_MS;
  // A third click starts over rather than opening the PR a second time.
  lastClick = double ? { index: -1, at: 0 } : { index: line.index, at: now };
  if (double) openSelected();
}

function onKey(key, quit) {
  if (typeof key === "object") return onMouse(key);
  const page = Math.max(1, (process.stdout.rows || 24) - 4);
  switch (key) {
    case "q":
    case "esc":
    case "\x03": // Ctrl-C
      return quit({ closePane: true });
    case "up":
    case "k":
      return select(ui.selected - 1);
    case "down":
    case "j":
      return select(ui.selected + 1);
    case "pageup":
      return select(ui.selected - page);
    case "pagedown":
      return select(ui.selected + page);
    case "home":
    case "g":
      return select(0);
    case "end":
    case "G":
      return select(Infinity);
    case "\r":
    case "o":
      return openSelected();
    case "r":
      return refresh();
  }
}

function runPane() {
  const { stdin, stdout } = process;
  let done = false;
  const quit = ({ closePane = false } = {}) => {
    if (done) return;
    done = true;
    const pane = closePane ? ownPaneId() : "";
    forgetPane();
    stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
    if (stdin.isTTY) stdin.setRawMode(false);
    // herdr keeps a pane whose command has exited, with a shell in it. Quitting
    // the list should take its pane away too. Not on a signal: that is herdr
    // closing the pane already.
    if (pane) herdr(["plugin", "pane", "close", pane]);
    process.exit(0);
  };

  rememberPane();
  // Alternate screen, cursor hidden: the shell's scrollback comes back intact
  // when the pane quits. Mouse clicks and wheel reported in SGR form, which
  // herdr passes on to a pane that asks for them.
  stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", (data) => {
    for (const key of keys(data)) onKey(key, quit);
    if (!done) draw();
  });
  stdout.on("resize", draw);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => quit());
  // Ages and the "updated" clock go stale between refreshes.
  setInterval(draw, 30000).unref();

  refresh();
}

// ---------------------------------------------------------------------------
// herdr
// ---------------------------------------------------------------------------

function herdr(args, stdio = ["ignore", "pipe", "ignore"]) {
  return spawnSync(HERDR, args, { encoding: "utf8", stdio });
}

function herdrJson(args) {
  const r = herdr(args);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout).result;
  } catch {
    return null;
  }
}

// The terminal this pane process draws in. A pane gets a new id every time it
// moves to another tab, so HERDR_PANE_ID is only the id it opened with; the
// terminal stays the same, and finds the pane wherever it went.
let ownTerminal = "";

// Where the open pane is, so `--open` can focus it and `--follow` can move it.
// The pid tells a live pane from one whose process was killed. A demo pane is
// left out, so it is never the one focused or moved.
function rememberPane() {
  if (!process.env.HERDR_PANE_ID) return;
  ownTerminal = herdrJson(["pane", "get", process.env.HERDR_PANE_ID])?.pane?.terminal_id || "";
  if (!ownTerminal || DEMO) return;
  try {
    writeFileSync(PANE_PATH, JSON.stringify({ terminal: ownTerminal, pid: process.pid }));
  } catch {
    // Without it `--open` just opens a second pane, and nothing follows you.
  }
}

// The pane this process is in now, or "" when it cannot tell. Only the
// opening id when the terminal was never known: an id from before a move could
// by now name somebody else's pane.
function ownPaneId() {
  if (!ownTerminal) return process.env.HERDR_PANE_ID || "";
  const panes = herdrJson(["pane", "list"])?.panes || [];
  return panes.find((p) => p.terminal_id === ownTerminal)?.pane_id || "";
}

function forgetPane() {
  try {
    if (JSON.parse(readFileSync(PANE_PATH, "utf8")).pid === process.pid) rmSync(PANE_PATH);
  } catch {
    // Nothing remembered, or another pane's.
  }
}

// The open Command Center pane (or null) and the pane you are focused on, in
// one walk of the session: exactly one pane in it is focused.
function livePanes() {
  const panes = herdrJson(["pane", "list"])?.panes || [];
  let mine = null;
  try {
    const { terminal, pid } = JSON.parse(readFileSync(PANE_PATH, "utf8"));
    process.kill(pid, 0); // throws when that pane's process is gone
    mine = panes.find((p) => p.terminal_id === terminal) || null;
  } catch {
    // No pane open.
  }
  return { mine, focused: panes.find((p) => p.focused) || null };
}

// The pane at the right edge of a tab (the top one, when several reach it):
// the list goes there, so it reads as a column beside your work rather than
// wedged between two panes of it.
function rightEdgePane(paneId) {
  const panes = herdrJson(["pane", "layout", "--pane", paneId])?.layout?.panes || [];
  const right = (p) => p.rect.x + p.rect.width;
  return panes.reduce((best, p) => (!best || right(p) > right(best) || (right(p) === right(best) && p.rect.y < best.rect.y) ? p : best), null);
}

function paneWidth(paneId) {
  const panes = herdrJson(["pane", "layout", "--pane", paneId])?.layout?.panes || [];
  return panes.find((p) => p.pane_id === paneId)?.rect.width || 0;
}

// ---------------------------------------------------------------------------
// --follow: what the focus event hooks run
//
// A herdr pane lives in one tab of one Space; there is no pane that shows in
// all of them. So the pane follows you instead: on every Space or tab switch
// it moves to the right edge of the tab you switched to, at the width it had.
// Its process keeps running through the move, list and all.
// ---------------------------------------------------------------------------

const LOCK_PATH = join(STATE_DIR, "command-center.lock");
// The share of the target pane kept by your work when the list's own width is
// unknown: the list gets the remaining 38%.
const DEFAULT_RATIO = 0.62;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Switching Space fires workspace.focused and tab.focused together, and two
// moves at once would fight. Runs take turns, and each one reads where you
// are when its turn comes, so the last leaves the pane where you ended up. A
// lock left by a killed run is cleared by its pid.
function withLock(fn) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      break;
    } catch {
      try {
        process.kill(Number(readFileSync(LOCK_PATH, "utf8")) || process.pid, 0);
      } catch {
        rmSync(LOCK_PATH, { force: true });
        continue;
      }
      if (Date.now() > deadline) return 0;
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(LOCK_PATH, { force: true });
  }
}

function followFocus() {
  if (!loadConfig().follow) return 0;
  return withLock(() => {
    const { mine, focused } = livePanes();
    if (!mine || !focused || focused.tab_id === mine.tab_id) return 0;
    const target = rightEdgePane(focused.pane_id) || { pane_id: focused.pane_id, rect: { width: 0 } };
    const width = paneWidth(mine.pane_id);
    const ratio = width && target.rect.width ? Math.max(0.25, Math.min(0.8, 1 - width / target.rect.width)) : DEFAULT_RATIO;
    const args = ["pane", "move", mine.pane_id, "--tab", focused.tab_id, "--target-pane", target.pane_id];
    args.push("--split", "right", "--ratio", ratio.toFixed(2), "--no-focus");
    return herdr(args, ["ignore", "ignore", "inherit"]).status ?? 1;
  });
}

// ---------------------------------------------------------------------------
// --open: what the `open` action runs
// ---------------------------------------------------------------------------

function openPane() {
  const { mine } = livePanes();
  if (mine && herdr(["plugin", "pane", "focus", mine.pane_id]).status === 0) return 0;
  // A split opens beside an existing pane: the one the action ran from, or
  // failing that the focused one, or rather whichever pane of their tab is at
  // its right edge. herdr refuses a split that also names a workspace, so the
  // workspace is only for when there is no pane to split.
  let context = {};
  try {
    context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    // No context: fall back to the env ids, if any.
  }
  const from = process.env.HERDR_PANE_ID || context.focused_pane_id;
  const target = from && (rightEdgePane(from)?.pane_id || from);
  const workspace = process.env.HERDR_WORKSPACE_ID || context.workspace_id;
  const args = ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", ENTRYPOINT, "--focus"];
  if (target) args.push("--target-pane", target, "--direction", "right");
  else if (workspace) args.push("--workspace", workspace);
  const r = herdr(args, ["ignore", "ignore", "inherit"]);
  if (r.error) {
    process.stderr.write(`command-center: cannot run ${HERDR}: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}

async function main() {
  if (argv.includes("--open")) process.exit(openPane());
  if (argv.includes("--follow")) process.exit(followFocus());
  if (argv.includes("--once") || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.exit(await printOnce(loadConfig()));
  }
  runPane();
}

main();
