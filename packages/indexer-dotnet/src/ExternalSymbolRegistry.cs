using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;

namespace RsGraph.Indexer.Dotnet;

/// <summary>
/// Tracks symbols referenced from outside the set of source files we're compiling (unresolved
/// or externally-resolved package/BCL types) so every edge target has a corresponding Symbol
/// row with a readable name, per SymbolNode.external in core-schema.
///
/// Each external assembly gets one synthetic pseudo-File (path "external:&lt;AssemblyName&gt;")
/// whose contentHash is a hash of the *set* of external symbol ids seen this run — so
/// graph-store's idempotent ingest naturally refreshes that pseudo-file's stub Symbol rows
/// exactly when the set of known external symbols for that assembly changes, and leaves it
/// alone (a cheap no-op) otherwise.
/// </summary>
public sealed class ExternalSymbolRegistry
{
    private readonly Dictionary<string, HashSet<string>> _idsByAssembly = new();
    private readonly Dictionary<string, SymbolRecord> _recordsById = new();

    public string GetOrRegister(ISymbol symbol, string id)
    {
        if (_recordsById.ContainsKey(id)) return id;

        var assemblyName = symbol.ContainingAssembly?.Name ?? "unknown";
        var pseudoFile = $"external:{assemblyName}";

        if (!_idsByAssembly.TryGetValue(pseudoFile, out var ids))
        {
            ids = new HashSet<string>();
            _idsByAssembly[pseudoFile] = ids;
        }
        ids.Add(id);

        _recordsById[id] = new SymbolRecord
        {
            Id = id,
            Name = symbol.Name,
            Kind = SymbolUtils.Map(symbol),
            Signature = symbol.ToDisplayString(),
            FilePath = pseudoFile,
            StartLine = 0,
            EndLine = 0,
            Modifiers = [],
            External = true,
        };

        return id;
    }

    public void Flush(NdjsonWriter writer)
    {
        foreach (var (pseudoFile, ids) in _idsByAssembly)
        {
            var sortedIds = ids.OrderBy(x => x, StringComparer.Ordinal).ToArray();
            var contentHash = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', sortedIds)))).ToLowerInvariant();

            writer.Write(new FileRecord
            {
                Path = pseudoFile,
                Language = "csharp",
                ContentHash = contentHash,
                SizeBytes = 0,
            });

            foreach (var id in sortedIds)
            {
                writer.Write(_recordsById[id]);
                writer.Write(new EdgeRecord { EdgeType = "DEFINES", From = pseudoFile, To = id });
            }
        }
    }
}
