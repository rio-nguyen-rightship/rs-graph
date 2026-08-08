using System.Xml.Linq;
using Microsoft.CodeAnalysis;

namespace RsGraph.Indexer.Dotnet;

/// <summary>Shared helpers for turning a Roslyn ISymbol into our wire format: a stable id,
/// a one-line signature, the doc-comment summary, and our SymbolKind string.</summary>
public static class SymbolUtils
{
    // Fully-qualified with parameter types, so overloads and same-named types in different
    // namespaces get distinct, stable ids independent of file location (surviving reformatting
    // and line-shifting, which matters for idempotent re-indexing — see graph-store's
    // contentHash-keyed upsert).
    private static readonly SymbolDisplayFormat IdFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Included,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeContainingType,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    private static readonly SymbolDisplayFormat SignatureFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameOnly,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        memberOptions: SymbolDisplayMemberOptions.IncludeParameters
            | SymbolDisplayMemberOptions.IncludeType
            | SymbolDisplayMemberOptions.IncludeAccessibility
            | SymbolDisplayMemberOptions.IncludeModifiers,
        parameterOptions: SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName,
        propertyStyle: SymbolDisplayPropertyStyle.ShowReadWriteDescriptor);

    public static string BuildSymbolId(ISymbol symbol) => "csharp:" + symbol.OriginalDefinition.ToDisplayString(IdFormat);

    public static string RenderSignature(ISymbol symbol) => symbol.ToDisplayString(SignatureFormat);

    public static string? ExtractDocSummary(ISymbol symbol)
    {
        var xml = symbol.GetDocumentationCommentXml();
        if (string.IsNullOrWhiteSpace(xml)) return null;
        try
        {
            var doc = XDocument.Parse(xml);
            var summary = doc.Descendants("summary").FirstOrDefault()?.Value;
            return summary
                ?.Split('\n')
                .Select(l => l.Trim())
                .FirstOrDefault(l => l.Length > 0);
        }
        catch (System.Xml.XmlException)
        {
            return null;
        }
    }

    public static string Map(ISymbol symbol) => symbol switch
    {
        INamedTypeSymbol { TypeKind: TypeKind.Interface } => "Interface",
        INamedTypeSymbol { TypeKind: TypeKind.Struct } => "Struct",
        INamedTypeSymbol { TypeKind: TypeKind.Enum } => "Enum",
        INamedTypeSymbol => "Class",
        IMethodSymbol => "Method",
        IPropertySymbol => "Property",
        IFieldSymbol => "Field",
        _ => "Variable",
    };

    public static string[] GetModifiers(ISymbol symbol)
    {
        var modifiers = new List<string> { symbol.DeclaredAccessibility.ToString().ToLowerInvariant() };
        if (symbol.IsStatic) modifiers.Add("static");
        if (symbol.IsAbstract) modifiers.Add("abstract");
        if (symbol.IsSealed) modifiers.Add("sealed");
        if (symbol.IsOverride) modifiers.Add("override");
        if (symbol.IsVirtual) modifiers.Add("virtual");
        return modifiers.ToArray();
    }
}
