"""Builds the cross-repo, cross-language join key for a Service Bus message type — the same key
indexer-dotnet's MessageUtils.BuildMessageKey computes for a C# contract class's bare name (this
org's own RightShip.EnclosedMessageType convention already correlates producer/consumer across
languages by the message type's *name*, not a shared compile-time reference). Kept in lockstep
with the C# implementation by a shared key-parity test table loaded by both this package's
pytest suite and indexer-dotnet's xUnit suite.
"""


def build_message_key(type_name):
    return f"xrepo:message:{type_name}"
