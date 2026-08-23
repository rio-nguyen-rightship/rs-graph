using System.Threading.Tasks;

namespace ConsumerApi;

// The actual cross-repo call sites: calls producer-api's route through the NSwag-shaped client
// above, and publishes the message producer-api's VesselStatusConsumer consumes.
public sealed class VesselOperations(IVesselApiClient vesselApiClient, IMessageQueueService messageQueueService)
{
    public Task<string> LookupVesselAsync(int vesselId) => vesselApiClient.GetAsync(vesselId);

    public void PublishVesselStatusChanged(int vesselId)
    {
        messageQueueService.EnqueueMessage(new VesselStatusChangedMessage { VesselId = vesselId });
    }
}
