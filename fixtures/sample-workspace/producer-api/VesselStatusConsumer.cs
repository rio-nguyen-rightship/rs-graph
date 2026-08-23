using System.Threading.Tasks;

namespace ProducerApi;

// The message half of the workspace fixture, consuming direction: consumer-api publishes this
// message, producer-api consumes it — proving the join works even though each repo declares its
// own independent VesselStatusChangedMessage class.
public sealed class VesselStatusConsumer : IConsumer<VesselStatusChangedMessage>
{
    public Task Consume(VesselStatusChangedMessage message) => Task.CompletedTask;
}
