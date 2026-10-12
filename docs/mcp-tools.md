# rs-graph MCP tools

`rs-graph serve <path>` starts an MCP server over stdio against `<path>/.rs-graph/graph.db`
(built by `rs-graph index <path>` first). No network listener, no auth — the only client is
whatever process spawns it.

## Registering with Claude Code

`rs-graph index <path>` registers itself automatically: it adds an `"rs-graph"` entry to
`<path>/.mcp.json`, creating the file if it doesn't exist yet, or merging into it (leaving any
other entries/fields alone) if it does. Re-indexing is idempotent — an existing entry under that
name is never overwritten, so a manual customization always wins. No separate setup step needed;
just run `rs-graph index .` and restart/reopen the Claude Code session for the new server to be
picked up.

The generated entry assumes `rs-graph` is resolvable on `PATH` (a global install or a linked
bin):

```json
{
  "mcpServers": {
    "rs-graph": {
      "command": "rs-graph",
      "args": ["serve", "."]
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `graph_stats` | Repo-wide counts by kind/language. Cheap first call to orient in a codebase. |
| `graph_search_symbol` | Full-text search over symbol name/signature/doc (SQLite FTS5 syntax). |
| `graph_get_file_outline` | A file's declared symbols (name, kind, line range) — use instead of Read for "what's in this file". Returns `{ symbols, truncated }`, capped at `limit` (default 200) — a generated file can declare thousands of symbols. |
| `graph_get_definition` | Resolve a symbol by id, or by file+line. |
| `graph_get_references` / `graph_get_callers` / `graph_get_callees` | Call-graph traversal, one hop at a time. `references`/`callers` are polymorphism-aware — a concrete method's callers include calls made through an interface/base type it implements or overrides, since that's how real DI code actually calls it. |
| `graph_get_class_hierarchy` | Ancestors/descendants of a class or interface, with hop depth. |
| `graph_get_dependencies` | A file's imports, in both directions. |
| `graph_impact_analysis` | Transitive dependents of a symbol — "what would changing this break". Capped at 100 results by default (`maxResults`, up to 500) with a `truncated` flag — on a widely-used symbol, prefer a smaller `depth` or a more specific symbol over raising the cap. |
| `graph_get_route_map` | HTTP/router routes mapped to their handler symbol. Returns `{ routes, truncated }`, capped at `limit` (default 200). |
| `graph_get_di_graph` | DI registrations mapped to the interface/implementation they register. Returns `{ registrations, truncated }`, capped at `limit` (default 200). |
| `graph_get_component_tree` | Angular/Aurelia components mapped to the members their templates bind to — pass `componentId` for just one component instead of listing them all. Returns `{ components, truncated }`, capped at `limit` (default 15, max 50 components) **and** `maxBoundSymbols` (default 15, max 50 per component) — see the note below, this one has two independent caps for a reason. |
| `graph_context_pack` | Minimal deduplicated subgraph around one or more seed symbols — an alternative to reading N related files. |

Every tool returns compact, unindented JSON in a single text content block.

### Response detail: compact by default

`graph_search_symbol`, `graph_get_file_outline`, `graph_get_references`/`graph_get_callers`/
`graph_get_callees`, `graph_get_class_hierarchy`, `graph_impact_analysis`, `graph_get_route_map`,
`graph_get_di_graph`, `graph_get_component_tree`, and `graph_context_pack` can all return many
symbols per call, and `signature`/`docSummary` are by far the largest fields on a symbol — a full
method signature or doc comment repeated across dozens or hundreds of results dominates the
response size. By default these tools return a lean shape instead:

```json
{ "id": "...", "name": "...", "kind": "...", "filePath": "...", "startLine": 1, "endLine": 4 }
```

— enough to decide what to look at next (pass `id` to another tool, or the location to
`graph_get_definition`/Read). Pass `detail: "full"` on any of these calls to get the complete
symbol back inline (`signature`, `docSummary`, `modifiers`, `external`, columns) instead of making
a follow-up call — worth it up front when you already expect to need full detail for every result
(e.g. comparing several overloads by signature). `graph_get_definition` is unaffected by this — a
single-result tool, it always returns full detail, since that's the entire reason to call it
instead of Read.

`graph_get_references`/`graph_get_callers`/`graph_get_callees` also return one entry per *caller*,
not per call site — a caller that references the target from 5 different lines is one hit with an
`occurrences: [{line, col}, ...]` array of length 5, not 5 duplicate hits each repeating that
caller's full symbol. `limit`/`offset` paginate over unique callers, not call sites.

**Pagination isn't optional on `graph_get_file_outline`/`graph_get_route_map`/`graph_get_di_graph`/
`graph_get_component_tree` — it exists because one of them actually broke, twice.** Against a real
Angular app, `graph_get_component_tree` returned a **5,091,624-character** single response before
any cap existed. After adding a `limit` (default 100, matching the generic `pageArgs` convention
used elsewhere), the *same tool against the same app* still produced **1,750,937 characters** at
`limit: 500` — well within that cap's own stated max, since the generic max(500) used everywhere
else in this API turned out to be unsafe specifically for this one. `graph_get_file_outline` hit
the same shape of problem on a single generated file (an NSwag API client) with enough declared
symbols to produce 55,000+ characters even in compact mode.

The lesson from the second failure specifically: component *count* was never the only unbounded
axis — a single template-heavy component (a big form, in practice) can bind to far more members
than a typical one, so capping only the list length doesn't bound a single row's own size.
`graph_get_component_tree` now has two independent caps (`limit` for component count, default 15
max 50; `maxBoundSymbols` per component, default 15 max 50), each with its own `truncated`/
`boundSymbolsTruncated` flag, plus a `componentId` param to fetch exactly one component directly —
usually what you actually want, and it skips both caps' tradeoffs entirely since there's no list
to page through. `graph_get_file_outline`/`graph_get_route_map`/`graph_get_di_graph` are simpler
shapes (one axis each) and keep a single `limit`/`offset` (default 200) with `truncated`, the same
convention `graph_impact_analysis`/`graph_context_pack` always had.

**`id` itself can still be the dominant cost for C# overloads.** Roslyn's ids for a method embed
every parameter's fully-qualified type for overload disambiguation — a real one can run past 300
characters, e.g. `csharp:global::Foo.Bar.Baz(global::Some.Fully.Qualified.Type, int?, long)`. That
doesn't disappear just because `signature`/`docSummary` are gone from compact mode, and it's the
whole point of a compact result if there are dozens of hits. To avoid needing it at all until you
actually want to act on a specific hit: `graph_get_references`/`graph_get_callers`/
`graph_get_callees`/`graph_get_class_hierarchy`/`graph_impact_analysis` accept `filePath`+`line` as
an alternative to `symbolId` (the same resolution `graph_get_definition` already does) — both are
already sitting right there in every compact result, so you can traverse from a specific hit
without a round trip through `graph_get_definition` just to obtain its id first.

**`line` has to fall inside an actual declaration's span — line 1 almost never does.** Resolution
finds whatever symbol's span contains the exact line given; a real source file typically starts
with imports/usings and a namespace declaration before the first class/method begins, so guessing
`line: 1` when you only have a file path (not a specific line in mind) reliably misses. Use a
`startLine` from `graph_get_file_outline` instead of guessing — the error message says this too.

**`graph_search_symbol` matches signature/doc text too, not just names, by default** — pass
`scope: "name"` when you know the identifier you're after. The default (`scope: "any"`) exists
because real usage relies on it (e.g. finding a symbol by a word in its doc comment), but it also
means a query like `Foo` matches any symbol whose signature merely takes a `Foo` parameter or
returns one — a different, much broader question than "what's named Foo", and one that inflates
result count (more hits, each still paying the per-result cost above) without necessarily being
more useful.

### Suggested CLAUDE.md snippet: prefer the graph over grep

Even with these tools registered, an agent's default instinct is still Grep/Read — and once it
reaches for Grep for one question, it tends to just keep using Grep for everything afterward
rather than switching back. Paste this into the indexed repo's `CLAUDE.md` to counter both: make
the graph the default for structural questions, without banning Grep outright for the cases where
it's genuinely the right tool.

```markdown
## rs-graph: prefer the graph over grep

