using System;
using System.Threading.Tasks;

namespace SampleApi.Clients;

// Stand-in for RightShip.ApiClient.Attributes.RouteUrl (an internal NuGet package used by the
// real repos this fixture models — not available here). Roslyn resolves attributes by the
// resolved AttributeClass regardless of which assembly declares it, and SymbolGraphBuilder
// matches RouteUrl by short name the same way it already matches framework attributes like
// [HttpGet]/[Route] — so a locally declared attribute with the same name exercises the same
// resolution path as the real one.
[AttributeUsage(AttributeTargets.Method)]
public sealed class RouteUrlAttribute : Attribute
{
    public RouteUrlAttribute(string template)
    {
        Template = template;
    }

    public string Template { get; }
}

// Shaped like an NSwag-generated client interface (see e.g. RightShipQi.ApiClients\Generated\
// RightShipVesselApiClient.cs in the real repos this models): one method per API operation,
// decorated with the source route it proxies.
public interface IVesselApiClient
{
    [RouteUrl("api/v1/Vessel/GetVesselHeader/{vesselId}")]
    Task<string> GetVesselHeaderAsync(int vesselId);
}

public sealed class VesselApiClient : IVesselApiClient
{
    public Task<string> GetVesselHeaderAsync(int vesselId) => Task.FromResult(string.Empty);
}
