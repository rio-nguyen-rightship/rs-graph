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
import { detailParam, projectReferenceHit, projectSymbol, projectWithDepth } from "./detail.js";
import { errorResult, jsonResult } from "./toolResult.js";

/** Shared by every tool below that takes "a symbol" as input, alongside graph_get_definition —
 * lets a caller pass filePath+line instead of a symbolId. Matters because compact search/list
 * results (see detail.ts) no longer carry the (often very long, for an overloaded C# method) id
 * string by default; filePath+startLine is already right there in every compact result, so a
 * caller can jump straight into graph_get_references/callers/callees/impact_analysis/
 * class_hierarchy on a specific hit without a round trip through graph_get_definition first just
 * to obtain its id. */
const symbolRefArgs = {
  symbolId: z.string().optional().describe("A symbol id, e.g. from graph_search_symbol or graph_get_file_outline"),
  filePath: z.string().optional().describe("Alternative to symbolId: a repo-relative file path"),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Alternative to symbolId: a line within filePath — resolves to whatever symbol's span " +
        "contains it. Must be a line actually inside a declaration (e.g. one from " +
        "graph_get_file_outline's startLine/endLine) — line 1 is almost never inside one, since " +
        "real files start with imports/usings/a namespace declaration before the first symbol.",
    ),
};

function noSymbolAtLocationError(filePath: string, line: number): string {
  return (
    `No symbol found at ${filePath}:${line} — this line isn't inside any declaration's span ` +
    "(line 1 rarely is; files typically start with imports/usings first). Call " +
    "graph_get_file_outline on this file to get a real startLine to use instead."
  );
}

function resolveSymbolId(
  db: GraphDb,
  args: { symbolId?: string; filePath?: string; line?: number },
): { id: string } | { error: string } {
  if (args.symbolId) return { id: args.symbolId };
  if (args.filePath && args.line) {
    const symbol = getDefinitionAtLocation(db, args.filePath, args.line);
    if (!symbol) return { error: noSymbolAtLocationError(args.filePath, args.line) };
    return { id: symbol.id };
  }
  return { error: "Provide either symbolId or filePath+line" };
}

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
  "MessageContract",
  "HubEvent",
]);

/** Registers every rs-graph MCP tool against an already-open graph database. Kept as one
 * function (rather than a class) since every tool is a thin, stateless wrapper over a
 * graph-store query function — there's no shared mutable state to justify more structure. */
