using Microsoft.Build.Evaluation;

namespace RsGraph.Indexer.Dotnet;

public sealed class LoadedProject
{
    public required string ProjectPath { get; init; }
    public required string AssemblyName { get; init; }
    public required string TargetFramework { get; init; }
    public required List<string> CompileItems { get; init; }
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

        var compileItems = project.GetItems("Compile")
            .Select(i => Path.GetFullPath(Path.Combine(project.DirectoryPath, i.EvaluatedInclude)))
            .Where(File.Exists)
            .Distinct()
            .ToList();

        var projectReferences = project.GetItems("ProjectReference")
            .Select(i => Path.GetFullPath(Path.Combine(project.DirectoryPath, i.EvaluatedInclude)))
            .Distinct()
            .ToList();

        var assemblyName = project.GetPropertyValue("AssemblyName");
        if (string.IsNullOrEmpty(assemblyName)) assemblyName = Path.GetFileNameWithoutExtension(csprojPath);

        var outputPath = Path.GetFullPath(Path.Combine(project.DirectoryPath, project.GetPropertyValue("OutputPath")));
        var intermediateOutputPath = Path.GetFullPath(
            Path.Combine(project.DirectoryPath, project.GetPropertyValue("IntermediateOutputPath")));

        return new LoadedProject
        {
            ProjectPath = csprojPath,
            AssemblyName = assemblyName,
            TargetFramework = targetFramework,
            CompileItems = compileItems,
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
}
