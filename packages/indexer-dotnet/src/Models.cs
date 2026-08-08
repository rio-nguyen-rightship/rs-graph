namespace RsGraph.Indexer.Dotnet;

/// <summary>
/// NDJSON wire records mirroring packages/core-schema/src/{nodes,edges}.ts. Field names are
/// camelCased by NdjsonWriter's JsonSerializerOptions to match the TS side exactly.
/// </summary>
public sealed class FileRecord
{
    public string Record => "file";
    public required string Path { get; init; }
    public required string Language { get; init; }
    public required string ContentHash { get; init; }
    public required long SizeBytes { get; init; }
}

public sealed class SymbolRecord
{
    public string Record => "symbol";
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Kind { get; init; }
    public required string Signature { get; init; }
    public string? DocSummary { get; init; }
    public required string FilePath { get; init; }
    public required int StartLine { get; init; }
    public required int EndLine { get; init; }
    public int? StartCol { get; init; }
    public int? EndCol { get; init; }
    public required string[] Modifiers { get; init; }
    public required bool External { get; init; }
}

public sealed class ComponentRecord
{
    public string Record => "component";
    public required string Id { get; init; }
    public required string Name { get; init; }
    public string? Selector { get; init; }
    public required string Framework { get; init; }
    public string? TemplatePath { get; init; }
}

public sealed class EdgeRecord
{
    public string Record => "edge";
    public required string EdgeType { get; init; }
    public required string From { get; init; }
    public required string To { get; init; }
    public int? Line { get; init; }
    public int? Col { get; init; }
}
