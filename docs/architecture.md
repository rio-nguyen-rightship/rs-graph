# Architecture

## Pipeline

```
target repo
   │
   ├─ indexer-dotnet   (Roslyn + MSBuild evaluation)   ─┐
   ├─ indexer-typescript (TS Compiler API)               ├─ NDJSON (GraphRecord stream)
   └─ indexer-python   (stdlib ast)                     ─┘
                              │
                        graph-store (ingestGraphRecords)
                        SQLite: .rs-graph/graph.db
                              │
                        mcp-server (14 tools)
                              │
                        stdio ── Claude Code / any MCP client
```

`rs-graph index <path>` (in `packages/cli`) detects which language(s)/framework(s) a repo
uses, runs the matching indexer(s), and feeds the resulting NDJSON into `graph-store`.
`rs-graph serve <path>` opens that same `.rs-graph/graph.db` and exposes it over MCP.
`rs-graph watch <path>` re-runs `index` on file change (debounced), relying on
`graph-store`'s contentHash-keyed ingest to make re-indexing idempotent — a re-index only
*writes* rows for files that actually changed, even though each indexer currently does a full
project rescan rather than a surgical single-file reparse.

## Unified graph schema

Defined once in `packages/core-schema` (TS types in `nodes.ts`/`edges.ts`, SQLite DDL in
`ddl.ts`) and shared by every indexer, regardless of source language:

- **File** — path, language, contentHash, sizeBytes
- **Symbol** — every class/interface/enum/struct/method/function/property/field/variable, plus
  two synthesized kinds: **Route** (a route/endpoint definition) and **DIRegistration** (a
  dependency-injection registration call site)
- **Component** — Angular/Aurelia component overlay, sharing its id with the underlying Class
  Symbol
- **Edge** — one generic table for every relationship (`DEFINES`, `EXTENDS`, `IMPLEMENTS`,
  `OVERRIDES`, `CALLS`, `REFERENCES`, `IMPORTS`, `INJECTS`, `ROUTES_TO`, `REGISTERS`,
  `BINDS_TEMPLATE`)

Every indexer emits the exact same NDJSON record shapes (see `core-schema/src/ndjson.ts`), so
`graph-store` and `mcp-server` never need to know which language produced a given row.

### Symbol ids

Ids are built from the *declaration site*, not reference sites, so they're stable across
reformatting and consistent regardless of how many places reference a symbol:

- C#: `csharp:<fully-qualified-name-with-parameter-types>` (via Roslyn's `SymbolDisplayFormat`)
- TypeScript: `typescript:<repo-relative-path>#<dotted-qualified-name>`
- Python: `python:<repo-relative-path>#<dotted-qualified-name>`

Symbols outside the set of files an indexer walks (an external package, a stdlib/BCL type) are
registered as external stubs via `ExternalSymbolRegistry` (in `core-schema`, reused natively by
each indexer): grouped into one synthetic pseudo-file per package/assembly, with a contentHash
derived from the *set* of known external ids for that group — so the idempotent ingest
naturally refreshes a group's stub rows exactly when a new external symbol is first referenced,
and leaves it alone otherwise.

### Polymorphic call resolution

Found via real-world usage against a large ASP.NET Core codebase: `graph_get_callers` on a
heavily-called concrete method returned empty. Root cause — real code overwhelmingly calls
through an interface-typed DI reference (`private readonly IFoo _foo; ... _foo.Bar()`), so the
semantic model resolves the call target to the **interface method**, never the concrete
implementation directly. `CALLS` edges pointed at `IFoo.Bar`, and nothing pointed at
`Concrete.Bar` at all — asking for callers of the concrete method (the natural thing to do
after reading its declaration) found nothing, even though the method is called constantly.

Fixed in two parts:
1. Every indexer now also emits a member-level `IMPLEMENTS` edge (`Concrete.Method IMPLEMENTS
   IInterface.Method`), not just the class-level one. C#: via Roslyn's
   `FindImplementationForInterfaceMember`. TypeScript: by name-matching a class's members
   against its implemented interface's members (TS has no compiler-API equivalent of
   `FindImplementationForInterfaceMember` since implementation is structural, not declared).
2. `graph_get_callers`/`graph_get_references` (`getPolymorphicAncestorIds` in
   `graph-store/src/queries.ts`) walk `IMPLEMENTS`/`OVERRIDES` edges *from* the queried symbol
   and search for calls to any of those targets too, not just the exact id — so querying a
   concrete method's callers transparently includes calls made through its interface.
   `graph_get_callees` deliberately isn't touched: a symbol's own outgoing calls are already
   resolved to their correct targets regardless of whether the symbol itself is reached via an
   interface.

This also surfaced a related TypeScript-only gap while fixing it: `TsGraphBuilder` only walked
class members, never interface members — an interface's own methods/properties had no `Symbol`
row at all (only edges referencing their id), so `graph_get_definition`/`graph_get_file_outline`
on an interface method found nothing. Fixed by walking interface members the same way class
members are walked.

## Per-language indexer approach

