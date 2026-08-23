namespace ConsumerApi;

// Stand-in for this org's internal IMessageQueueService wrapper over MassTransit — not available
// here, but SymbolGraphBuilder matches it by member name/call shape.
public interface IMessageQueueService
{
    void EnqueueMessage<T>(T message);
}

// Declared independently from producer-api's own copy — see that repo's Messaging.cs.
public sealed class VesselStatusChangedMessage
{
    public int VesselId { get; set; }
}
