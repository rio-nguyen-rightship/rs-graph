namespace SampleApi.Domain;

// No explicit `using System.Threading.Tasks;` anywhere in this file — relies entirely on
// <ImplicitUsings>enable</ImplicitUsings>'s auto-generated global using. Regression fixture: MSBuild
// evaluation alone (no build target ever runs — see ProjectLoader's own doc comment) doesn't see
// that generated file, so without explicitly picking it up, Task<string> here resolves as an
// unresolvable error type and every call through IAsyncGreeter silently loses its CALLS edge.
public interface IAsyncGreeter
{
    Task<string> GreetAsync(string name);
}

public sealed class AsyncGreeter : IAsyncGreeter
{
    public Task<string> GreetAsync(string name) => Task.FromResult($"Hello async, {name}!");
}