This repo is indexed by rs-graph. For any question about code *structure* — not just "does this
string appear somewhere" — reach for these tools before Grep or Read:

| Question | Tool |
| --- | --- |
| Where is X declared / what's its signature | `graph_get_definition`, `graph_search_symbol` (pass `scope: "name"` when you know the exact identifier — fewer, more precise hits than the default) |
| What's in this file | `graph_get_file_outline` (cheaper than a full Read) |
| Who calls/references X | `graph_get_references` / `graph_get_callers` |
| What does X call | `graph_get_callees` |
| What would changing/deleting X break | `graph_impact_analysis` |
| What implements/extends X | `graph_get_class_hierarchy` |
| What does this file import, or what imports it | `graph_get_dependencies` |
| HTTP routes / DI registrations / Angular-Aurelia components | `graph_get_route_map` / `graph_get_di_graph` / `graph_get_component_tree` |

These give exact answers from real declarations and call edges — polymorphism-aware, so a
method's callers include calls made through an interface or base type it implements — not text
matches, which can be wrong in both directions: a grep hit that isn't a real reference (a
comment, a similarly-named symbol elsewhere), or a real reference grep misses entirely (a call
through an interface, a different alias/casing).

**Using Grep once for one question is not a reason to keep using it for the next one.** Treat
each new question independently and default back to the table above — don't stay on Grep for the
rest of a session just because it answered the last question. That said, Grep/Read are still the
right call when:
- the matching graph tool comes back empty or errors for something you're confident exists —
  treat that as a likely stale index (suggest re-running `rs-graph index --fresh`) rather than
  proof there are no references, but don't let chasing it block you from just grepping instead;
