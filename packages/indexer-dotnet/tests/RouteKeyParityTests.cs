using System.Text.Json;

namespace RsGraph.Indexer.Dotnet.Tests;

/// <summary>
/// Guards RouteUtils.NormalizeTemplate/BuildCrossRepoRouteKey against drifting from
/// indexer-typescript's routeKey.ts equivalent — both read the same
/// fixtures/route-key-parity.json table, so a change to one implementation without the other
/// fails here instead of silently breaking cross-repo route resolution between a C# producer
/// and a TypeScript (Angular HttpClient) consumer, or vice versa.
/// </summary>
public sealed class RouteKeyParityTests
{
    public static IEnumerable<object[]> ParityCases()
    {
        // AppContext.BaseDirectory is .../packages/indexer-dotnet/tests/bin/<Config>/<tfm>/
        var repoRoot = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));
        var json = File.ReadAllText(Path.Combine(repoRoot, "fixtures", "route-key-parity.json"));
        using var doc = JsonDocument.Parse(json);
        foreach (var entry in doc.RootElement.EnumerateArray())
        {
            yield return [entry.GetProperty("input").GetString()!, entry.GetProperty("expectedKey").GetString()!];
        }
    }

    [Theory]
    [MemberData(nameof(ParityCases))]
    public void NormalizeAndBuildKeyMatchesTheSharedParityTable(string input, string expectedKey)
    {
        Assert.Equal(expectedKey, RouteUtils.BuildCrossRepoRouteKey(RouteUtils.NormalizeTemplate(input)));
    }
}
