using System.Text.Json;
using System.Text.Json.Serialization;

namespace RsGraph.Indexer.Dotnet;

/// <summary>Writes one JSON object per line to a TextWriter (stdout in practice) — the wire
/// format graph-store's ingester reads (see core-schema's ndjson.ts).</summary>
public sealed class NdjsonWriter(TextWriter writer)
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly object _lock = new();

    public void Write(object record)
    {
        var json = JsonSerializer.Serialize(record, record.GetType(), Options);
        lock (_lock)
        {
            writer.WriteLine(json);
        }
    }
}
