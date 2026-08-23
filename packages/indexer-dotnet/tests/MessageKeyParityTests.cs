using System.Text.Json;

namespace RsGraph.Indexer.Dotnet.Tests;

/// <summary>
/// Guards MessageUtils.BuildMessageKey against drifting from indexer-python's
/// message_utils.build_message_key — both read the same fixtures/message-key-parity.json table,
/// so a change to one implementation without the other fails here instead of silently breaking
/// cross-repo/cross-language message-type resolution (see Milestone 4).
/// </summary>
public sealed class MessageKeyParityTests
{
    public static IEnumerable<object[]> ParityCases()
    {
        // AppContext.BaseDirectory is .../packages/indexer-dotnet/tests/bin/<Config>/<tfm>/
        var repoRoot = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));
        var json = File.ReadAllText(Path.Combine(repoRoot, "fixtures", "message-key-parity.json"));
        using var doc = JsonDocument.Parse(json);
        foreach (var entry in doc.RootElement.EnumerateArray())
        {
            yield return [entry.GetProperty("input").GetString()!, entry.GetProperty("expectedKey").GetString()!];
        }
    }

    [Theory]
    [MemberData(nameof(ParityCases))]
    public void BuildMessageKeyMatchesTheSharedParityTable(string input, string expectedKey)
    {
        Assert.Equal(expectedKey, MessageUtils.BuildMessageKey(input));
    }
}