- the question isn't structural — a literal string or config value, a TODO/log message, prose in
  a comment or doc, anything the graph doesn't model;
- you already know exactly which file/line you need, and a raw read is simply faster than a graph
  round-trip for that one lookup.
```

## Cross-repo workspace tools

A single repo's graph has no visibility into other repos — an SDK client call, a Service Bus
message, or a SignalR event's producer/consumer often live in a different repo (sometimes a
different language) with no shared compile-time reference. `rs-graph index-workspace
<workspace.json>` indexes every repo listed in that config (each still gets its own
`.rs-graph/graph.db`, same as `rs-graph index`), and `rs-graph serve-workspace <workspace.json>`
serves a *separate* MCP server exposing tools that join across all of them:

```json
{
  "repos": [
    { "name": "api", "path": "../api" },
    { "name": "worker", "path": "../worker", "sln": "Worker.sln" }
  ]
}
```

`sln`/`tsconfig` are optional per-repo overrides, same meaning as `rs-graph index`'s `--sln`/
`--tsconfig` flags. Each `path` is resolved relative to `workspace.json`'s own folder, not to
wherever you happen to run the command from — get one wrong (e.g. an extra `../`) and it can
resolve to a path that was never a real repo at all. `index-workspace`/`watch-workspace` check
that a repo's path already exists as a directory before doing anything else, and skip it
(reported as failed, not silently touched) rather than let `openGraphDb`'s own `mkdir -p`
fabricate a brand-new, empty directory just to hold a nearly-empty `.rs-graph/graph.db` — that's
exactly how a wrong path leaves stray debris behind in some unrelated project instead of failing
loudly.

`index-workspace` registers both servers automatically, in each successfully-indexed repo's own
`.mcp.json` — the single-repo `"rs-graph"` entry (same as plain `rs-graph index`) and a
`"rs-graph-workspace"` entry pointing back at this `workspace.json` (path resolved relative to
that repo's own folder, so it stays correct regardless of where the workspace root lives):

```json
{
  "mcpServers": {
    "rs-graph": { "command": "rs-graph", "args": ["serve", "."] },
    "rs-graph-workspace": { "command": "rs-graph", "args": ["serve-workspace", "../workspace.json"] }
  }
}
```

Same merge/idempotency rules as the single-repo case — an existing entry under either name is
left untouched, so nothing is overwritten by re-running `index-workspace`. A repo that's skipped
or fails to index (see the pass/skip/fail summary) doesn't get its `.mcp.json` touched at all.

`index-workspace` also registers entries at `workspace.json`'s own folder, regardless of per-repo
outcomes — so a Claude Code session opened at the workspace root itself (common for a task that
touches more than one repo at once) gets full tool coverage too, without a manual step:

- `"rs-graph-workspace"` — the cross-repo tools, same as above.
- One `"rs-graph-<repo-name>"` per successfully-indexed repo (e.g. `"rs-graph-api"`,
  `"rs-graph-worker"`) — that repo's own single-repo tools. The workspace root has no single
  "current repo" for a plain `"rs-graph"` entry to mean, so each repo gets its own uniquely-named
  entry instead; without these, a session at the root would have no structural tools for either
  repo at all (not just no cross-repo ones) and would fall back to Grep/Read for everything.

  With more than one single-repo server registered side by side, the same tool name (e.g.
  `graph_get_definition`) exists once per server — pick the one for the repo you actually mean,
  the same way you'd pick between two same-named npm scripts in different package.json files.

| Tool | Purpose |
| --- | --- |
| `graph_workspace_route_consumers` | Given a Route symbol id from this repo's own `graph_get_route_map`, finds every other repo calling it — a generated SDK client (NSwag `[RouteUrl]`), a raw C# `HttpClient` call, or an Angular `HttpClient` call. |
| `graph_workspace_message_consumers` | Given a MessageContract symbol id from this repo's own graph, finds every other repo (any language) that publishes/consumes the same Service Bus message type. |
| `graph_workspace_signal_consumers` | Same, for a HubEvent symbol id — SignalR broadcasts and client `.on`/`.subscribe`/`.invoke` dispatch names. |
| `graph_workspace_status` | Lists configured repos that were skipped (not yet indexed) — check this first if a workspace tool returns fewer results than expected. |

All three lookup tools return `{ key, owners, references }`: `owners` are the repo(s) with a real
symbol backing that route/message/event (for a Route, normally just the one that declares it);
`references` are every other repo's edge pointing at it, tagged with which repo and edge type
(`INVOKES_ROUTE`/`PUBLISHES`/`CONSUMES`).

**Routes match by path shape, not by parameter name.** `api/v1/vessel/{id}` and
`api/v1/vessel/{vesselId}` normalize to the same key — a hand-written `HttpClient`/Angular
`HttpClient` call's local variable name (`vesselId`) has no reason to match the route's own
declared parameter name (`id`) the way an NSwag-generated `[RouteUrl]` does (it mirrors the
producer's exact OpenAPI parameter name). Not detected: `HttpClient.SendAsync` (its verb comes
from an `HttpRequestMessage` argument, not the method name) and a URL built from string
concatenation or a variable computed elsewhere — both are skipped rather than guessed at, same as
everywhere else in this codebase that degrades gracefully instead of risking a wrong edge.

### Suggested CLAUDE.md snippet: cross-repo awareness

An agent working in one repo has no way to know a workspace even exists unless told — the
single-repo tools above answer confidently ("no callers") from data that's structurally
incapable of seeing another repo. If `rs-graph serve-workspace` is registered alongside this
repo's own `rs-graph serve`, add something like this to the repo's `CLAUDE.md` so an agent
reaches for the workspace tools before concluding a route/message/event is unused:

```markdown
## rs-graph: cross-repo awareness

