using Microsoft.AspNetCore.Mvc;

namespace ProducerApi;

// The route half of the workspace fixture: consumer-api calls this through an NSwag-shaped
// client, and the workspace resolver should join them by normalized verb+template — see
// packages/workspace-store's routeSymbolIdToKey.
[ApiController]
[Route("api/v1/[controller]")]
public class VesselController : ControllerBase
{
    [HttpGet("{id}")]
    public ActionResult<string> Get(int id)
    {
        return Ok($"vessel-{id}");
    }
}
