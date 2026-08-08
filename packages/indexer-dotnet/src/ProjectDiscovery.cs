using System.Xml.Linq;

namespace RsGraph.Indexer.Dotnet;

/// <summary>Finds .csproj files under a target path — accepts a .sln, a .csproj, or a
/// directory to search. Pure filesystem reads, no MSBuild involved yet (see ProjectLoader).</summary>
public static class ProjectDiscovery
{
    private static readonly HashSet<string> IgnoredDirNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "bin", "obj", "node_modules", ".git", ".vs", ".idea",
    };

    public static List<string> FindCsprojFiles(string rootPath)
    {
        if (File.Exists(rootPath))
        {
            if (rootPath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
                return [Path.GetFullPath(rootPath)];
            if (rootPath.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
                return ParseSlnForProjects(rootPath);
            if (rootPath.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase))
                return ParseSlnxForProjects(rootPath);
            return [];
        }

        var results = new List<string>();
        Walk(rootPath, results);
        return results;
    }

    private static void Walk(string dir, List<string> results)
    {
        IEnumerable<string> entries;
        try
        {
            entries = Directory.EnumerateFileSystemEntries(dir);
        }
        catch
        {
            return;
        }

        foreach (var entry in entries)
        {
            if (Directory.Exists(entry))
            {
                var name = Path.GetFileName(entry);
                if (name.StartsWith('.') || IgnoredDirNames.Contains(name)) continue;
                Walk(entry, results);
            }
            else if (entry.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                results.Add(Path.GetFullPath(entry));
            }
        }
    }

    /// <summary>Dependency-free .sln parser: matches the well-known
    /// <c>Project("{guid}") = "Name", "Relative\Path.csproj", "{guid}"</c> line shape.</summary>
    private static List<string> ParseSlnForProjects(string slnPath)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(slnPath))!;
        var results = new List<string>();
        foreach (var line in File.ReadLines(slnPath))
        {
            if (!line.StartsWith("Project(", StringComparison.Ordinal)) continue;
            var parts = line.Split(',');
            if (parts.Length < 2) continue;
            var relPath = parts[1].Trim().Trim('"');
            if (!relPath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) continue;
            var fullPath = Path.GetFullPath(Path.Combine(dir, relPath.Replace('\\', Path.DirectorySeparatorChar)));
            if (File.Exists(fullPath)) results.Add(fullPath);
        }
        return results;
    }

    /// <summary>Parses the newer XML-based .slnx format (`&lt;Project Path="Api/Api.csproj" /&gt;`),
    /// including nested &lt;Folder&gt; elements.</summary>
    private static List<string> ParseSlnxForProjects(string slnxPath)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(slnxPath))!;
        var results = new List<string>();
        var doc = XDocument.Load(slnxPath);
        foreach (var projectEl in doc.Descendants("Project"))
        {
            var relPath = projectEl.Attribute("Path")?.Value;
            if (relPath is null || !relPath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) continue;
            var fullPath = Path.GetFullPath(Path.Combine(dir, relPath.Replace('/', Path.DirectorySeparatorChar)));
            if (File.Exists(fullPath)) results.Add(fullPath);
        }
        return results;
    }
}