This repo is indexed alongside others in a workspace (`rs-graph serve-workspace` is registered
next to the single-repo `rs-graph serve`). Before saying a route, Service Bus message, or SignalR
event has no callers/consumers — or before removing/changing one — check the workspace tools, not
just the single-repo ones. `graph_get_references`/`graph_impact_analysis` only ever see this repo;
they cannot tell you a route has zero *cross-repo* callers, only zero callers *they can see*.

1. Find the symbol in this repo's own graph: `graph_get_route_map`/`graph_search_symbol` for a
   Route, or `graph_search_symbol` with `kind: "MessageContract"`/`"HubEvent"` for a message or
   SignalR event.
2. Pass that symbol's id to `graph_workspace_route_consumers` / `graph_workspace_message_consumers`
   / `graph_workspace_signal_consumers` to see which other repos call/publish/consume it.
3. If a workspace tool comes back empty, call `graph_workspace_status` before concluding there's
   truly no cross-repo caller — an empty result can also mean that repo hasn't been indexed yet.
```

**If there's no live workspace server at all** — the common case for a PR review running in CI,
where only this one repo is checked out — none of the above works, since `graph_workspace_*`
needs every repo's `.rs-graph/graph.db` to be reachable. Check `CROSS_REPO_MANIFEST.md` (committed
at this repo's root) instead — see "PR-review manifest" below.

## PR-review manifest

A GitHub Actions job reviewing a PR in one repo only has *that* repo checked out. It can't run
`rs-graph serve-workspace` (every sibling repo's `.rs-graph/graph.db` would need to exist right
there too) and can't spin up a live multi-repo MCP session. So instead of trying to give CI live
access to the graph, `rs-graph generate-manifest <workspace.json>` pre-computes each repo's
cross-repo integration surface from a machine that *does* have the full workspace, and writes it
to two files **committed into that repo itself**:

- `CROSS_REPO_MANIFEST.md` — routes this repo defines (and who calls them from elsewhere), routes
  it calls into other repos (and who defines them), and messages/SignalR events it publishes or
  consumes (and the counterpart repo on the other side).
- `CROSS_REPO_MANIFEST.json` — the same data, structured, for a non-Claude script to parse.

These live at the repo's **root**, not inside `.rs-graph/` — that folder is always gitignored,
local-cache-only (per `rs-graph init`'s own printed reminder); the manifest is the opposite,
meant to be committed like any other doc so it travels into a single-repo CI checkout.

`rs-graph index-workspace <workspace.json>` regenerates every indexed repo's manifest
automatically as its last step, so it stays in sync with every full workspace reindex without any
separate hook wiring (a single repo's own `post-merge`/`post-checkout`/`post-rewrite` hook has no
way to know about `workspace.json`'s other repos, so it can't do this on its own — `index-workspace`
is the one command that already has the whole workspace in hand). `rs-graph watch-workspace` also regenerates them (once at startup, then debounced after any repo
finishes re-indexing), so they track the live graphs instead of only moving on a full workspace
reindex. Run `rs-graph generate-manifest <workspace.json>` directly to refresh them on demand.

Regeneration is idempotent: a repo's files are rewritten only when their content changed (the
`generatedAt` timestamp is ignored), so it never leaves a spurious git diff. A *committed* manifest
is still only as fresh as its last commit — a reviewer should read `generatedAt` and report "no known
consumers as of <date>", never "no consumers".

**Making a reviewer actually use it:** add a line to the repo's `CLAUDE.md` (next to the cross-repo
awareness snippet above) telling a reviewer to check `CROSS_REPO_MANIFEST.md` before approving a
PR that touches a route, message, or event handler — since `/code-review`, an interactive session,
and a `claude -p "review this PR"` CI step all already read a repo's `CLAUDE.md`, that's the entire
integration surface needed; no custom review-pipeline code required. Where the plugin is
installed (including a CI job whose Claude action supports plugins), the
`rs-graph-cross-repo-review` skill carries this checklist, so the CLAUDE.md line is only the
fallback. A non-Claude bot can parse
`CROSS_REPO_MANIFEST.json` the same way instead.

Not built yet: a CI step that diffs the manifest between a PR's base and head to auto-flag a
removed/changed cross-repo dependency. The committed file is the foundational piece — that diffing
step is a separate, environment-specific GitHub Actions workflow, worth adding once this is in use.

## Claude Code plugin

Instead of pasting the CLAUDE.md snippets above into every repo, install the [plugin](../plugin/README.md):
two skills carrying the same guidance (`rs-graph`, loaded only when a question is about code
structure, and `rs-graph-cross-repo-review`, for PRs that touch a route/message/event), a
SessionStart hook that builds or refreshes the graph in the background, and the MCP server
registration. The hook is built on `rs-graph doctor` (next section).

## Checking a repo's graph: `rs-graph doctor`

`rs-graph doctor [path] [--json]` is a read-only health check — it never indexes, builds, restores,
or writes anything. It reports one status:

| Status | Meaning | Next step |
| --- | --- | --- |
| `missing` | No graph yet (or an index run is still creating it) | `rs-graph index <path>` |
| `needs-build` | At least half the .NET projects have no `obj/project.assets.json`, so references can't resolve and the graph would be hollow | Restore/build the solution yourself (rs-graph never does), then `rs-graph index` |
| `stale` | Source files (`.cs .ts .tsx .html .py`) changed after the last index started | `rs-graph index <path>` (incremental) |
| `degraded` | Up to date, but the .NET indexer couldn't resolve many declaration types at index time (50+) — callers/references through those types will be missing | Make sure the solution is restored and built, then `rs-graph index --fresh` |
| `ok` | Nothing to do | — |

It also reports whether `.mcp.json` registers `rs-graph`, whether `.rs-graph/` is git-ignored, and
whether the three git hooks are installed. `--json` prints the same report for scripts, hooks, and
agent skills. The "degraded" signal comes from `.rs-graph/index-report.json`, which every `index`
run writes next to `graph.db` (the .NET indexer counts unresolved declaration references; it's a
cheap declaration-diagnostics pass, not a full compile).

## Keeping the graph fresh across `git pull`, branch switches, and rebases

Nothing re-indexes automatically just because the working tree changed underneath you — without
this, the graph silently drifts until someone remembers to run `rs-graph index` again.
`rs-graph install-hook [path]` installs three git hooks that each trigger the same background
reindex: `post-merge` (`git pull`/merge), `post-checkout` (switching branches — not a single-file
`git checkout -- path`, which doesn't change the whole repo), and `post-rewrite` (`git rebase`,
`git commit --amend`). `rs-graph install-hook-workspace <workspace.json>` installs all three into
every repo in a workspace at once. It's a separate, explicit command — installing it changes what
happens on every future pull/checkout/rebase in that repo, so it's not bundled into `index`'s
automatic `.mcp.json` registration the way the MCP server entries are.

Two git operations change the working tree with no hook at all: `git reset --hard` and
`git stash pop`/`apply`. `watch` (below) is the only thing that catches those live; otherwise the
graph just needs a manual `rs-graph index` afterwards.

`install-hook` copies [templates/post-merge.sample](../templates/post-merge.sample),
[templates/post-checkout.sample](../templates/post-checkout.sample), and
[templates/post-rewrite.sample](../templates/post-rewrite.sample) to `.githooks/`, and points
`core.hooksPath` at `.githooks` (left alone if it's already set to something else). Commit
`.githooks/` so the rest of the team gets it too — on Windows, also run
`git update-index --chmod=+x .githooks/post-merge .githooks/post-checkout .githooks/post-rewrite`
after staging them, since NTFS doesn't track the executable bit the way git expects.

**Why these need to run in the background, not block the git command.** None of the three
indexers are incremental at the parse/compile level — every `rs-graph index` run does a full
Roslyn compilation of the whole .NET solution, builds a fresh TypeScript `ts.Program` over every
file, and walks every Python file, regardless of how few files actually changed. (Only the
*database write* is incremental: `ingest.ts` hashes each file's content and skips rewriting a
file's symbols/edges/FTS rows if the hash hasn't changed — see `watch.ts`'s docstring for the same
tradeoff in the `watch` command.) On a large repo, that full re-scan can take far longer than is
reasonable to block a pull/checkout/rebase on. So each hook launches `rs-graph index` detached and
exits 0 immediately, without waiting to find out whether the reindex even succeeds — a slow or
failing reindex must never look like a failed git command. Output goes to `.rs-graph/hooks.log`;
check there if the graph seems to be lagging behind the working tree.

### Watching for local changes

`rs-graph watch [path]` re-indexes a repo whenever a relevant file (`.cs`/`.ts`/`.tsx`/`.html`/
`.py`, outside `node_modules`/`bin`/`obj`/`dist`/`.git`/`.rs-graph`/any dotfolder) is added,
edited, or deleted, debouncing a burst of changes into one reindex. All three kinds of change are
handled: an edit or a new file changes what gets written on the next reindex as usual, and a
*deleted* file has its symbols/edges/FTS rows purged too (`ingest.ts` compares each language's
full file list against what's already in the database — anything missing was removed from disk).
`rs-graph watch-workspace <workspace.json>` does the same for every repo in a workspace at once,
one independent watcher per repo, so one repo's failure doesn't stop the others.

`watch` and the git hooks above are meant to run at the same time — someone `git pull`ing,
switching branches, or rebasing while `watch` is already running in another terminal is a normal,
expected scenario, not a misconfiguration. Both ultimately call the same full-rescan reindex
against the same `.rs-graph/graph.db`, and SQLite only allows one writer at a time even in WAL
mode — `graph-store` sets a `busy_timeout` so whichever one loses that race just waits (well under
the ~1-2s a single repo's reindex takes) instead of throwing `SQLITE_BUSY`.
