/**
 * Unified graph edge model. See nodes.ts for the node side and ddl.ts for the matching
 * Kuzu REL TABLE definitions.
 */

export type EdgeType =
  | "DEFINES"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "OVERRIDES"
  | "CALLS"
  | "REFERENCES"
  | "IMPORTS"
  | "INJECTS"
  | "ROUTES_TO"
  | "REGISTERS"
  | "BINDS_TEMPLATE";

interface EdgeBase<T extends EdgeType> {
  record: "edge";
  edgeType: T;
  /** Node id (File.path or Symbol/Component.id) that the edge starts from. */
  from: string;
  /** Node id the edge points to. */
  to: string;
}

/** File -> Symbol: the file declares this symbol. */
export type DefinesEdge = EdgeBase<"DEFINES">;

/** Symbol -> Symbol: class/interface inheritance, interface implementation, method override. */
export type ExtendsEdge = EdgeBase<"EXTENDS">;
export type ImplementsEdge = EdgeBase<"IMPLEMENTS">;
export type OverridesEdge = EdgeBase<"OVERRIDES">;

/** Symbol -> Symbol, with call-site location so references can be reported precisely. */
export interface CallsEdge extends EdgeBase<"CALLS"> {
  line: number;
  col?: number;
}

export interface ReferencesEdge extends EdgeBase<"REFERENCES"> {
  line: number;
  col?: number;
}

/** File -> File: module/namespace import. */
export type ImportsEdge = EdgeBase<"IMPORTS">;

/** Symbol -> Symbol: constructor/property dependency injection. */
export type InjectsEdge = EdgeBase<"INJECTS">;

/** Route Symbol -> handler Symbol. */
export type RoutesToEdge = EdgeBase<"ROUTES_TO">;

/** DIRegistration Symbol -> interface/impl Symbol being registered. */
export type RegistersEdge = EdgeBase<"REGISTERS">;

/** Component -> Symbol (class member) referenced from a template expression. */
export type BindsTemplateEdge = EdgeBase<"BINDS_TEMPLATE">;

export type GraphEdgeRecord =
  | DefinesEdge
  | ExtendsEdge
  | ImplementsEdge
  | OverridesEdge
  | CallsEdge
  | ReferencesEdge
  | ImportsEdge
  | InjectsEdge
  | RoutesToEdge
  | RegistersEdge
  | BindsTemplateEdge;
