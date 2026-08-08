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

Register it with Claude Code by adding to the target repo's `.mcp.json`:

```json
{
  "mcpServers": {
    "rs-graph": {
      "command": "node",
      "args": ["<path-to-rs-graph>/packages/cli/dist/main.js", "serve", "."]
    }
  }
}
```

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
  cli/                       `rs-graph init|index|watch|serve`
  eval/                       benchmark harness comparing rs-graph vs. grep/read (see packages/eval/README.md)
fixtures/                 one small sample project per language, used as integration-test targets
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

## Status & limitations

Done: .NET, Angular, Aurelia, and Python indexers; incremental `watch`; all 14 MCP tools;
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
