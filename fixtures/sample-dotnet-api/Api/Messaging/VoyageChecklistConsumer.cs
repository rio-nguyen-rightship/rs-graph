using System.Threading.Tasks;
using SampleApi.Messaging;

namespace SampleApi.Api;

// Exercises SymbolGraphBuilder's CONSUMES extraction: implements IConsumer<T>, the same shape as
// MassTransit's native consumer interface.
public sealed class VoyageChecklistConsumer : IConsumer<VoyageChecklistsGeneratedMessage>
{
    public Task Consume(VoyageChecklistsGeneratedMessage message) => Task.CompletedTask;
}
