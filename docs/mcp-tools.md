# rs-graph MCP tools

`rs-graph serve <path>` starts an MCP server over stdio against `<path>/.rs-graph/graph.db`
(built by `rs-graph index <path>` first). No network listener, no auth — the only client is
whatever process spawns it.

## Registering with Claude Code

Add to the repo's `.mcp.json`:

```json
{
  "mcpServers": {
    "rs-graph": {
      "command": "npx",
      "args": ["rs-graph", "serve", "."]
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `graph_stats` | Repo-wide counts by kind/language. Cheap first call to orient in a codebase. |
| `graph_search_symbol` | Full-text search over symbol name/signature/doc (SQLite FTS5 syntax). |
| `graph_get_file_outline` | A file's declared symbols (signatures only, no bodies) — use instead of Read for "what's in this file". |
| `graph_get_definition` | Resolve a symbol by id, or by file+line. |
| `graph_get_references` / `graph_get_callers` / `graph_get_callees` | Call-graph traversal, one hop at a time. `references`/`callers` are polymorphism-aware — a concrete method's callers include calls made through an interface/base type it implements or overrides, since that's how real DI code actually calls it. |
| `graph_get_class_hierarchy` | Ancestors/descendants of a class or interface, with hop depth. |
| `graph_get_dependencies` | A file's imports, in both directions. |
| `graph_impact_analysis` | Transitive dependents of a symbol — "what would changing this break". Capped at 100 results by default (`maxResults`, up to 500) with a `truncated` flag — on a widely-used symbol, prefer a smaller `depth` or a more specific symbol over raising the cap. |
| `graph_get_route_map` | HTTP/router routes mapped to their handler symbol. |
| `graph_get_di_graph` | DI registrations mapped to the interface/implementation they register. |
| `graph_get_component_tree` | Angular/Aurelia components mapped to the members their templates bind to. |
| `graph_context_pack` | Minimal deduplicated subgraph around one or more seed symbols — an alternative to reading N related files. |

Every tool returns compact, unindented JSON in a single text content block.
