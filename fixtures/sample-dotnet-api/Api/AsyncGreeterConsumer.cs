using SampleApi.Domain;

namespace SampleApi.Api;

// Exercises the ImplicitUsings-generated-file regression — see Domain/AsyncGreeter.cs. Not wired
// into DI/routing on purpose: this is a static-indexing fixture, never actually run.
public sealed class AsyncGreeterConsumer(IAsyncGreeter asyncGreeter)
{
    public Task<string> GreetAsync(string name) => asyncGreeter.GreetAsync(name);
}
