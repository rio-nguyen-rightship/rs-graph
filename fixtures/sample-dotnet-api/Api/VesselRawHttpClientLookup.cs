using System.Net.Http;
using System.Threading.Tasks;

namespace SampleApi.Api;

// Exercises SymbolGraphBuilder's raw-HttpClient INVOKES_ROUTE extraction: a hand-written call
// (no generated NSwag client, so no [RouteUrl] attribute) through HttpClient.GetAsync with an
// interpolated URL — proving the edge gets emitted even without an attribute to read, and that
// the caller's own local variable name ({vesselId}) doesn't need to match a route's declared
// parameter name for the normalized key to come out right (see RouteUtils.NormalizeTemplate).
public sealed class VesselRawHttpClientLookup(HttpClient httpClient)
{
    public Task<HttpResponseMessage> LookupAsync(int vesselId) =>
        httpClient.GetAsync($"api/v1/Vessel/{vesselId}");
}
