using Microsoft.Build.Evaluation;
using Microsoft.CodeAnalysis;
using System.Text.Json;
using Microsoft.CodeAnalysis.CSharp;

namespace RsGraph.Indexer.Dotnet;

public static class Runner
{
    public static int Run(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine(
                "usage: RsGraph.Indexer.Dotnet <path-to-.sln-or-.csproj-or-directory> [repoRoot]");
            return 1;
        }

        var targetPath = Path.GetFullPath(args[0]);
        var repoRoot = args.Length > 1
            ? Path.GetFullPath(args[1])
            : Directory.Exists(targetPath) ? targetPath : Path.GetDirectoryName(targetPath)!;

        var writer = new NdjsonWriter(Console.Out);
        var externalSymbols = new ExternalSymbolRegistry();
        var builder = new SymbolGraphBuilder(repoRoot, writer, externalSymbols);

        var csprojPaths = ProjectDiscovery.FindCsprojFiles(targetPath);
        if (csprojPaths.Count == 0)
        {
            Console.Error.WriteLine($"No .csproj files found under {targetPath}");
            return 0;
        }

        using var collection = new ProjectCollection();
        var loaded = csprojPaths
            .Select(p => ProjectLoader.Load(p, collection))
            .Where(p => p is not null)
            .Select(p => p!)
            .ToList();

        var ordered = ProjectLoader.TopologicalSort(loaded);
        var byPath = ordered.ToDictionary(p => p.ProjectPath, StringComparer.OrdinalIgnoreCase);
        var compilationsByProjectPath = new Dictionary<string, CSharpCompilation>(StringComparer.OrdinalIgnoreCase);
        // Shared across every project below — see ReferenceResolver.Resolve's doc comment for
        // why re-resolving the same BCL/NuGet dll into a fresh MetadataReference per project
        // breaks generic type resolution across project boundaries.
        var referenceCache = new Dictionary<string, MetadataReference>(StringComparer.OrdinalIgnoreCase);
        var unresolvedByProject = new List<(string Project, int Errors)>();

        foreach (var project in ordered)
        {
            var references = ReferenceResolver.Resolve(project, referenceCache);

            // Transitive, not just direct, references — see GetTransitiveProjectReferences.
            foreach (var refPath in ProjectLoader.GetTransitiveProjectReferences(project, byPath))
            {
                if (compilationsByProjectPath.TryGetValue(refPath, out var refCompilation))
                {
                    references.Add(refCompilation.ToMetadataReference());
                }
                else
                {
                    // Referenced project wasn't discovered/loadable this run — fall back to its
                    // already-built output DLL if one happens to exist. Read-only file access;
                    // never triggers a build.
                    var fallbackDll = TryFindOutputDll(refPath);
                    if (fallbackDll is not null) references.Add(MetadataReference.CreateFromFile(fallbackDll));
                }
            }

            // ImplicitUsingsFile joins the compilation (so its `global using` directives take
            // effect everywhere) but not `owned` below — see LoadedProject.ImplicitUsingsFile.
            var compileItemsWithImplicitUsings = project.ImplicitUsingsFile is { } implicitUsingsFile
                ? [.. project.CompileItems, implicitUsingsFile]
                : project.CompileItems;
            var syntaxTrees = compileItemsWithImplicitUsings
                .Select(path => CSharpSyntaxTree.ParseText(File.ReadAllText(path), path: path))
                .ToList<SyntaxTree>();

            var compilation = CSharpCompilation.Create(
                project.AssemblyName,
                syntaxTrees,
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

            compilationsByProjectPath[project.ProjectPath] = compilation;

            var owned = new HashSet<string>(project.CompileItems, StringComparer.OrdinalIgnoreCase);
            builder.Process(compilation, owned);
            unresolvedByProject.Add((project.AssemblyName, CompilationStats.CountUnresolvedReferences(compilation, owned)));
        }

        externalSymbols.Flush(writer);
        WriteStats(unresolvedByProject);
        return 0;
    }

    /// <summary>One machine-readable line on stderr (stdout is the NDJSON record stream); the CLI
    /// strips and parses it — see runDotnetIndexer in the CLI's indexRepo.ts.</summary>
    private static void WriteStats(List<(string Project, int Errors)> unresolvedByProject)
    {
        var stats = new
        {
            projects = unresolvedByProject.Count,
            unresolvedReferenceErrors = unresolvedByProject.Sum(p => p.Errors),
            worstProjects = unresolvedByProject
                .Where(p => p.Errors > 0)
                .OrderByDescending(p => p.Errors)
                .Take(5)
                .Select(p => new { project = p.Project, errors = p.Errors }),
        };
        Console.Error.WriteLine($"{StatsMarker}{JsonSerializer.Serialize(stats)}");
    }

    public const string StatsMarker = "RS_GRAPH_STATS ";

    private static string? TryFindOutputDll(string csprojPath)
    {
        var assemblyName = Path.GetFileNameWithoutExtension(csprojPath);
        var projectDir = Path.GetDirectoryName(csprojPath)!;
        var binDir = Path.Combine(projectDir, "bin");
        if (!Directory.Exists(binDir)) return null;
        return Directory
            .EnumerateFiles(binDir, $"{assemblyName}.dll", SearchOption.AllDirectories)
            .FirstOrDefault();
    }
}
