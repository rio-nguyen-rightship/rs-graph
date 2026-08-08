import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphDb } from "@rs-graph/graph-store";
import {
  contextPack,
  getCallees,
  getCallers,
  getClassHierarchy,
  getComponentTree,
  getDefinitionAtLocation,
  getDependencies,
  getDiGraph,
  getFileOutline,
  getReferences,
  getRouteMap,
  getStats,
  getSymbolById,
  impactAnalysis,
  searchSymbol,
} from "@rs-graph/graph-store";
import { errorResult, jsonResult } from "./toolResult.js";

const SYMBOL_KIND = z.enum([
  "Class",
  "Interface",
  "Enum",
  "Struct",
  "Method",
  "Function",
  "Property",
  "Field",
  "Variable",
  "Component",
  "Route",
  "DIRegistration",
]);

/** Registers every rs-graph MCP tool against an already-open graph database. Kept as one
 * function (rather than a class) since every tool is a thin, stateless wrapper over a
 * graph-store query function — there's no shared mutable state to justify more structure. */
export function registerTools(server: McpServer, db: GraphDb): void {
  server.registerTool(
    "graph_stats",
    {
      title: "Graph stats",
      description:
        "Repo-wide counts of files and symbols by kind/language. Cheap, no arguments — call this " +
        "first to orient yourself in a codebase before making more targeted queries.",
      inputSchema: {},
    },
    () => jsonResult(getStats(db)),
  );

  server.registerTool(
    "graph_search_symbol",
    {
      title: "Search symbols",
      description:
        "Full-text search over symbol names/signatures/doc comments (SQLite FTS5 MATCH syntax — " +
        "supports prefix queries like 'get*'). Use this to find a starting symbol id by name " +
        "instead of grepping the repo.",
      inputSchema: {
        query: z.string().describe("FTS5 match expression, e.g. a name or 'name*' prefix"),
        kind: SYMBOL_KIND.optional().describe("Restrict to one symbol kind"),
        language: z.string().optional().describe("Restrict to one language, e.g. 'csharp' or 'typescript'"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    ({ query, kind, language, limit }) => jsonResult(searchSymbol(db, { query, kind, language, limit })),
  );

  server.registerTool(
    "graph_get_file_outline",
    {
      title: "File outline",
      description:
        "Lists every symbol declared in a file (name, kind, signature, line range) without reading " +
        "the file's source — use this instead of Read when you only need to know a file's public " +
        "surface.",
      inputSchema: { path: z.string().describe("Repo-relative file path") },
    },
    ({ path }) => jsonResult(getFileOutline(db, path)),
  );

  server.registerTool(
    "graph_get_definition",
    {
      title: "Get definition",
      description:
        "Resolves a symbol's declaration (signature, doc summary, exact location). Pass either " +
        "symbolId, or filePath+line to resolve whatever symbol's span contains that line.",
      inputSchema: {
        symbolId: z.string().optional(),
        filePath: z.string().optional(),
        line: z.number().int().positive().optional(),
      },
    },
    ({ symbolId, filePath, line }) => {
      if (symbolId) {
        const symbol = getSymbolById(db, symbolId);
        return symbol ? jsonResult(symbol) : errorResult(`No symbol found with id ${symbolId}`);
      }
      if (filePath && line) {
        const symbol = getDefinitionAtLocation(db, filePath, line);
        return symbol ? jsonResult(symbol) : errorResult(`No symbol found at ${filePath}:${line}`);
      }
      return errorResult("Provide either symbolId or filePath+line");
    },
  );

  const pageArgs = {
    limit: z.number().int().positive().max(500).optional(),
    offset: z.number().int().nonnegative().optional(),
  };

  server.registerTool(
    "graph_get_references",
    {
      title: "Get references",
      description:
        "All call sites and other references to a symbol (both CALLS and REFERENCES edges), with " +
        "file:line. Polymorphism-aware: if symbolId is a concrete method implementing an interface " +
        "or overriding a base method, this also includes calls made through that interface/base " +
        "type — real code overwhelmingly calls through interface-typed DI references, so most " +
        "callers of a concrete method resolve to the interface method, not the concrete one.",
      inputSchema: { symbolId: z.string(), ...pageArgs },
    },
    ({ symbolId, limit, offset }) => jsonResult(getReferences(db, symbolId, { limit, offset })),
  );

  server.registerTool(
    "graph_get_callers",
    {
      title: "Get callers",
      description:
        "Every symbol that calls the given symbol (one hop up the call graph). Polymorphism-aware " +
        "(see graph_get_references) — includes calls made through an interface/base type this " +
        "symbol implements or overrides, not just direct calls to this exact symbol.",
      inputSchema: { symbolId: z.string(), ...pageArgs },
    },
    ({ symbolId, limit, offset }) => jsonResult(getCallers(db, symbolId, { limit, offset })),
  );

  server.registerTool(
    "graph_get_callees",
    {
      title: "Get callees",
      description: "Every symbol the given symbol calls (one hop down the call graph).",
      inputSchema: { symbolId: z.string(), ...pageArgs },
    },
    ({ symbolId, limit, offset }) => jsonResult(getCallees(db, symbolId, { limit, offset })),
  );

  server.registerTool(
    "graph_get_class_hierarchy",
    {
      title: "Get class hierarchy",
      description:
        "Ancestors (base classes/interfaces, transitively) and descendants (subclasses/implementations) " +
        "of a class or interface symbol, each tagged with hop depth.",
      inputSchema: { symbolId: z.string() },
    },
    ({ symbolId }) => jsonResult(getClassHierarchy(db, symbolId)),
  );

  server.registerTool(
    "graph_get_dependencies",
    {
      title: "Get file dependencies",
      description: "Files a given file imports, and files that import it — the import graph in both directions.",
      inputSchema: { filePath: z.string() },
    },
    ({ filePath }) => jsonResult(getDependencies(db, filePath)),
  );

  server.registerTool(
    "graph_impact_analysis",
    {
      title: "Impact analysis",
      description:
        "Transitive closure of everything that depends on a symbol (via calls, inheritance, overrides, " +
        "DI injection), up to a hop limit — answers 'what would changing this symbol break', tagged " +
        "with hop distance. Capped at maxResults (default 100) with a `truncated` flag — on a " +
        "widely-used symbol this can still be a lot of hits, so if `truncated` is true, prefer a " +
        "smaller depth or a more specific symbol over raising maxResults.",
      inputSchema: {
        symbolId: z.string(),
        depth: z.number().int().positive().max(10).optional().describe("Max hops to traverse (default 3)"),
        maxResults: z.number().int().positive().max(500).optional().describe("Result cap (default 100)"),
      },
    },
    ({ symbolId, depth, maxResults }) => jsonResult(impactAnalysis(db, symbolId, depth, maxResults)),
  );

  server.registerTool(
    "graph_get_route_map",
    {
      title: "Get route map",
      description: "Every HTTP/router route discovered in the repo (ASP.NET Core attributes, Angular Routes arrays) mapped to its handler symbol.",
      inputSchema: {},
    },
    () => jsonResult(getRouteMap(db)),
  );

  server.registerTool(
    "graph_get_di_graph",
    {
      title: "Get DI graph",
      description: "Every dependency-injection registration discovered in the repo, mapped to the interface/implementation it registers.",
      inputSchema: {},
    },
    () => jsonResult(getDiGraph(db)),
  );

  server.registerTool(
    "graph_get_component_tree",
    {
      title: "Get component tree",
      description: "Every Angular/Aurelia component discovered in the repo, with the class members its template actually binds to.",
      inputSchema: {},
    },
    () => jsonResult(getComponentTree(db)),
  );

  server.registerTool(
    "graph_context_pack",
    {
      title: "Get context pack",
      description:
        "A deduplicated minimal subgraph (symbols + edges) reachable within N hops of one or more seed " +
        "symbols, in every edge direction and type. Meant to replace 'read N related files' with one " +
        "call when you already know a starting symbol (e.g. from graph_search_symbol) and want its " +
        "immediate neighborhood.",
      inputSchema: {
        seedSymbolIds: z.array(z.string()).min(1),
        hops: z.number().int().positive().max(5).optional().describe("Default 1"),
        maxSymbols: z.number().int().positive().max(1000).optional().describe("Truncation cap, default 200"),
      },
    },
    ({ seedSymbolIds, hops, maxSymbols }) => jsonResult(contextPack(db, seedSymbolIds, hops, maxSymbols)),
  );
}
