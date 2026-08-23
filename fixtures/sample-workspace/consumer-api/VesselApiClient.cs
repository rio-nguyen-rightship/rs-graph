using System;
using System.Threading.Tasks;

namespace ConsumerApi;

// Stand-in for RightShip.ApiClient.Attributes.RouteUrl (see fixtures/sample-dotnet-api's own
// stand-in for the same thing) — an NSwag-generated client interface, one method per operation,
// decorated with the source route it proxies.
[AttributeUsage(AttributeTargets.Method)]
public sealed class RouteUrlAttribute : Attribute
{
    public RouteUrlAttribute(string template)
    {
        Template = template;
    }

    public string Template { get; }
}

public interface IVesselApiClient
{
    [RouteUrl("api/v1/Vessel/{id}")]
    Task<string> GetAsync(int id);
}

public sealed class VesselApiClient : IVesselApiClient
{
    public Task<string> GetAsync(int id) => Task.FromResult(string.Empty);
}
