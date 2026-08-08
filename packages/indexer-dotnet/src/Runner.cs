using Microsoft.Build.Evaluation;
using Microsoft.CodeAnalysis;
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
        var compilationsByProjectPath = new Dictionary<string, CSharpCompilation>(StringComparer.OrdinalIgnoreCase);

        foreach (var project in ordered)
        {
            var references = ReferenceResolver.Resolve(project);

            foreach (var refPath in project.ProjectReferences)
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

            var syntaxTrees = project.CompileItems
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
        }

        externalSymbols.Flush(writer);
        return 0;
    }

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
