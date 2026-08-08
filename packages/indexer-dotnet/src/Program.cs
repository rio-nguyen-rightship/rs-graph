using Microsoft.Build.Locator;

namespace RsGraph.Indexer.Dotnet;

public static class Program
{
    public static int Main(string[] args)
    {
        // Must run before any type referencing Microsoft.Build.* is JIT-compiled, so the
        // actual MSBuild logic lives in Runner, invoked only after this registers the SDK's
        // own MSBuild toolset (avoids bundling/version-conflicting with our own copy).
        MSBuildLocator.RegisterDefaults();
        return Runner.Run(args);
    }
}
