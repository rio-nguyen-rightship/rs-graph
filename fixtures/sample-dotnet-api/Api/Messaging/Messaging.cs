using System.Threading.Tasks;

namespace SampleApi.Messaging;

// Stand-ins for MassTransit's IConsumer<T> and this org's internal IMessageQueueService wrapper
// (RightShip.ServiceBus's real IMessageQueueService.EnqueueMessage<T>() over MassTransit) — not
// available here, but SymbolGraphBuilder matches both by name/shape, so these exercise the same
// resolution path as the real ones.
public interface IConsumer<T>
{
    Task Consume(T message);
}

public interface IMessageQueueService
{
    void EnqueueMessage<T>(T message);
}

public sealed class VoyageChecklistsGeneratedMessage
{
    public int VoyageId { get; set; }
}
