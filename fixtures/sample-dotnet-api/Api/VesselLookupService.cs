using System.Threading.Tasks;
using SampleApi.Clients;

namespace SampleApi.Api;

// Exercises SymbolGraphBuilder's INVOKES_ROUTE extraction: calls through an NSwag-shaped client
// interface decorated with [RouteUrl], proving the cross-repo join-key edge gets emitted from
// the call site.
public sealed class VesselLookupService(IVesselApiClient vesselApiClient)
{
    public Task<string> LookupAsync(int vesselId) => vesselApiClient.GetVesselHeaderAsync(vesselId);
}
