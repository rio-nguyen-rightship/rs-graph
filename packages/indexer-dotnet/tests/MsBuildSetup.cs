using Microsoft.Build.Locator;

namespace RsGraph.Indexer.Dotnet.Tests;

/// <summary>MSBuildLocator.RegisterDefaults() may only run once per process — guard it so every
/// test fixture can call this without caring whether another fixture already did. xUnit
/// parallelizes across test classes by default, so a plain check-then-act on IsRegistered is a
/// real race: two fixtures' constructors can both see "not registered" and both call
/// RegisterDefaults(), and the loser fails with "MSBuild assemblies were already loaded" — Lazy's
/// own once-only guarantee (thread-safe by default) is what actually prevents that.</summary>
public static class MsBuildSetup
{
    private static readonly Lazy<bool> Registration = new(() =>
    {
        MSBuildLocator.RegisterDefaults();
        return true;
    });

    public static void EnsureRegistered() => _ = Registration.Value;
}
