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
  | "BINDS_TEMPLATE"
  | "INVOKES_ROUTE"
  | "PUBLISHES"
  | "CONSUMES";

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

/**
 * Symbol -> cross-repo join key: a call through a generated SDK client method (e.g. an NSwag
 * client decorated with RightShip.ApiClient's [RouteUrl("...")]) to the route it proxies. `to`
 * is not a real Symbol id — no indexer run sees the producing repo — it's a normalized,
 * verb-less `xrepo:route:{template}` key (see indexer-dotnet's RouteUtils.BuildCrossRepoRouteKey)
 * that a cross-repo resolver matches against producing repos' verb-qualified Route symbol ids.
 */
export interface InvokesRouteEdge extends EdgeBase<"INVOKES_ROUTE"> {
  line: number;
  col?: number;
}

/**
 * Symbol -> MessageContract: a method/function publishes (PUBLISHES) or handles (CONSUMES) a
 * Service Bus message type. `to` is always the normalized `xrepo:message:{TypeName}` join key
 * (see indexer-dotnet's MessageUtils / indexer-python's message_utils) even when the message
 * contract class is locally declared and resolvable — producer and consumer(s) are often in
 * different repos/languages with no shared compile-time reference, only the type name in
 * common, so both edge kinds target the same name-based key uniformly rather than sometimes a
 * real Symbol id and sometimes not.
 */
export interface PublishesEdge extends EdgeBase<"PUBLISHES"> {
  line: number;
  col?: number;
}
export interface ConsumesEdge extends EdgeBase<"CONSUMES"> {
  line: number;
  col?: number;
}

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
  | BindsTemplateEdge
  | InvokesRouteEdge
  | PublishesEdge
  | ConsumesEdge;