export function registerTools(server: McpServer, db: GraphDb): void {
  const pageArgs = {
    limit: z.number().int().positive().max(500).optional(),
    offset: z.number().int().nonnegative().optional(),
  };

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
        "instead of grepping the repo. Prefer scope: 'name' when you know the identifier you want — " +
        "the default searches signature/doc text too, which also matches any symbol that merely " +
        "references your query as a parameter/return type (e.g. searching 'Foo' can also return an " +
        "unrelated method whose signature happens to take a Foo argument).",
      inputSchema: {
        query: z.string().describe("FTS5 match expression, e.g. a name or 'name*' prefix"),
        kind: SYMBOL_KIND.optional().describe("Restrict to one symbol kind"),
        language: z.string().optional().describe("Restrict to one language, e.g. 'csharp' or 'typescript'"),
        limit: z.number().int().positive().max(200).optional(),
        scope: z
          .enum(["name", "any"])
          .optional()
          .describe(
            "'any' (default): matches name, signature, and doc text. 'name': matches only the " +
              "symbol's own name — more precise, fewer incidental hits, and cheaper (fewer results to pay " +
              "the per-result token cost for).",
          ),
        detail: detailParam,
      },
    },
    ({ query, kind, language, limit, scope, detail }) =>
      jsonResult(searchSymbol(db, { query, kind, language, limit, scope }).map((s) => projectSymbol(s, detail))),
  );

  server.registerTool(
    "graph_get_file_outline",
    {
      title: "File outline",
      description:
        "Lists every symbol declared in a file (name, kind, line range) without reading the file's " +
        "source — use this instead of Read when you only need to know a file's public surface. Compact " +
        "by default (see the `detail` param) — a large file can declare a lot of symbols, and " +
        "signature/docSummary for every one of them adds up fast. Capped at limit (default 200) with " +
        "a `truncated` flag — a generated file (an API client, in one real case) can declare " +
        "thousands of symbols.",
      inputSchema: { filePath: z.string().describe("Repo-relative file path"), ...pageArgs, detail: detailParam },
    },
    ({ filePath, limit, offset, detail }) => {
      const outline = getFileOutline(db, filePath, { limit, offset });
      return jsonResult({ symbols: outline.symbols.map((s) => projectSymbol(s, detail)), truncated: outline.truncated });
    },
  );

  server.registerTool(
    "graph_get_definition",
    {
      title: "Get definition",
      description:
        "Resolves a symbol's declaration (signature, doc summary, exact location). Pass either " +
        "symbolId, or filePath+line to resolve whatever symbol's span contains that line.",
      inputSchema: symbolRefArgs,
    },
    ({ symbolId, filePath, line }) => {
      if (symbolId) {
        const symbol = getSymbolById(db, symbolId);
        return symbol ? jsonResult(symbol) : errorResult(`No symbol found with id ${symbolId}`);
      }
      if (filePath && line) {
        const symbol = getDefinitionAtLocation(db, filePath, line);
        return symbol ? jsonResult(symbol) : errorResult(noSymbolAtLocationError(filePath, line));
      }
      return errorResult("Provide either symbolId or filePath+line");
    },
  );

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
      inputSchema: { ...symbolRefArgs, ...pageArgs, detail: detailParam },
    },
    ({ symbolId, filePath, line, limit, offset, detail }) => {
      const resolved = resolveSymbolId(db, { symbolId, filePath, line });
      if ("error" in resolved) return errorResult(resolved.error);
      return jsonResult(getReferences(db, resolved.id, { limit, offset }).map((hit) => projectReferenceHit(hit, detail)));
    },
  );

  server.registerTool(
    "graph_get_callers",
    {
      title: "Get callers",
      description:
        "Every symbol that calls the given symbol (one hop up the call graph). Polymorphism-aware " +
        "(see graph_get_references) — includes calls made through an interface/base type this " +
        "symbol implements or overrides, not just direct calls to this exact symbol.",
      inputSchema: { ...symbolRefArgs, ...pageArgs, detail: detailParam },
    },
    ({ symbolId, filePath, line, limit, offset, detail }) => {
      const resolved = resolveSymbolId(db, { symbolId, filePath, line });
      if ("error" in resolved) return errorResult(resolved.error);
      return jsonResult(getCallers(db, resolved.id, { limit, offset }).map((hit) => projectReferenceHit(hit, detail)));
    },
  );

  server.registerTool(
    "graph_get_callees",
    {
      title: "Get callees",
      description: "Every symbol the given symbol calls (one hop down the call graph).",
      inputSchema: { ...symbolRefArgs, ...pageArgs, detail: detailParam },
    },
    ({ symbolId, filePath, line, limit, offset, detail }) => {
      const resolved = resolveSymbolId(db, { symbolId, filePath, line });
      if ("error" in resolved) return errorResult(resolved.error);
      return jsonResult(getCallees(db, resolved.id, { limit, offset }).map((hit) => projectReferenceHit(hit, detail)));
    },
  );

  server.registerTool(
    "graph_get_class_hierarchy",
    {
      title: "Get class hierarchy",
      description:
        "Ancestors (base classes/interfaces, transitively) and descendants (subclasses/implementations) " +
        "of a class or interface symbol, each tagged with hop depth.",
      inputSchema: { ...symbolRefArgs, detail: detailParam },
    },
    ({ symbolId, filePath, line, detail }) => {
      const resolved = resolveSymbolId(db, { symbolId, filePath, line });
      if ("error" in resolved) return errorResult(resolved.error);
      const hierarchy = getClassHierarchy(db, resolved.id);
      return jsonResult({
        ancestors: hierarchy.ancestors.map((s) => projectWithDepth(s, detail)),
        descendants: hierarchy.descendants.map((s) => projectWithDepth(s, detail)),
      });
    },
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
        ...symbolRefArgs,
        depth: z.number().int().positive().max(10).optional().describe("Max hops to traverse (default 3)"),
        maxResults: z.number().int().positive().max(500).optional().describe("Result cap (default 100)"),
        detail: detailParam,
      },
    },
    ({ symbolId, filePath, line, depth, maxResults, detail }) => {
      const resolved = resolveSymbolId(db, { symbolId, filePath, line });
      if ("error" in resolved) return errorResult(resolved.error);
      const result = impactAnalysis(db, resolved.id, depth, maxResults);
      return jsonResult({ symbols: result.symbols.map((s) => projectWithDepth(s, detail)), truncated: result.truncated });
    },
  );

  server.registerTool(
    "graph_get_route_map",
    {
      title: "Get route map",
      description:
        "Every HTTP/router route discovered in the repo (ASP.NET Core attributes, Angular Routes arrays) " +
        "mapped to its handler symbol. Capped at limit (default 200) with a `truncated` flag.",
      inputSchema: { ...pageArgs, detail: detailParam },
    },
    ({ limit, offset, detail }) => {
      const result = getRouteMap(db, { limit, offset });
      return jsonResult({
        routes: result.routes.map((r) => ({
          route: projectSymbol(r.route, detail),
          handler: r.handler ? projectSymbol(r.handler, detail) : null,
        })),
        truncated: result.truncated,
      });
    },
  );

  server.registerTool(
    "graph_get_di_graph",
    {
      title: "Get DI graph",
      description:
        "Every dependency-injection registration discovered in the repo, mapped to the interface/" +
        "implementation it registers. Capped at limit (default 200) with a `truncated` flag.",
      inputSchema: { ...pageArgs, detail: detailParam },
    },
    ({ limit, offset, detail }) => {
      const result = getDiGraph(db, { limit, offset });
      return jsonResult({
        registrations: result.registrations.map((r) => ({
          registration: projectSymbol(r.registration, detail),
          target: r.target ? projectSymbol(r.target, detail) : null,
        })),
        truncated: result.truncated,
      });
    },
  );

  server.registerTool(
    "graph_get_component_tree",
    {
      title: "Get component tree",
      description:
        "Every Angular/Aurelia component discovered in the repo, with the class members its template " +
        "actually binds to — or pass componentId for just one component's bindings, which is usually " +
        "what you actually want and skips the list entirely. Two independent caps, each with its own " +
        "`truncated` signal: limit (default 15, max 50) bounds how many components come back, and " +
        "maxBoundSymbols (default 15, max 50) bounds how many bound members come back per component — " +
        "a single template-heavy component (a big form, in practice) can bind to far more members " +
        "than a typical one, so capping only the component count doesn't bound a single row's own " +
        "size. Raising both at once against a real app can still produce a very large response; " +
        "prefer componentId, or raise one cap at a time.",
      inputSchema: {
        componentId: z.string().optional().describe("Fetch just this one component's bindings, ignoring limit/offset"),
        limit: z.number().int().positive().max(50).optional(),
        offset: z.number().int().nonnegative().optional(),
        maxBoundSymbols: z.number().int().positive().max(50).optional(),
        detail: detailParam,
      },
    },
    ({ componentId, limit, offset, maxBoundSymbols, detail }) => {
      const result = getComponentTree(db, { componentId, limit, offset, maxBoundSymbols });
      return jsonResult({
        components: result.components.map((c) => ({
          component: c.component,
          boundSymbols: c.boundSymbols.map((s) => projectSymbol(s, detail)),
          boundSymbolsTruncated: c.boundSymbolsTruncated,
        })),
        truncated: result.truncated,
      });
    },
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
        detail: detailParam,
      },
    },
    ({ seedSymbolIds, hops, maxSymbols, detail }) => {
      const pack = contextPack(db, seedSymbolIds, hops, maxSymbols);
      return jsonResult({
        symbols: pack.symbols.map((s) => projectSymbol(s, detail)),
        edges: pack.edges,
        truncated: pack.truncated,
      });
    },
  );
}
