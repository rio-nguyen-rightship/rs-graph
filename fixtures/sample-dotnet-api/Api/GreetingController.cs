using Microsoft.AspNetCore.Mvc;
using SampleApi.Domain;

namespace SampleApi.Api;

[ApiController]
[Route("api/[controller]")]
public class GreetingController : ControllerBase
{
    private readonly IGreeter _greeter;

    public GreetingController(IGreeter greeter)
    {
        _greeter = greeter;
    }

    [HttpGet("{name}")]
    public ActionResult<string> Get(string name)
    {
        return Ok(_greeter.Greet(name));
    }

    // Shares the exact same combined route template ("api/Greeting/{name}") as Get above, but
    // under a different verb — fixture for the RouteUtils.BuildRouteId regression test, proving
    // Route symbol ids are keyed off {verb}:{template} rather than the handling method.
    [HttpPost("{name}")]
    public ActionResult<string> Post(string name)
    {
        return Ok(_greeter.Greet(name));
    }

    // Verb and route template split across two separate attributes — a bare [HttpDelete] with no
    // inline path, plus a sibling [Route(...)] supplying the path. At least as common in real
    // ASP.NET Core code as a single attribute carrying both. Fixture for the regression where
    // GetHttpVerbAndRoute used to return on whichever attribute it saw first, silently dropping
    // whichever of {verb, template} came from the other one.
    [HttpDelete]
    [Route("{name}")]
    public ActionResult<string> Delete(string name)
    {
        return NoContent();
    }
}
