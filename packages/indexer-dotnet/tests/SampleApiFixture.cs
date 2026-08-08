using System.Diagnostics;
using System.Text.Json;

namespace RsGraph.Indexer.Dotnet.Tests;

/// <summary>
/// Restores and builds fixtures/sample-dotnet-api once, then runs the real indexer against it
/// once, sharing the parsed NDJSON records across every [Fact] in the test class (via
/// IClassFixture) rather than re-running MSBuild+Roslyn per test.
///
/// Restoring/building the fixture here is *our own* test data, not an arbitrary target repo —
/// the same trust boundary as restoring our own tool's dependencies (see the security note in
/// docs/architecture.md: the indexer itself still never does this for a repo being indexed).
/// </summary>
public sealed class SampleApiFixture : IAsyncLifetime
{
    public string RepoRoot { get; }
    public string SlnxPath { get; }
    public IReadOnlyList<JsonElement> Records { get; private set; } = [];

    public SampleApiFixture()
    {
        // AppContext.BaseDirectory is .../packages/indexer-dotnet/tests/bin/<Config>/<tfm>/
        var repoRoot = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));
        RepoRoot = Path.Combine(repoRoot, "fixtures", "sample-dotnet-api");
        SlnxPath = Path.Combine(RepoRoot, "SampleApi.slnx");
    }

    public async Task InitializeAsync()
    {
        MsBuildSetup.EnsureRegistered();
        // Explicit SlnxPath: the fixture directory now has a second .slnx (DomainOnly.slnx, for
        // testing rs-graph's --sln override), and a bare `dotnet restore`/`build` fails with an
        // ambiguity error once more than one project/solution file is present in the directory.
        await RunDotnetAsync($"restore \"{SlnxPath}\"");
        await RunDotnetAsync($"build \"{SlnxPath}\"");
        Records = RunIndexerAndParse();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private List<JsonElement> RunIndexerAndParse()
    {
        var stringWriter = new StringWriter();
        var originalOut = Console.Out;
        Console.SetOut(stringWriter);
        try
        {
            Runner.Run([SlnxPath, RepoRoot]);
        }
        finally
        {
            Console.SetOut(originalOut);
        }

        return stringWriter
            .ToString()
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonDocument.Parse(line).RootElement)
            .ToList();
    }

    private async Task RunDotnetAsync(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            WorkingDirectory = RepoRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start dotnet");
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"'dotnet {arguments}' failed in {RepoRoot}:\n{await stderrTask}");
        }
    }
}
