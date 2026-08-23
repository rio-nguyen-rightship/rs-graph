namespace SampleApi.Signaling;

// Stand-ins for Genesis.SignalR's ISignalService (server broadcast) and ISignalHubInterceptor
// (the client-invoked RPC dispatch target) — not available here, but SymbolGraphBuilder matches
// both by method/interface name plus a literal string argument, so these exercise the same
// resolution path as the real ones.
public interface ISignalService
{
    void Send(string function, object data);
}

public sealed class SignalService : ISignalService
{
    public void Send(string function, object data) { }
}

public interface ISignalHubInterceptor
{
    string InterceptorName { get; }
}
