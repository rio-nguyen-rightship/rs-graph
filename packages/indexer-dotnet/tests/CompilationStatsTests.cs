using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace RsGraph.Indexer.Dotnet.Tests;

public sealed class CompilationStatsTests
{
    private static CSharpCompilation Compile(string source, string path = "A.cs") =>
        CSharpCompilation.Create(
            "Test",
            [CSharpSyntaxTree.ParseText(source, path: path)],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

    [Fact]
    public void CountsDeclarationsWhoseTypesCouldNotBeResolved()
    {
        // The rightstore failure shape: a signature naming a type the compilation can't see
        // (there, Task<> without its implicit `global using System.Threading.Tasks`).
        var compilation = Compile("public class A { public Task<int> M() => null!; public Missing P { get; } }");

        Assert.Equal(2, CompilationStats.CountUnresolvedReferences(compilation, new HashSet<string> { "A.cs" }));
    }

    [Fact]
    public void ReportsZeroForAFullyResolvedCompilation()
    {
        var compilation = Compile("public class A { public int M() => 1; public string P { get; } = \"\"; }");

        Assert.Equal(0, CompilationStats.CountUnresolvedReferences(compilation, new HashSet<string> { "A.cs" }));
    }

    [Fact]
    public void IgnoresErrorsInFilesTheProjectDoesNotOwn()
    {
        var compilation = Compile("public class A { public Missing P { get; } }", path: "obj/Generated.cs");

        Assert.Equal(0, CompilationStats.CountUnresolvedReferences(compilation, new HashSet<string> { "A.cs" }));
    }
}