All three were originally planned or considered around existing SCIP-based indexers
(`scip-typescript`, `scip-python`) to avoid writing semantic analysis from scratch. Both were
dropped after hands-on testing during implementation:

- **`scip-typescript`** doesn't populate `SymbolInformation.kind` at all (every symbol came
  back `UnspecifiedKind`) — the field needed to distinguish Class/Interface/Method/Property.
- **`scip-python`** crashes immediately on Windows (`new RegExp(path.sep, 'g')` in its own
  source is invalid regex syntax where `path.sep` is a bare backslash) and carries an unfixed
  high-severity dependency vulnerability.

All three indexers now do direct semantic/syntactic analysis instead:

- **`indexer-dotnet`**: Roslyn (`Microsoft.CodeAnalysis.CSharp`) + MSBuild **evaluation**
  (`Microsoft.Build.Evaluation`, never `Build()`). Builds a real multi-project `Compilation`
  graph (topologically sorted by `ProjectReference`, wired via `CSharpCompilationReference`) so
  cross-project calls resolve correctly without needing the referenced project's `bin/` output.
  Full type-checker-backed resolution: `CALLS`, `EXTENDS`/`IMPLEMENTS`/`OVERRIDES`, constructor
  `INJECTS`, ASP.NET Core route attributes, `AddScoped/Singleton/Transient` DI registrations.

- **`indexer-typescript`**: TypeScript Compiler API (`ts.createProgram` + `TypeChecker`) —
  same category of full semantic analysis as Roslyn, covering the whole program (including
  `node_modules` type declarations) in one `Program`. Angular and Aurelia enrichment
  (`angularEnrichment.ts` / `aureliaEnrichment.ts`) run as separate passes over the same
  `Program`, adding `Component` rows, template bindings, and route resolution without
  duplicating the base declaration/call-graph walk. Note: both enrichers always run regardless
  of detected framework, so `AureliaEnricher` explicitly skips any class already claiming an
  `@Component` decorator — Angular's own `foo.component.ts`/`foo.component.html` naming
  convention would otherwise also match Aurelia's decorator-free view/view-model file pairing.

- **`indexer-python`**: Python's stdlib `ast` module — syntax only, no type checker, so `CALLS`
  resolution is a deliberate name/import heuristic rather than fully resolved (see the four
  cases in `graph_builder.py`'s `_resolve_call`): same-class `self.method()`, cross-class
  `self.attr.method()` where `attr`'s type is inferred from a constructor parameter annotation
  (the Python analogue of constructor-injection resolution), same-file bare function calls, and
  calls through a whole-module import alias. Anything else (e.g. a call through a variable of
  unknown/uninferred type) is left unresolved rather than guessed.

## Security principle

Full semantic resolution normally wants a build (`dotnet restore`, `npm install`, `pip install`)
to resolve external types. **No indexer ever does this automatically** — running
restore/build against an arbitrary target repo means executing third-party package/build code,
a real supply-chain risk for a tool meant to be pointed at many repos.

1. Use whatever the developer has *already* produced locally (`obj/project.assets.json` +
   `bin/` for .NET, `node_modules/` for TS, an installed venv/site-packages for Python) —
   read-only file access, never process execution of a package manager.
2. If those artifacts are missing, degrade gracefully: index everything resolvable from source
   alone, and represent unresolved external symbols as opaque stub nodes rather than failing.
3. .NET specifically: project files are loaded via MSBuild **evaluation**
   (`Microsoft.Build.Evaluation.Project`) — property/item expansion only, never
   `Project.Build()` / `dotnet build`. Reading a `.dll` for its metadata
   (`MetadataReference.CreateFromFile`) only parses ECMA-335 metadata tables — it does not load
   or execute the assembly, so this is safe even for third-party binaries already sitting in
   `bin/`/the NuGet cache.
4. No indexer needs network access. The MCP server only binds to stdio, never a network port.
5. Signatures/doc summaries are redacted for likely secrets before being persisted (see
   `packages/core-schema/src/redactSecrets.ts`, applied centrally in `graph-store`'s ingest so
   no per-language indexer can forget it).
6. `.rs-graph/graph.db` is as sensitive as the source itself (extracted structure + signatures)
   — `rs-graph init` reminds you to gitignore it.

A dedicated regression test (`packages/cli/src/noBuildCommands.test.ts`) spies on every
subprocess `rs-graph index` spawns across all four fixtures and asserts none of them are a
package-manager/build subcommand.

## Storage engine

Originally planned around Kuzu (an embedded graph database with Cypher-like queries). Dropped
after finding it had been archived by its maintainers with an unfixed critical vulnerability
in its install-time dependency chain. Landed on SQLite (`better-sqlite3`) instead — actively
maintained, zero known critical vulnerabilities, a single embedded file. Graph traversals
(callers/callees, class hierarchy, N-hop impact analysis) are hand-written recursive CTEs
(`packages/graph-store/src/queries.ts`) rather than a graph query language — reasonable since
the MCP tool set is a fixed, enumerable set of traversal patterns, not ad-hoc queries.
