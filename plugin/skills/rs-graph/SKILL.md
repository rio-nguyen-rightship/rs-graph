---
name: rs-graph
description: Answer questions about code structure from the rs-graph code graph instead of grepping — who calls or references a method/class, what implements an interface, what a change or deletion would break, where something is defined, a file's outline, what a file imports, HTTP routes, DI registrations, Angular/Aurelia components, and whether another repo calls a route or consumes a message/SignalR event. Use before Grep or Read for any "who calls", "where is X used/defined", "what breaks if I change/remove", "what implements", or "does anything consume this" question, and when a graph_* tool returns empty or errors.
---

# rs-graph: use the graph, keep it honest

The `graph_*` tools (MCP server `rs-graph`) give exact answers from real declarations and call
edges — polymorphism-aware, so a method's callers include calls made through an interface or base
type it implements. Grep can be wrong both ways: hits that aren't references (comments,
similarly-named symbols) and real references it misses (calls through an interface, different
aliases or casing).

## 1. Know the graph's state first

If the plugin's SessionStart hook ran, it already built or refreshed the graph and put its status in
your context. Otherwise — or to re-check — run `rs-graph doctor --json` and act on `status`:

| status | what it means | what you do |
| --- | --- | --- |
| `ok` | graph is current | use the tools |
| `missing` | no graph yet; the hook started indexing | tools say "not indexed yet" until it finishes — use Grep/Read meanwhile, retry later, no restart needed |
| `stale` | source changed since the last index | tools work but may lag; verify surprises with Grep/Read; `rs-graph index` refreshes |
| `needs-build` | .NET projects were never restored, so references can't resolve | **do not run restore/build yourself — ask the user.** Use Grep/Read for C# until they have |
| `degraded` | up to date, but the compiler couldn't resolve many types | empty callers/references for C# symbols mean "unknown", not "none"; fall back to Grep; suggest `rs-graph index --fresh` after a build |

rs-graph never runs restore/build/install itself, and you shouldn't to make it work.

## 2. No `graph_*` tools in this session?

If the MCP server isn't registered yet (a repo with no `.mcp.json`, or one added mid-session — MCP
servers can't be hot-loaded), run the same tools from the shell; same handlers, same answers:

```
rs-graph query --list                                   # every tool and its parameters
rs-graph query callers -a filePath=src/Foo.cs -a line=42
rs-graph query search_symbol -a query=Foo -a scope=name
rs-graph query route_consumers --workspace ../workspace.json -a symbolId=...
```

Tool names can be shortened (`callers` = `graph_get_callers`); `-a key=value` is typed from the tool's
schema, or pass `--json '{...}'`. The rest of this skill applies unchanged.

## 3. Pick the tool by question

| Question | Tool |
| --- | --- |
| Where is X declared / its signature | `graph_get_definition`, `graph_search_symbol` (use `scope: "name"` when you know the exact identifier) |
| What's in this file | `graph_get_file_outline` (cheaper than a full Read) |
| Who calls / references X | `graph_get_callers` / `graph_get_references` |
| What does X call | `graph_get_callees` |
| What would changing or deleting X break | `graph_impact_analysis` |
| What implements / extends X | `graph_get_class_hierarchy` |
| What does this file import, or what imports it | `graph_get_dependencies` |
| HTTP routes / DI registrations / Angular–Aurelia components | `graph_get_route_map` / `graph_get_di_graph` / `graph_get_component_tree` |

Search results are compact and carry `filePath` + `startLine`; pass those instead of a symbol id to
the caller/reference/impact tools.

Treat each new question independently — using Grep once is not a reason to keep using it.

## 4. When Grep/Read is the right call

- The question isn't structural: a literal string, config value, log message, TODO, prose in a
  comment or doc.
- You already know the exact file and line.
- A graph tool came back empty or errored for something you're confident exists. That's a
  **likely stale or degraded index, not proof of zero references** — check status (section 1),
  suggest `rs-graph index` (or `--fresh`), but don't let it block you: grep instead.

## 5. Cross-repo: before saying nothing uses it

`graph_get_references` and `graph_impact_analysis` only see this repo. Before claiming a route,
Service Bus message, or SignalR event has no callers/consumers — or before removing or changing one:

1. Find the symbol in this repo's graph: `graph_get_route_map` / `graph_search_symbol` for a Route,
   or `graph_search_symbol` with `kind: "MessageContract"` / `"HubEvent"`.
2. Pass its id to `graph_workspace_route_consumers`, `graph_workspace_message_consumers`, or
   `graph_workspace_signal_consumers` (server `rs-graph-workspace`).
3. If a workspace tool is empty, call `graph_workspace_status` before concluding there's no
   cross-repo caller — an empty result can also mean that repo hasn't been indexed yet.

If the workspace server isn't available (only this repo is checked out), read
`CROSS_REPO_MANIFEST.md` at the repo root if present — it lists this repo's cross-repo routes,
messages, and events as of the last workspace index, and may be stale.
