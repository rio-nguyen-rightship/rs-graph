using Microsoft.Build.Evaluation;

namespace RsGraph.Indexer.Dotnet;

public sealed class LoadedProject
{
    public required string ProjectPath { get; init; }
    public required string AssemblyName { get; init; }
    public required string TargetFramework { get; init; }
    public required List<string> CompileItems { get; init; }
    /// <summary>The SDK's auto-generated implicit-usings file, if a prior real build already
    /// produced it — see ProjectLoader.Load's own comment. Fed to the compiler alongside
    /// CompileItems (so its `global using` directives take effect for name resolution across the
    /// whole compilation), but deliberately kept separate from CompileItems/the "owned" file set:
    /// it's compiler plumbing, not source the user wrote, and giving it a File/Symbol row at its
    /// odd obj/ path would only be graph noise.</summary>
    public string? ImplicitUsingsFile { get; init; }
    public required List<string> ProjectReferences { get; init; }
    /// <summary>Absolute path to the bin output directory, used only to resolve a sibling
    /// project's already-built DLL as a last resort (see ReferenceResolver) — never built by us.</summary>
    public required string OutputPath { get; init; }
    public required string IntermediateOutputPath { get; init; }
}

/// <summary>
/// Loads a .csproj via MSBuild <b>evaluation</b> only (Microsoft.Build.Evaluation.Project) —
/// this expands properties/items exactly like a real build would see them, but never invokes
/// a target (no Restore, no Build, no arbitrary MSBuild task execution). See the security
/// note in docs/architecture.md: this is the one place indexer-dotnet touches MSBuild, and
/// it is deliberately evaluation-only.
/// </summary>
public static class ProjectLoader
{
    public static LoadedProject? Load(string csprojPath, ProjectCollection collection)
    {
        Project project;
        try
        {
            project = collection.LoadProject(csprojPath);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"warn: could not evaluate {csprojPath}: {ex.Message}");
            return null;
        }

        var targetFramework = project.GetPropertyValue("TargetFramework");
        if (string.IsNullOrEmpty(targetFramework))
        {
            // Multi-targeted project ("<TargetFrameworks>net8.0;net472</TargetFrameworks>"):
            // the outer evaluation (no TargetFramework global property set) doesn't populate
            // Compile items/OutputPath the way a real per-TFM ("inner") build would. Re-evaluate
            // pinned to the first listed TFM so those items resolve properly.
            var frameworks = project.GetPropertyValue("TargetFrameworks");
            var first = frameworks
                .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .FirstOrDefault();
            if (first is not null)
            {
                collection.UnloadProject(project);
                project = collection.LoadProject(
                    csprojPath,
                    new Dictionary<string, string> { ["TargetFramework"] = first },
                    toolsVersion: null);
                targetFramework = first;
            }
        }

        var intermediateOutputPath = Path.GetFullPath(
            Path.Combine(project.DirectoryPath, project.GetPropertyValue("IntermediateOutputPath")));

        var compileItems = project.GetItems("Compile")
            .Select(i => Path.GetFullPath(Path.Combine(project.DirectoryPath, i.EvaluatedInclude)))
            .Where(File.Exists)
            .Distinct()
            .ToList();

        // <ImplicitUsings>enable</ImplicitUsings> adds this file to @(Compile) via a build
        // target, not at plain evaluation time (obj/ is excluded from the default Compile glob,
        // and evaluation alone — no target ever runs here, see this class's own doc comment —
        // never sees it). If a real `dotnet build`/`restore` already generated it, read it: any
        // file relying on an implicit `global using` (a bare `Task<T>` with no explicit
        // `using System.Threading.Tasks;`, say) would otherwise silently fail to resolve, and
        // every call/injection through such a type loses its edge with nothing surfaced to the
        // user — a real repo hit this for an entire fully-async service interface. Kept out of
        // compileItems itself (see ImplicitUsingsFile) so it never becomes an "owned" file.
        var globalUsingsPath = Path.Combine(intermediateOutputPath, $"{Path.GetFileNameWithoutExtension(csprojPath)}.GlobalUsings.g.cs");
        var implicitUsingsFile = File.Exists(globalUsingsPath) ? globalUsingsPath : null;

        var projectReferences = project.GetItems("ProjectReference")
            .Select(i => Path.GetFullPath(Path.Combine(project.DirectoryPath, i.EvaluatedInclude)))
            .Distinct()
            .ToList();

        var assemblyName = project.GetPropertyValue("AssemblyName");
        if (string.IsNullOrEmpty(assemblyName)) assemblyName = Path.GetFileNameWithoutExtension(csprojPath);

        var outputPath = Path.GetFullPath(Path.Combine(project.DirectoryPath, project.GetPropertyValue("OutputPath")));

        return new LoadedProject
        {
            ProjectPath = csprojPath,
            AssemblyName = assemblyName,
            TargetFramework = targetFramework,
            CompileItems = compileItems,
            ImplicitUsingsFile = implicitUsingsFile,
            ProjectReferences = projectReferences,
            OutputPath = outputPath,
            IntermediateOutputPath = intermediateOutputPath,
        };
    }

    /// <summary>Topologically sorts by ProjectReference so each project's dependencies are
    /// compiled before it (needed so we can pass already-built sibling Compilations in as
    /// references instead of requiring a prior `dotnet build`). Cycles (invalid in MSBuild
    /// anyway) are broken arbitrarily rather than throwing, so one bad solution can't crash
    /// the whole indexing run.</summary>
    public static List<LoadedProject> TopologicalSort(List<LoadedProject> projects)
    {
        var byPath = projects.ToDictionary(p => p.ProjectPath, StringComparer.OrdinalIgnoreCase);
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var visiting = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<LoadedProject>();

        void Visit(LoadedProject p)
        {
            if (visited.Contains(p.ProjectPath) || !visiting.Add(p.ProjectPath)) return;
            foreach (var refPath in p.ProjectReferences)
            {
                if (byPath.TryGetValue(refPath, out var refProject)) Visit(refProject);
            }
            visiting.Remove(p.ProjectPath);
            visited.Add(p.ProjectPath);
            result.Add(p);
        }

        foreach (var p in projects) Visit(p);
        return result;
    }

    /// <summary>Full transitive closure of a project's ProjectReferences. A real `dotnet build`
    /// gives every project this automatically (SDK-style ProjectReference flows transitively —
    /// referencing A which references B hands you B's public API too, no direct reference to B
    /// needed), but this indexer builds each CSharpCompilation by hand and only ever wired up
    /// direct references — so a type used by name two hops away (e.g. RightStore.Api using a
    /// RightStore.Api.Models DTO that only RightStore.Services, not RightStore.Api itself,
    /// references directly) came back as an unresolved/error type in RightStore.Api's own
    /// compilation. That silently breaks every call whose signature involves such a type:
    /// GetSymbolInfo returns null for the whole invocation, so no CALLS/INJECTS edge is emitted
    /// and no error is ever surfaced — a real repo's graph_get_callers/graph_get_references can
    /// come back empty for a method that plainly has callers in the source.</summary>
    public static List<string> GetTransitiveProjectReferences(LoadedProject project, IReadOnlyDictionary<string, LoadedProject> byPath)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<string>(project.ProjectReferences);

        while (queue.Count > 0)
        {
            var path = queue.Dequeue();
            if (!seen.Add(path)) continue;
            if (byPath.TryGetValue(path, out var referenced))
            {
                foreach (var transitive in referenced.ProjectReferences) queue.Enqueue(transitive);
            }
        }

        return [.. seen];
    }
}
