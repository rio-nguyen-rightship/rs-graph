namespace RsGraph.Indexer.Dotnet;

/// <summary>Normalizes ASP.NET Core route templates and builds a Route Symbol's id from the
/// normalized verb+template, not the handling method — see SymbolGraphBuilder.EmitRoute. This
/// is what lets an external consumer (an NSwag-generated client method's [RouteUrl] attribute,
/// which only ever carries the path) compute a matching join key independently, without seeing
/// which method actually handles the route.</summary>
public static class RouteUtils
{
    public static string NormalizeTemplate(string template) => template.Trim('/').ToLowerInvariant();

    public static string BuildRouteId(string verb, string normalizedTemplate) =>
        $"csharp:route:{verb.ToUpperInvariant()}:{normalizedTemplate}";

    /// <summary>Join key for an INVOKES_ROUTE edge from an SDK-client call site — deliberately
    /// verb-less (a [RouteUrl] attribute only ever carries the path) and prefixed distinctly
    /// from real Symbol ids so a cross-repo resolver can recognize it as "not a local symbol" by
    /// prefix alone. Disambiguating against a producer's verb-qualified Route id when more than
    /// one verb shares this template is the cross-repo resolver's job, not this indexer's.</summary>
    public static string BuildCrossRepoRouteKey(string normalizedTemplate) => $"xrepo:route:{normalizedTemplate}";
}
