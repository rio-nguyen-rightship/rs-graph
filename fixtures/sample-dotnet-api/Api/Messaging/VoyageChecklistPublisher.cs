using SampleApi.Messaging;

namespace SampleApi.Api;

// Exercises SymbolGraphBuilder's PUBLISHES extraction: calls EnqueueMessage(new T{...}), the
// same call shape as this org's internal IMessageQueueService wrapper over MassTransit.
public sealed class VoyageChecklistPublisher(IMessageQueueService messageQueueService)
{
    public void PublishVoyageChecklistsGenerated(int voyageId)
    {
        messageQueueService.EnqueueMessage(new VoyageChecklistsGeneratedMessage { VoyageId = voyageId });
    }
}
