using System.Text.Json;
using Microsoft.CodeAnalysis;

namespace RsGraph.Indexer.Dotnet;

/// <summary>
/// Resolves MetadataReferences for a project WITHOUT ever running `dotnet restore`/`build`
/// (see docs/architecture.md's security note). Two sources, both read-only file access:
///   1. BCL reference assemblies from the .NET SDK's own installed ref packs (part of the
///      trusted local toolchain, not the target repo).
///   2. NuGet package compile-time assemblies already resolved by a *previous* `dotnet restore`
///      the developer ran, read straight out of `obj/project.assets.json` + the global
///      packages cache. If that file doesn't exist (never restored), this source is simply
///      empty — no restore is triggered to produce it.
/// `MetadataReference.CreateFromFile` only parses ECMA-335 metadata tables; it never loads or
/// executes the assembly, so this is safe even for third-party binaries.
/// </summary>
public static class ReferenceResolver
{
    public static List<MetadataReference> Resolve(LoadedProject project)
    {
        var refs = new List<MetadataReference>();
        var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void AddRef(string dllPath)
        {
            if (!seenPaths.Add(dllPath) || !File.Exists(dllPath)) return;
            try
            {
                refs.Add(MetadataReference.CreateFromFile(dllPath));
            }
            catch
            {
                // Unreadable/corrupt DLL — skip it rather than failing the whole indexing run.
            }
        }

        foreach (var dll in ResolveBclReferenceAssemblies(project.TargetFramework)) AddRef(dll);
        foreach (var dll in ResolveNuGetCompileReferences(project)) AddRef(dll);

        return refs;
    }

    // Both packs are tried unconditionally rather than only for detected ASP.NET Core
    // projects: referencing the extra assemblies is harmless even when unused (e.g. a shared
    // Domain library that isn't itself a web project can still reference
    // Microsoft.AspNetCore.Http types in a DTO), and skipping it silently produces confusing
    // "unresolved external" results for any MVC attribute (routes, [ApiController], etc.).
    private static readonly string[] FrameworkRefPackNames = ["Microsoft.NETCore.App.Ref", "Microsoft.AspNetCore.App.Ref"];

    private static IEnumerable<string> ResolveBclReferenceAssemblies(string targetFramework)
    {
        var dotnetRoot = FindDotnetRoot();
        var resolved = new List<string>();

        if (dotnetRoot is not null)
        {
            foreach (var packName in FrameworkRefPackNames)
            {
                var tfmDir = FindRefPackTfmDir(dotnetRoot, packName, targetFramework);
                if (tfmDir is not null) resolved.AddRange(Directory.EnumerateFiles(tfmDir, "*.dll"));
            }
        }

        if (resolved.Count > 0) return resolved;

        // Fallback: the shared runtime this indexer itself happens to be running on. Not a
        // precise match for the target TFM, but better than resolving nothing.
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        return runtimeDir is not null ? Directory.EnumerateFiles(runtimeDir, "*.dll") : [];
    }

    private static string? FindRefPackTfmDir(string dotnetRoot, string packName, string targetFramework)
    {
        var refPackRoot = Path.Combine(dotnetRoot, "packs", packName);
        if (!Directory.Exists(refPackRoot)) return null;
        foreach (var versionDir in Directory.EnumerateDirectories(refPackRoot).OrderByDescending(v => v))
        {
            var tfmDir = Path.Combine(versionDir, "ref", targetFramework);
            if (Directory.Exists(tfmDir)) return tfmDir;
        }
        return null;
    }

    private static string? FindDotnetRoot()
    {
        // .../dotnet/shared/Microsoft.NETCore.App/<version>/ -> .../dotnet/
        var dir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        for (var i = 0; i < 3 && dir is not null; i++) dir = Path.GetDirectoryName(dir);
        return dir;
    }

    private static IEnumerable<string> ResolveNuGetCompileReferences(LoadedProject project)
    {
        var projectDir = Path.GetDirectoryName(project.ProjectPath)!;
        var assetsPath = Path.Combine(projectDir, "obj", "project.assets.json");
        if (!File.Exists(assetsPath)) yield break;

        using var stream = File.OpenRead(assetsPath);
        using var doc = JsonDocument.Parse(stream);
        var root = doc.RootElement;

        if (!root.TryGetProperty("packageFolders", out var packageFoldersEl)) yield break;
        var packagesFolder = packageFoldersEl.EnumerateObject().Select(p => p.Name).FirstOrDefault();
        if (packagesFolder is null) yield break;

        if (!root.TryGetProperty("targets", out var targetsEl)) yield break;

        JsonElement? targetObj = null;
        foreach (var t in targetsEl.EnumerateObject())
        {
            if (t.Name.Equals(project.TargetFramework, StringComparison.OrdinalIgnoreCase) ||
                t.Name.StartsWith(project.TargetFramework + "/", StringComparison.OrdinalIgnoreCase))
            {
                targetObj = t.Value;
                break;
            }
        }
        if (targetObj is null) yield break;

        foreach (var package in targetObj.Value.EnumerateObject())
        {
            // Entry names look like "Newtonsoft.Json/13.0.3".
            var parts = package.Name.Split('/', 2);
            if (parts.Length != 2) continue;
            var (packageId, version) = (parts[0], parts[1]);

            if (!package.Value.TryGetProperty("compile", out var compileEl)) continue;
            foreach (var file in compileEl.EnumerateObject())
            {
                if (file.Name.EndsWith("_._", StringComparison.Ordinal)) continue; // "no compile-time assembly" marker
                var relPath = file.Name.Replace('/', Path.DirectorySeparatorChar);
                yield return Path.Combine(packagesFolder, packageId.ToLowerInvariant(), version, relPath);
            }
        }
    }
}
