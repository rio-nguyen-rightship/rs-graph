const ROUTE_PARAM_PATTERN = /\{[^}/]+\}/g;

/**
 * Mirrors indexer-dotnet's RouteUtils.NormalizeTemplate exactly: collapses every `{paramName}`
 * segment to a fixed placeholder before comparing, so a route matches by path *shape* rather than
 * needing an identical parameter name. A hand-written Angular HttpClient call's URL carries
 * whatever local variable name the caller chose (`vesselId`), which has no reason to match the
 * route's own declared parameter name (`id`) the way an NSwag-generated client's `[RouteUrl]`
 * does. Kept in lockstep with the C# side via fixtures/route-key-parity.json — see
 * routeKey.test.ts.
 */
export function normalizeRouteTemplate(template: string): string {
  const trimmed = template.replace(/^\/+|\/+$/g, "").toLowerCase();
  return trimmed.replace(ROUTE_PARAM_PATTERN, "{}");
}

/** Join key for an INVOKES_ROUTE edge — same `xrepo:route:{template}` prefix as
 * indexer-dotnet's RouteUtils.BuildCrossRepoRouteKey. */
export function buildCrossRepoRouteKey(normalizedTemplate: string): string {
  return `xrepo:route:${normalizedTemplate}`;
}
