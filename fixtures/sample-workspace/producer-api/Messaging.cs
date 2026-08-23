using System.Threading.Tasks;

namespace ProducerApi;

// Stand-in for MassTransit's IConsumer<T> — not available here, but SymbolGraphBuilder matches
// it by interface name/arity, so this exercises the same resolution path as the real one.
public interface IConsumer<T>
{
    Task Consume(T message);
}

// Declared independently in each repo (no shared assembly reference) — the message-key join is
// purely by type name, matching the real cross-repo/cross-language convention this models.
public sealed class VesselStatusChangedMessage
{
    public int VesselId { get; set; }
}
