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
}
