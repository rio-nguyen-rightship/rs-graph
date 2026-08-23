namespace RsGraph.Indexer.Dotnet;

/// <summary>Builds the cross-repo, cross-language join key for a Service Bus message type — the
/// same key a Python producer computes from a bare string literal argument (this org's own
/// RightShip.EnclosedMessageType convention already correlates producer/consumer across
/// languages by the message type's *name*, not a shared compile-time reference), see
/// indexer-python's message_utils.py for the matching implementation. Kept in lockstep by a
/// shared key-parity test table loaded by both the xUnit and pytest suites.</summary>
public static class MessageUtils
{
    public static string BuildMessageKey(string typeName) => $"xrepo:message:{typeName}";
}
