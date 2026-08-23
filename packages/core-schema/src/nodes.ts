/**
 * Unified graph node model. Every language indexer (indexer-dotnet, indexer-typescript, ...)
 * emits records in this shape as NDJSON; graph-store is the only package that translates
 * them into Kuzu node/rel tables (see ddl.ts for the matching DDL).
 */

export type Language = "csharp" | "typescript" | "python";

export type Framework =
  | "aspnetcore"
  | "angular"
  | "aurelia"
  | "flask"
  | "fastapi"
  | "django"
  | "unknown";

/** Declared or synthesized symbol kinds. Route/DIRegistration/MessageContract are synthesized
 * at a call-site or attribute location rather than a normal declaration, but still get a Symbol
 * row so every addressable thing in the graph is reachable through one table. MessageContract is
 * additionally cross-repo/cross-language stable by design: its id is a normalized
 * `xrepo:message:{TypeName}` key (see indexer-dotnet's MessageUtils / indexer-python's
 * message_utils), not a language-specific symbol id, since a Service Bus message's producer and
 * consumer(s) often live in different repos and sometimes different languages with no shared
 * compile-time reference — only the message type name in common. */
export type SymbolKind =
  | "Class"
  | "Interface"
  | "Enum"
  | "Struct"
  | "Method"
  | "Function"
  | "Property"
  | "Field"
  | "Variable"
  | "Component"
  | "Route"
  | "DIRegistration"
  | "MessageContract"
  | "HubEvent";

export interface FileNode {
  record: "file";
  /** Repo-relative, forward-slash path. Primary key. */
  path: string;
  language: Language;
  /** sha256 of file contents, used for incremental re-index diffing. */
  contentHash: string;
  sizeBytes: number;
}

export interface SymbolNode {
  record: "symbol";
  /** Stable id, e.g. `${language}:${path}#${startLine}:${startCol}:${name}`. */
  id: string;
  name: string;
  kind: SymbolKind;
  /** One-line rendered signature, e.g. `public Task<User> GetUser(int id)`. */
  signature: string;
  /** First line of doc-comment/XML-doc/JSDoc, if any. */
  docSummary?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  startCol?: number;
  endCol?: number;
  modifiers: string[];
  /** True when the symbol lives outside the repo (unresolved package reference,
   * or resolved-but-external metadata-only reference) — no body/members indexed. */
  external: boolean;
}

/** Angular/Aurelia component overlay — shares its id with the underlying Class SymbolNode. */
export interface ComponentNode {
  record: "component";
  /** Same id as the corresponding SymbolNode (kind: "Component"). */
  id: string;
  name: string;
  selector?: string;
  framework: Framework;
  templatePath?: string;
}

export type GraphNodeRecord = FileNode | SymbolNode | ComponentNode;
