using SampleApi.Signaling;

namespace SampleApi.Api;

// Exercises SymbolGraphBuilder's SignalR PUBLISHES extraction: calls Send("eventName", data) on
// a receiver whose type name contains "SignalService", the shape of Genesis.SignalR.Services.
public sealed class VoyageStatusPublisher(ISignalService signalService)
{
    public void PublishVoyageStatusChanged(int voyageId)
    {
        signalService.Send("voyageStatusChanged", new { VoyageId = voyageId });
    }
}
