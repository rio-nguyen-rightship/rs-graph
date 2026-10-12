using Microsoft.CodeAnalysis;

namespace RsGraph.Indexer.Dotnet;

/// <summary>Cheap health signal for a project's compilation, surfaced to `rs-graph doctor`. When
/// the indexer's references are incomplete (restore/build never ran, a missing implicit-usings
/// file, a package that didn't resolve) Roslyn can't bind the types in declarations and every
/// call/injection through them silently loses its edge — this counts exactly those declaration-
/// level "type or namespace not found"-class errors. Declaration diagnostics only (not a full
/// GetDiagnostics pass), so it adds almost no time to indexing.</summary>
public static class CompilationStats
{
    private static readonly HashSet<string> UnresolvedReferenceIds = ["CS0246", "CS0234", "CS0012", "CS0518"];

    public static int CountUnresolvedReferences(Compilation compilation, ISet<string> ownedFiles) =>
        compilation
            .GetDeclarationDiagnostics()
            .Count(d =>
                d.Severity == DiagnosticSeverity.Error
                && UnresolvedReferenceIds.Contains(d.Id)
                && d.Location.SourceTree?.FilePath is { } filePath
                && ownedFiles.Contains(filePath));
}
