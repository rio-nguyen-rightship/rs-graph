# rs-graph

Turns a codebase into a queryable graph — files, symbols, calls, inheritance, routes, DI
wiring, template bindings — and serves it to coding agents over [MCP](https://modelcontextprotocol.io),
so an agent can ask precise questions ("who calls this method", "what's this file's public
surface", "what would changing this interface break") instead of grepping and reading whole
files to rebuild that context on every task.

Supports **.NET/C#** (ASP.NET Core), **Angular** and **Aurelia** (TypeScript), and **Python**
(Flask/FastAPI/Django).

## Quickstart

```bash
git clone <this-repo>
cd rs-graph
npm install
npm run build --workspaces
```

Then, from inside the repo you want to index:

```bash
node <path-to-rs-graph>/packages/cli/dist/main.js init .    # creates .rs-graph/graph.db
node <path-to-rs-graph>/packages/cli/dist/main.js index .   # detects project type(s), builds the graph
node <path-to-rs-graph>/packages/cli/dist/main.js watch .   # optional: re-index on file change
node <path-to-rs-graph>/packages/cli/dist/main.js serve .   # starts the MCP server over stdio
```

### Using it as a `rs-graph` command

Typing the full `node .../dist/main.js` path gets old fast. Register a `rs-graph` command
that points at your local checkout with `npm link` (this only creates a global symlink to
this checkout — nothing is published anywhere, and `.NET`/Python indexer resolution still
relies on this repo's own layout, so don't move/delete the checkout afterwards):

```bash
npm link --workspace @rs-graph/cli
```

Then, from any directory:

```bash
rs-graph init .
rs-graph index . --fresh
rs-graph watch .
rs-graph serve .
```

`serve` never creates anything: if the repo isn't indexed yet it still starts, and every tool call returns "not indexed yet" until
`.rs-graph/graph.db` appears — then it answers without a restart. So `serve` can be registered (or launched by Claude) before or
while `rs-graph index` runs.

To remove it later: `npm unlink --workspace @rs-graph/cli` (or `npm uninstall -g @rs-graph/cli`).

If a repo has more than one `.sln`/`.slnx` or `tsconfig.json`, `index`/`watch` otherwise just
pick the first one found. Pin it explicitly with `--sln`/`--tsconfig` (relative to the target
path, or absolute):

```bash
node <path-to-rs-graph>/packages/cli/dist/main.js index . --sln Backend/Backend.slnx
node <path-to-rs-graph>/packages/cli/dist/main.js index . --tsconfig apps/web/tsconfig.json
```

If `.rs-graph/graph.db` ends up in a bad state — most commonly stale/duplicate data left behind
by an interrupted run or an older version of an indexer, surfacing as a `UNIQUE constraint
failed: Symbol.id` error — pass `--fresh` to delete it and rebuild from scratch:

```bash
node <path-to-rs-graph>/packages/cli/dist/main.js index . --fresh
```

`index` registers the repo with Claude Code automatically — it adds an `"rs-graph"` entry to the
target repo's `.mcp.json` (creating the file if needed, merging into it without touching other
entries if not), assuming `rs-graph` resolves on `PATH`:

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

If you're running from this monorepo without a global/linked install, `rs-graph` won't be on
`PATH` yet — edit the generated entry's `command`/`args` to the `node <path-to-rs-graph>/packages/
cli/dist/main.js` form instead (same as the `index` invocation above, with `serve` in place of
`index`). Re-running `index` never overwrites an existing entry under the same name, so this edit
sticks across re-indexing.

See [docs/mcp-tools.md](docs/mcp-tools.md) for the full tool reference, and
[docs/architecture.md](docs/architecture.md) for how the pipeline is put together.

`npx rs-graph ...` (installing the CLI standalone, without cloning the monorepo) isn't set up
yet — see [Status & limitations](#status--limitations).

## Security

- **Static analysis only. Indexing never runs a package manager or build command against the
  repo being indexed** — no `dotnet restore`/`build`, no `npm install`, no `pip install`. Each
  indexer reads whatever the developer has already restored/installed locally and degrades
  gracefully (marking unresolved types `external`) if that's missing. See
  [docs/architecture.md](docs/architecture.md#security-principle) for the full rationale and
  how each language indexer honors it.
- **The MCP server only talks stdio** — no network listener, no auth surface. The only client
  is whatever process spawns it (e.g. Claude Code).
- **`.rs-graph/graph.db` contains extracted source structure and signatures** — treat it as
  sensitive as the source itself; `rs-graph init` reminds you to add it to `.gitignore`.
- Signatures and doc summaries are redacted for likely secrets (API keys, connection strings,
  bearer/JWT tokens, ...) before being persisted or made full-text searchable — see
  `packages/core-schema/src/redactSecrets.ts`.

## Repo layout

```
packages/
  core-schema/          unified graph model (TS types + SQLite DDL), shared by every indexer
  graph-store/            better-sqlite3 wrapper: ingest + every query the MCP tools use
  indexer-dotnet/          Roslyn-based C#/ASP.NET Core indexer (.NET console tool)
  indexer-typescript/      TS-Compiler-API-based indexer + Angular/Aurelia enrichment
  indexer-python/          ast-based Python indexer + Flask/FastAPI/Django route enrichment
  mcp-server/               MCP tools, thin wrappers over graph-store's queries
  workspace-store/          cross-repo join index (routes/messages/SignalR events) for the workspace tools
  cli/                       rs-graph init|index|watch|watch-workspace|serve|index-workspace|
                             serve-workspace|install-hook|install-hook-workspace|generate-manifest|doctor
  eval/                       benchmark harness comparing rs-graph vs. grep/read (see packages/eval/README.md)
plugin/                   Claude Code plugin: skill + SessionStart hook + MCP registration (see plugin/README.md)
fixtures/                 one small sample project per language, plus sample-workspace (two tiny
                          repos wired together, used as the cross-repo integration-test target)
templates/
  post-merge.sample         git hooks re-indexing in the background — pull/merge, branch switch,
  post-checkout.sample      rebase/amend respectively — all installed together by
  post-rewrite.sample       `rs-graph install-hook`
docs/
  architecture.md
  mcp-tools.md
```

## Development

```bash
npm run build --workspaces --if-present   # or: npx tsc -b tsconfig.json (from repo root)
npm run test --workspaces --if-present    # TS test suites (vitest)

cd packages/indexer-dotnet/tests && dotnet test     # .NET indexer tests (xUnit)
cd packages/indexer-python && python -m pytest tests # Python indexer tests (pytest)
```

### After changing rs-graph's own code

`rs-graph` runs compiled JavaScript from each package's `dist/` folder, not the TypeScript source
directly — a source change does nothing until rebuilt. Whether you also need to re-index or
restart anything depends on what changed:

- **Rebuild** (`npm run build --workspaces --if-present`): always required after any source change.
- **Re-index** (`rs-graph index`/`index-workspace`): only needed if the change affects what gets
  *written* to `.rs-graph/graph.db` — an indexer (`indexer-dotnet`/`-typescript`/`-python`) or
  `graph-store/src/ingest.ts`. A change to query/tool logic (`graph-store/src/queries.ts`,
  `mcp-server/src/tools.ts`) reads the existing database unchanged, so the same
  already-indexed data just gets served differently — no re-index needed.
- **Restart the MCP server** (reopen the Claude Code session, or otherwise restart the `rs-graph
  serve`/`serve-workspace` process): always required after a rebuild — it's a long-running process
  that already loaded the old code into memory, so rebuilding alone doesn't hot-reload it.

## Status & limitations

Done: .NET, Angular, Aurelia, and Python indexers; incremental `watch`/`watch-workspace` (handles
edits, new files, and deletions alike, safely alongside the git hook — see
[docs/mcp-tools.md](docs/mcp-tools.md#watching-for-local-changes)); 14 single-repo MCP tools
plus 4 cross-repo workspace tools, served from a self-refreshing in-memory index so a long-lived
`serve-workspace` process picks up a repo re-indexed while it's running, no restart needed (sync
API calls via NSwag `[RouteUrl]`, a raw C# `HttpClient` call, or an Angular `HttpClient` call —
matched by route *shape*, not parameter name, so a hand-written call's own local variable name
doesn't need to match the route's declared one — plus Azure Service Bus messaging and SignalR;
see [docs/mcp-tools.md](docs/mcp-tools.md#cross-repo-workspace-tools)); a committed, per-repo
`CROSS_REPO_MANIFEST.md`/`.json` (`rs-graph generate-manifest`) so a repo-scoped PR reviewer (e.g.
in CI, with no other repos checked out) still has cross-repo context — see
[docs/mcp-tools.md](docs/mcp-tools.md#pr-review-manifest); automatic `.mcp.json` registration on
`index`/`index-workspace` (no manual server setup step); git hooks
(`install-hook`/`install-hook-workspace`) that re-index in the background after a pull, branch
switch, or rebase/amend (see
[docs/mcp-tools.md](docs/mcp-tools.md#keeping-the-graph-fresh-across-git-pull-branch-switches-and-rebases));
secret redaction; a "never shells out to a build/package-manager command" regression test.

Not done yet:
- Standalone `npx rs-graph` distribution (currently requires cloning + building this monorepo;
  see `findDotnetIndexerDll`/`findPythonIndexerScript` in `packages/cli/src/commands/indexRepo.ts`
  for the development-mode path resolution this would need to replace).
- FastAPI `Depends()` dependency-injection edges, Django class-based views, lazy-loaded
  (`loadChildren`) Angular routes, and Aurelia 2's decorator-based `@route` config.
- CALLS resolution in the Python indexer is a name/import heuristic, not full type-checker
  resolution (Python's `ast` module is syntax-only) — see `packages/indexer-python/src/graph_builder.py`.
- Aurelia template-binding extraction is a regex heuristic, not a real template parse (same
  trade-off Angular's enrichment makes, documented in `angularEnrichment.ts`).
- A generated SDK client method decorated with `[RouteUrl]` carries only the route path, never
  the verb — `graph_workspace_route_consumers` matches on template alone, so a producer that
  registers the same template under more than one verb returns every candidate rather than
  disambiguating (see `SymbolGraphBuilder.EmitSignalREdges`'s sibling, the sync-API pass, in
  `packages/indexer-dotnet/src/SymbolGraphBuilder.cs`).
- Raw HTTP call detection covers `HttpClient.GetAsync`/`PostAsync`/`PutAsync`/`DeleteAsync`/
  `PatchAsync` (C#) and Angular `HttpClient.get`/`post`/`put`/`delete`/`patch` (TS) with a literal
  or simply-interpolated URL — not `HttpClient.SendAsync` (verb comes from an `HttpRequestMessage`
  argument, not the method name), and not a URL built from string concatenation or a variable
  computed elsewhere (skipped rather than guessed at).
- None of the three indexers are incremental at the parse/compile level — `rs-graph index`
  always fully re-scans/re-compiles the whole repo; only the database write skips unchanged files
  (see `ingest.ts`'s content-hash check). This is why the post-merge hook above runs detached
  rather than blocking the pull — see its docs section for the full rationale.
