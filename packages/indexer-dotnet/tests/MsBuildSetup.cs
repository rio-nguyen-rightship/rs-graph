using Microsoft.Build.Locator;

namespace RsGraph.Indexer.Dotnet.Tests;

/// <summary>MSBuildLocator.RegisterDefaults() may only run once per process — guard it so every
/// test fixture can call this without caring whether another fixture already did.</summary>
public static class MsBuildSetup
{
    public static void EnsureRegistered()
    {
        if (!MSBuildLocator.IsRegistered)
        {
            MSBuildLocator.RegisterDefaults();
        }
    }
}
