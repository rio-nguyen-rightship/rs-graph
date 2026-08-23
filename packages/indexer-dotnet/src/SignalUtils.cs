namespace RsGraph.Indexer.Dotnet;

/// <summary>Builds the cross-repo, cross-language join key for a SignalR event/interceptor name
/// — the discriminator string passed to Genesis.SignalR's ISignalService.Send/SendToGroups
/// (server broadcast) or exposed via an ISignalHubInterceptor.InterceptorName (client-invoked RPC
/// dispatch target), correlated against the same literal string a TypeScript/Angular client's
/// HubConnection .on/.subscribe/.invoke calls use — see indexer-typescript's emitSignalrEdges.
/// A separate `xrepo:signal:` namespace from MessageUtils' `xrepo:message:` so a Service Bus
/// message type and a SignalR event that happen to share a name never collide.</summary>
public static class SignalUtils
{
    public static string BuildSignalKey(string name) => $"xrepo:signal:{name}";
}
