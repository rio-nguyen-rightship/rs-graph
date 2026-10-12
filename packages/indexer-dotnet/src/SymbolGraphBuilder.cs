using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace RsGraph.Indexer.Dotnet;

/// <summary>
/// Walks one project's Compilation with its semantic model and emits FileRecord/SymbolRecord/
/// EdgeRecord NDJSON matching core-schema. Only trees "owned" by this project (its own Compile
/// items, not a sibling project's sources pulled in via CompilationReference) are processed,
/// so each source file is emitted exactly once across the whole multi-project run.
/// </summary>
public sealed class SymbolGraphBuilder(string repoRoot, NdjsonWriter writer, ExternalSymbolRegistry externalSymbols)
{
    private static readonly string[] HttpVerbAttributes = ["HttpGet", "HttpPost", "HttpPut", "HttpDelete", "HttpPatch"];
    private static readonly string[] DiRegistrationMethods = ["AddScoped", "AddSingleton", "AddTransient"];
    private static readonly string[] HttpClientVerbMethods = ["GetAsync", "PostAsync", "PutAsync", "DeleteAsync", "PatchAsync"];

    private readonly HashSet<string> _emittedFiles = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Guards every symbol id against being emitted twice in one run. Two real-world
    /// cases produce the same id string from a *different* declaration site: (1) a `partial`
    /// class/struct spanning multiple files — Roslyn merges all partial declarations into one
    /// symbol, so each file's declaration would otherwise trigger its own EmitType call,
    /// re-walking (and re-emitting) every member; (2) a source file linked/shared into more
    /// than one project — each project gets its own Compilation, so the same file is processed
    /// once per project, and BuildSymbolId (a rendered display string) produces an identical id
    /// both times even though the two ISymbol instances are distinct objects.</summary>
    private readonly HashSet<string> _emittedSymbolIds = new(StringComparer.Ordinal);

    private bool TryClaim(string id) => _emittedSymbolIds.Add(id);

    public void Process(CSharpCompilation compilation, IReadOnlySet<string> ownedFilePaths)
    {
        foreach (var tree in compilation.SyntaxTrees)
        {
            if (!ownedFilePaths.Contains(tree.FilePath)) continue;
            ProcessTree(compilation, tree);
        }
    }

    private void ProcessTree(CSharpCompilation compilation, SyntaxTree tree)
    {
        var relPath = ToRepoRelativePath(tree.FilePath);
        // A source file linked/shared into more than one project would otherwise be walked
        // once per project (each project gets its own Compilation) — skip the whole file
        // rather than just its FileRecord, since re-walking it a second time is pure waste
        // (every symbol in it is now also guarded individually via TryClaim, but there's no
        // reason to pay for a second semantic-model walk to find that out).
        if (!_emittedFiles.Add(relPath)) return;
        EmitFileRecord(tree.FilePath, relPath);

        var semanticModel = compilation.GetSemanticModel(tree);
        var root = tree.GetRoot();

        foreach (var typeDecl in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            if (semanticModel.GetDeclaredSymbol(typeDecl) is INamedTypeSymbol typeSymbol)
                EmitType(relPath, typeDecl, typeSymbol, semanticModel);
        }

        // Flat passes over the whole tree rather than per-method walks: GetEnclosingSymbol
        // correctly finds the containing method for calls made from ordinary methods, local
        // functions, lambdas, and top-level Program.cs statements alike, with one code path.
        EmitCallEdges(relPath, root, semanticModel);
        EmitDiRegistrations(relPath, root, semanticModel);
        EmitMessagingEdges(relPath, root, semanticModel);
        EmitSignalREdges(relPath, root, semanticModel);
    }

    private void EmitType(
        string relPath,
        BaseTypeDeclarationSyntax typeDecl,
        INamedTypeSymbol typeSymbol,
        SemanticModel semanticModel)
    {
        var typeId = SymbolUtils.BuildSymbolId(typeSymbol);
        if (!TryClaim(typeId)) return; // already emitted from another partial declaration / a shared file

        var span = typeDecl.GetLocation().GetLineSpan();

        writer.Write(new SymbolRecord
        {
            Id = typeId,
            Name = typeSymbol.Name,
            Kind = SymbolUtils.Map(typeSymbol),
            Signature = SymbolUtils.RenderSignature(typeSymbol),
            DocSummary = SymbolUtils.ExtractDocSummary(typeSymbol),
            FilePath = relPath,
            StartLine = span.StartLinePosition.Line + 1,
            EndLine = span.EndLinePosition.Line + 1,
            StartCol = span.StartLinePosition.Character + 1,
            EndCol = span.EndLinePosition.Character + 1,
            Modifiers = SymbolUtils.GetModifiers(typeSymbol),
            External = false,
        });
        writer.Write(new EdgeRecord { EdgeType = "DEFINES", From = relPath, To = typeId });

        if (typeSymbol.BaseType is { SpecialType: SpecialType.None, TypeKind: not TypeKind.Error } baseType)
        {
            EmitEdgeToPossiblyExternal("EXTENDS", typeId, baseType);
        }
        foreach (var iface in typeSymbol.Interfaces)
        {
            EmitEdgeToPossiblyExternal("IMPLEMENTS", typeId, iface);
            EmitInterfaceMemberImplementations(typeSymbol, iface);
        }

        var isController = IsControllerType(typeSymbol);
        var classRouteTemplate = isController ? GetRouteTemplate(typeSymbol, typeSymbol.Name) : null;

        foreach (var member in typeSymbol.GetMembers())
        {
            switch (member)
            {
                case IMethodSymbol { MethodKind: MethodKind.Ordinary or MethodKind.Constructor } method
                    when !method.IsImplicitlyDeclared:
                    EmitMethod(relPath, method, isController, classRouteTemplate);
                    break;
                case IPropertySymbol { IsImplicitlyDeclared: false } property:
                    EmitProperty(relPath, property);
                    break;
                case IFieldSymbol { IsImplicitlyDeclared: false } field:
                    EmitField(relPath, field);
                    break;
            }
        }
    }

    /// <summary>
    /// Emits a member-level IMPLEMENTS edge for each interface member this type provides an
    /// implementation for (`Concrete.Method IMPLEMENTS IInterface.Method`), on top of the
    /// class-level IMPLEMENTS edge already emitted by the caller.
    ///
    /// This closes a real gap: real C# overwhelmingly calls through interface-typed DI
    /// references (`private readonly IFoo _foo; ... _foo.Bar()`), so the semantic model
    /// resolves the call target to the *interface* method, not the concrete implementation —
    /// CALLS edges point at `IFoo.Bar`, never at `Concrete.Bar` directly. Without this edge,
    /// `graph_get_callers`/`graph_get_references` on the concrete method silently returns
    /// empty even when the method is heavily called, because graph-store's polymorphism-aware
    /// traversal (see queries.ts) needs this edge to know the two are the same call target.
    /// </summary>
    private void EmitInterfaceMemberImplementations(INamedTypeSymbol typeSymbol, INamedTypeSymbol iface)
    {
        foreach (var ifaceMember in iface.GetMembers())
        {
            if (ifaceMember is not (IMethodSymbol or IPropertySymbol)) continue;

            var implementation = typeSymbol.FindImplementationForInterfaceMember(ifaceMember);
            if (implementation is null) continue;

            var implementationId = ResolveSymbolId(implementation);
            var ifaceMemberId = ResolveSymbolId(ifaceMember);
            writer.Write(new EdgeRecord { EdgeType = "IMPLEMENTS", From = implementationId, To = ifaceMemberId });
        }
    }

    private void EmitMethod(string relPath, IMethodSymbol method, bool isController, string? classRouteTemplate)
    {
        var methodId = SymbolUtils.BuildSymbolId(method);
        if (!TryClaim(methodId)) return;

        var location = method.Locations.FirstOrDefault(l => l.IsInSource);
        var span = location?.GetLineSpan();

        writer.Write(new SymbolRecord
        {
            Id = methodId,
            Name = method.Name,
            Kind = "Method",
            Signature = SymbolUtils.RenderSignature(method),
            DocSummary = SymbolUtils.ExtractDocSummary(method),
            FilePath = relPath,
            StartLine = (span?.StartLinePosition.Line ?? 0) + 1,
            EndLine = (span?.EndLinePosition.Line ?? 0) + 1,
            StartCol = (span?.StartLinePosition.Character ?? 0) + 1,
            EndCol = (span?.EndLinePosition.Character ?? 0) + 1,
            Modifiers = SymbolUtils.GetModifiers(method),
            External = false,
        });
        writer.Write(new EdgeRecord { EdgeType = "DEFINES", From = relPath, To = methodId });

        if (method.IsOverride && method.OverriddenMethod is { } overridden)
        {
            EmitEdgeToPossiblyExternal("OVERRIDES", methodId, overridden);
        }

        if (method.MethodKind == MethodKind.Constructor)
        {
            foreach (var parameter in method.Parameters)
            {
                if (IsInjectableType(parameter.Type))
                {
                    EmitEdgeToPossiblyExternal("INJECTS", methodId, parameter.Type);
                }
            }
        }

        if (isController && GetHttpVerbAndRoute(method) is { } route)
        {
            EmitRoute(relPath, method, methodId, route.verb, CombineRoutes(classRouteTemplate, route.template));
        }
    }

    private void EmitRoute(string relPath, IMethodSymbol method, string methodId, string verb, string routeTemplate)
    {
        var routeId = RouteUtils.BuildRouteId(verb, RouteUtils.NormalizeTemplate(routeTemplate));
        if (!TryClaim(routeId)) return;

        var location = method.Locations.FirstOrDefault(l => l.IsInSource);
        var span = location?.GetLineSpan();

        writer.Write(new SymbolRecord
        {
            Id = routeId,
            Name = $"{verb} {routeTemplate}",
            Kind = "Route",
            Signature = $"[{verb}(\"{routeTemplate}\")]",
            FilePath = relPath,
            StartLine = (span?.StartLinePosition.Line ?? 0) + 1,
            EndLine = (span?.StartLinePosition.Line ?? 0) + 1,
            Modifiers = [],
            External = false,
        });
        writer.Write(new EdgeRecord { EdgeType = "DEFINES", From = relPath, To = routeId });
        writer.Write(new EdgeRecord { EdgeType = "ROUTES_TO", From = routeId, To = methodId });
    }

    private void EmitProperty(string relPath, IPropertySymbol property)
    {
        var id = SymbolUtils.BuildSymbolId(property);
        if (!TryClaim(id)) return;

        var location = property.Locations.FirstOrDefault(l => l.IsInSource);
        var span = location?.GetLineSpan();

        writer.Write(new SymbolRecord
        {
            Id = id,
            Name = property.Name,
            Kind = "Property",
            Signature = SymbolUtils.RenderSignature(property),
            DocSummary = SymbolUtils.ExtractDocSummary(property),
            FilePath = relPath,
            StartLine = (span?.StartLinePosition.Line ?? 0) + 1,
            EndLine = (span?.EndLinePosition.Line ?? 0) + 1,
            Modifiers = SymbolUtils.GetModifiers(property),
            External = false,
        });
        writer.Write(new EdgeRecord { EdgeType = "DEFINES", From = relPath, To = id });

        if (property.IsOverride && property.OverriddenProperty is { } overridden)
        {
            EmitEdgeToPossiblyExternal("OVERRIDES", id, overridden);
        }
    }

    private void EmitField(string relPath, IFieldSymbol field)
    {
        var id = SymbolUtils.BuildSymbolId(field);
        if (!TryClaim(id)) return;

        var location = field.Locations.FirstOrDefault(l => l.IsInSource);
        var span = location?.GetLineSpan();

        writer.Write(new SymbolRecord
        {
            Id = id,
            Name = field.Name,
            Kind = "Field",
            Signature = SymbolUtils.RenderSignature(field),
            DocSummary = SymbolUtils.ExtractDocSummary(field),
            FilePath = relPath,
            StartLine = (span?.StartLinePosition.Line ?? 0) + 1,
            EndLine = (span?.EndLinePosition.Line ?? 0) + 1,
            Modifiers = SymbolUtils.GetModifiers(field),
            External = false,
        });
        writer.Write(new EdgeRecord { EdgeType = "DEFINES", From = relPath, To = id });
    }

    private void EmitCallEdges(string relPath, SyntaxNode root, SemanticModel semanticModel)
    {
        foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var targetSymbol = semanticModel.GetSymbolInfo(invocation).Symbol as IMethodSymbol;
            if (targetSymbol is null) continue;

            if (semanticModel.GetEnclosingSymbol(invocation.SpanStart) is not IMethodSymbol containingMethod) continue;
            if (containingMethod.Locations.All(l => !l.IsInSource)) continue;

            var fromId = SymbolUtils.BuildSymbolId(containingMethod);
            var toId = ResolveSymbolId(targetSymbol);
            var lineSpan = invocation.GetLocation().GetLineSpan();

            writer.Write(new EdgeRecord
            {
                EdgeType = "CALLS",
                From = fromId,
                To = toId,
                Line = lineSpan.StartLinePosition.Line + 1,
                Col = lineSpan.StartLinePosition.Character + 1,
            });

            var routeUrlTemplate = GetRouteUrlTemplate(targetSymbol) ?? GetHttpClientCallTemplate(targetSymbol, invocation);
            if (routeUrlTemplate is not null)
            {
                writer.Write(new EdgeRecord
                {
                    EdgeType = "INVOKES_ROUTE",
                    From = fromId,
                    To = RouteUtils.BuildCrossRepoRouteKey(RouteUtils.NormalizeTemplate(routeUrlTemplate)),
                    Line = lineSpan.StartLinePosition.Line + 1,
                    Col = lineSpan.StartLinePosition.Character + 1,
                });
            }
        }
    }

    /// <summary>Detects a raw HttpClient call — no generated NSwag client, so no [RouteUrl]
    /// attribute to read — and extracts its URL argument, when it's simple enough to normalize
    /// reliably. SendAsync is deliberately not covered: its verb comes from an HttpRequestMessage
    /// argument, not the method name, which this indexer doesn't attempt to unpack.</summary>
    private static string? GetHttpClientCallTemplate(IMethodSymbol targetSymbol, InvocationExpressionSyntax invocation)
    {
        if (targetSymbol.ContainingType?.ToDisplayString() != "System.Net.Http.HttpClient") return null;
        if (Array.IndexOf(HttpClientVerbMethods, targetSymbol.Name) < 0) return null;

        var urlArgument = invocation.ArgumentList.Arguments.FirstOrDefault()?.Expression;
        return ExtractUrlTemplate(urlArgument);
    }

    /// <summary>Pulls a URL template out of a call argument: a plain string literal is used
    /// as-is; an interpolated string ($"...") has each {expr} slot collapsed to the same {}
    /// placeholder RouteUtils.NormalizeTemplate uses, since the caller's own local variable name
    /// (e.g. {vesselId}) has no reason to match the route's declared parameter name (e.g. {id}).
    /// Anything else — concatenation, a pre-built variable — is skipped rather than guessed at.</summary>
    private static string? ExtractUrlTemplate(ExpressionSyntax? expression)
    {
        switch (expression)
        {
            case LiteralExpressionSyntax lit when lit.IsKind(SyntaxKind.StringLiteralExpression):
                return lit.Token.ValueText;
            case InterpolatedStringExpressionSyntax interpolated:
                var sb = new StringBuilder();
                foreach (var content in interpolated.Contents)
                {
                    if (content is InterpolatedStringTextSyntax text) sb.Append(text.TextToken.ValueText);
                    else if (content is InterpolationSyntax) sb.Append("{}");
                }
                return sb.ToString();
            default:
                return null;
        }
    }

    /// <summary>Returns the path template from a [RouteUrl("...")] attribute — RightShip.ApiClient's
    /// NSwag-generated marker for "this client method proxies an HTTP call to this route" — checking
    /// both the method itself and, if it's a concrete implementation, the interface member it
    /// implements. NSwag emits the attribute on the generated interface; calling code commonly holds
    /// the client through that interface (constructor-injected, matching this codebase's general DI
    /// style), but checking the concrete method directly too costs nothing and covers the rest.</summary>
    private static string? GetRouteUrlTemplate(IMethodSymbol method)
    {
        if (GetRouteUrlAttributeTemplate(method) is { } direct) return direct;

        if (method.ContainingType is not { TypeKind: TypeKind.Class } containingType) return null;
        foreach (var iface in containingType.AllInterfaces)
        {
            foreach (var ifaceMember in iface.GetMembers().OfType<IMethodSymbol>())
            {
                if (!SymbolEqualityComparer.Default.Equals(
                        containingType.FindImplementationForInterfaceMember(ifaceMember), method))
                {
                    continue;
                }
                if (GetRouteUrlAttributeTemplate(ifaceMember) is { } viaInterface) return viaInterface;
            }
        }
        return null;
    }

    private static string? GetRouteUrlAttributeTemplate(IMethodSymbol method)
    {
        foreach (var attr in method.GetAttributes())
        {
            if (attr.AttributeClass?.Name != "RouteUrlAttribute") continue;
            if (attr.ConstructorArguments.FirstOrDefault().Value is string template) return template;
        }
        return null;
    }

    private void EmitDiRegistrations(string relPath, SyntaxNode root, SemanticModel semanticModel)
    {
        foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var name = invocation.Expression switch
            {
                MemberAccessExpressionSyntax { Name: GenericNameSyntax generic } => generic,
                GenericNameSyntax generic => generic,
                _ => null,
            };
            if (name is null || !DiRegistrationMethods.Contains(name.Identifier.Text)) continue;
            if (name.TypeArgumentList.Arguments.Count is not (1 or 2)) continue;

            var typeArgSymbols = name.TypeArgumentList.Arguments
                .Select(t => semanticModel.GetSymbolInfo(t).Symbol as ITypeSymbol)
                .ToArray();
            if (typeArgSymbols.Any(s => s is null)) continue;

            var serviceType = typeArgSymbols[0]!;
            var implType = typeArgSymbols.Length == 2 ? typeArgSymbols[1]! : typeArgSymbols[0]!;

            var lineSpan = invocation.GetLocation().GetLineSpan();
            var regId = $"csharp:diregistration:{relPath}:{lineSpan.StartLinePosition.Line + 1}:{lineSpan.StartLinePosition.Character + 1}";
            if (!TryClaim(regId)) continue; // same file processed under a second project (see _emittedSymbolIds)

            writer.Write(new SymbolRecord
            {
                Id = regId,
                Name = $"{name.Identifier.Text}<{serviceType.Name}, {implType.Name}>",
                Kind = "DIRegistration",
                Signature = invocation.ToString(),
                FilePath = relPath,
                StartLine = lineSpan.StartLinePosition.Line + 1,
                EndLine = lineSpan.EndLinePosition.Line + 1,
                Modifiers = [],
                External = false,
            });
            writer.Write(new EdgeRecord { EdgeType = "DEFINES", From = relPath, To = regId });
            writer.Write(new EdgeRecord { EdgeType = "REGISTERS", From = regId, To = ResolveSymbolId(implType) });
            if (!SymbolEqualityComparer.Default.Equals(serviceType, implType))
            {
                writer.Write(new EdgeRecord { EdgeType = "REGISTERS", From = regId, To = ResolveSymbolId(serviceType) });
            }
        }
    }

    /// <summary>Extracts cross-repo/cross-language Service Bus messaging edges: a producer call
    /// shaped like this org's internal `IMessageQueueService.EnqueueMessage(new T{...})` wrapper
    /// over MassTransit, and a consumer class implementing MassTransit's own `IConsumer&lt;T&gt;`.
    /// Both edge kinds target the same normalized `xrepo:message:{TypeName}` key regardless of
    /// whether T is a locally-declared, resolvable class — see MessageUtils and PublishesEdge/
    /// ConsumesEdge in core-schema for why the key is always name-based rather than a real
    /// Symbol id.</summary>
    private void EmitMessagingEdges(string relPath, SyntaxNode root, SemanticModel semanticModel)
    {
        foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (invocation.Expression is not MemberAccessExpressionSyntax { Name.Identifier.Text: "EnqueueMessage" }) continue;
            if (invocation.ArgumentList.Arguments.Count == 0) continue;

            var messageType = invocation.ArgumentList.Arguments[0].Expression switch
            {
                ObjectCreationExpressionSyntax creation => semanticModel.GetTypeInfo(creation).Type,
                _ => null,
            };
            if (messageType is null) continue;

            if (semanticModel.GetEnclosingSymbol(invocation.SpanStart) is not IMethodSymbol containingMethod) continue;
            if (containingMethod.Locations.All(l => !l.IsInSource)) continue;

            var messageKey = MessageUtils.BuildMessageKey(messageType.Name);
            var lineSpan = invocation.GetLocation().GetLineSpan();
            EmitMessageContractSymbol(messageKey, messageType.Name, relPath, lineSpan);
            writer.Write(new EdgeRecord
            {
                EdgeType = "PUBLISHES",
                From = SymbolUtils.BuildSymbolId(containingMethod),
                To = messageKey,
                Line = lineSpan.StartLinePosition.Line + 1,
                Col = lineSpan.StartLinePosition.Character + 1,
            });
        }

        foreach (var typeDecl in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            if (semanticModel.GetDeclaredSymbol(typeDecl) is not INamedTypeSymbol typeSymbol) continue;

            foreach (var iface in typeSymbol.AllInterfaces)
            {
                if (iface is not { Name: "IConsumer", TypeArguments.Length: 1 }) continue;

                var messageType = iface.TypeArguments[0];
                var messageKey = MessageUtils.BuildMessageKey(messageType.Name);
                var lineSpan = typeDecl.GetLocation().GetLineSpan();
                EmitMessageContractSymbol(messageKey, messageType.Name, relPath, lineSpan);
                writer.Write(new EdgeRecord
                {
                    EdgeType = "CONSUMES",
                    From = SymbolUtils.BuildSymbolId(typeSymbol),
                    To = messageKey,
                    Line = lineSpan.StartLinePosition.Line + 1,
                    Col = lineSpan.StartLinePosition.Character + 1,
                });
            }
        }
    }

    private void EmitMessageContractSymbol(string messageKey, string typeName, string relPath, FileLinePositionSpan lineSpan)
    {
        if (!TryClaim(messageKey)) return; // already emitted from an earlier publisher/consumer of the same type

        writer.Write(new SymbolRecord
        {
            Id = messageKey,
            Name = typeName,
            Kind = "MessageContract",
            Signature = typeName,
            FilePath = relPath,
            StartLine = lineSpan.StartLinePosition.Line + 1,
            EndLine = lineSpan.StartLinePosition.Line + 1,
            Modifiers = [],
            External = false,
        });
        writer.Write(new EdgeRecord { EdgeType = "DEFINES", From = relPath, To = messageKey });
    }

    /// <summary>Extracts cross-repo/cross-language SignalR edges: a broadcast call shaped like
    /// Genesis.SignalR's `ISignalService.Send("eventName", data)`/`SendToGroups(...)` (matched by
    /// method name + a receiver whose type name contains "SignalService", to avoid matching every
    /// unrelated `Send(...)` call in a codebase), and a class implementing `ISignalHubInterceptor`
    /// whose `InterceptorName` carries the dispatch name a client's `.invoke(...)` call routes to.
    /// Both target the normalized `xrepo:signal:{name}` key regardless of local resolvability —
    /// see SignalUtils and the messaging edges above for why.</summary>
    private void EmitSignalREdges(string relPath, SyntaxNode root, SemanticModel semanticModel)
    {
        foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess) continue;
            if (memberAccess.Name.Identifier.Text is not ("Send" or "SendToGroups")) continue;

            var receiverType = semanticModel.GetTypeInfo(memberAccess.Expression).Type;
            if (receiverType is null || !receiverType.Name.Contains("SignalService", StringComparison.Ordinal)) continue;

            var firstArg = invocation.ArgumentList.Arguments.FirstOrDefault()?.Expression;
            if (firstArg is not LiteralExpressionSyntax { Token.Value: string eventName }) continue;

            if (semanticModel.GetEnclosingSymbol(invocation.SpanStart) is not IMethodSymbol containingMethod) continue;
            if (containingMethod.Locations.All(l => !l.IsInSource)) continue;

            var signalKey = SignalUtils.BuildSignalKey(eventName);
            var lineSpan = invocation.GetLocation().GetLineSpan();
            EmitHubEventSymbol(signalKey, eventName, relPath, lineSpan);
            writer.Write(new EdgeRecord
            {
                EdgeType = "PUBLISHES",
                From = SymbolUtils.BuildSymbolId(containingMethod),
                To = signalKey,
                Line = lineSpan.StartLinePosition.Line + 1,
                Col = lineSpan.StartLinePosition.Character + 1,
            });
        }

        foreach (var typeDecl in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            if (semanticModel.GetDeclaredSymbol(typeDecl) is not INamedTypeSymbol typeSymbol) continue;
            if (!typeSymbol.AllInterfaces.Any(i => i.Name == "ISignalHubInterceptor")) continue;

            foreach (var member in typeSymbol.GetMembers("InterceptorName"))
            {
                var interceptorName = FindFirstStringLiteral(member);
                if (interceptorName is null) continue;

                var signalKey = SignalUtils.BuildSignalKey(interceptorName);
                var lineSpan = typeDecl.GetLocation().GetLineSpan();
                EmitHubEventSymbol(signalKey, interceptorName, relPath, lineSpan);
                writer.Write(new EdgeRecord
                {
                    EdgeType = "CONSUMES",
                    From = SymbolUtils.BuildSymbolId(typeSymbol),
                    To = signalKey,
                    Line = lineSpan.StartLinePosition.Line + 1,
                    Col = lineSpan.StartLinePosition.Character + 1,
                });
            }
        }
    }

    private static string? FindFirstStringLiteral(ISymbol member)
    {
        foreach (var syntaxRef in member.DeclaringSyntaxReferences)
        {
            var literal = syntaxRef.GetSyntax()
                .DescendantNodesAndSelf()
                .OfType<LiteralExpressionSyntax>()
                .FirstOrDefault(l => l.Token.Value is string);
            if (literal is not null) return (string)literal.Token.Value!;
        }
        return null;
    }

    private void EmitHubEventSymbol(string signalKey, string name, string relPath, FileLinePositionSpan lineSpan)
    {
        if (!TryClaim(signalKey)) return; // already emitted from an earlier publisher/consumer of the same event

        writer.Write(new SymbolRecord
        {
            Id = signalKey,
            Name = name,
            Kind = "HubEvent",
            Signature = name,
            FilePath = relPath,
            StartLine = lineSpan.StartLinePosition.Line + 1,
            EndLine = lineSpan.StartLinePosition.Line + 1,
            Modifiers = [],
            External = false,
        });
        writer.Write(new EdgeRecord { EdgeType = "DEFINES", From = relPath, To = signalKey });
    }

    private void EmitEdgeToPossiblyExternal(string edgeType, string fromId, ISymbol toSymbol)
    {
        writer.Write(new EdgeRecord { EdgeType = edgeType, From = fromId, To = ResolveSymbolId(toSymbol) });
    }

    /// <summary>Returns the stable id for a symbol, registering it as an external stub first
    /// if it isn't backed by any of our own source (see ExternalSymbolRegistry).</summary>
    private string ResolveSymbolId(ISymbol symbol)
    {
        var id = SymbolUtils.BuildSymbolId(symbol);
        if (!symbol.Locations.Any(l => l.IsInSource))
        {
            externalSymbols.GetOrRegister(symbol, id);
        }
        return id;
    }

    private static bool IsInjectableType(ITypeSymbol type) => type switch
    {
        INamedTypeSymbol { TypeKind: TypeKind.Interface } named => !IsSystemNamespace(named),
        INamedTypeSymbol { TypeKind: TypeKind.Class, SpecialType: SpecialType.None } named => !IsSystemNamespace(named),
        _ => false,
    };

    private static bool IsSystemNamespace(ISymbol symbol) =>
        symbol.ContainingNamespace?.ToDisplayString().StartsWith("System", StringComparison.Ordinal) ?? false;

    private static bool IsControllerType(INamedTypeSymbol type) =>
        type.Name.EndsWith("Controller", StringComparison.Ordinal) ||
        type.GetAttributes().Any(a => a.AttributeClass?.Name is "ApiControllerAttribute");

    /// <summary>
    /// A verb attribute and a route template are two separate pieces of information that real
    /// ASP.NET Core code very commonly splits across two separate attributes on the same method —
    /// `[HttpPost]` (no inline path) plus a sibling `[Route("AddSubtask")]` is at least as common
    /// as a single `[HttpGet("id")]` with an inline template. The previous version of this method
    /// returned as soon as it found *either* one, so whichever attribute Roslyn happened to
    /// enumerate first "won" and the other was silently ignored — a bare `[HttpPost]` encountered
    /// before its sibling `[Route(...)]` produced an empty template, and since a Route's Symbol id
    /// is built from (verb, template), every action reduced this way to the same (POST, "")
    /// pair collided on the same id and only the first one survived TryClaim's dedup. This is what
    /// made a real repo's route count look like 5 across 5,810 files instead of its real total.
    /// </summary>
    private static (string verb, string template)? GetHttpVerbAndRoute(IMethodSymbol method)
    {
        string? verb = null;
        string? verbTemplate = null;
        string? routeTemplate = null;

        foreach (var attr in method.GetAttributes())
        {
            var attrName = attr.AttributeClass?.Name;
            var matchedVerb = HttpVerbAttributes.FirstOrDefault(v => attrName == v + "Attribute");
            if (matchedVerb is not null)
            {
                verb = matchedVerb.Replace("Http", "").ToUpperInvariant();
                verbTemplate = attr.ConstructorArguments.FirstOrDefault().Value as string;
                continue;
            }
            if (attrName == "RouteAttribute")
            {
                routeTemplate = attr.ConstructorArguments.FirstOrDefault().Value as string;
            }
        }

        if (verb is null && routeTemplate is null) return null;
        // The verb attribute's own inline template wins when it has one (e.g. [HttpGet("id")]);
        // otherwise fall back to a sibling [Route("...")] attribute's template.
        var template = !string.IsNullOrEmpty(verbTemplate) ? verbTemplate! : routeTemplate ?? "";
        return (verb ?? "ROUTE", template);
    }

    private static string? GetRouteTemplate(INamedTypeSymbol type, string typeName)
    {
        foreach (var attr in type.GetAttributes())
        {
            if (attr.AttributeClass?.Name != "RouteAttribute") continue;
            var template = attr.ConstructorArguments.FirstOrDefault().Value as string;
            if (template is null) continue;
            var controllerName = typeName.EndsWith("Controller", StringComparison.Ordinal)
                ? typeName[..^"Controller".Length]
                : typeName;
            return template.Replace("[controller]", controllerName, StringComparison.OrdinalIgnoreCase);
        }
        return null;
    }

    private static string CombineRoutes(string? prefix, string template)
    {
        if (string.IsNullOrEmpty(prefix)) return template;
        if (string.IsNullOrEmpty(template)) return prefix;
        return $"{prefix.TrimEnd('/')}/{template.TrimStart('/')}";
    }

    private void EmitFileRecord(string absolutePath, string relPath)
    {
        var bytes = File.ReadAllBytes(absolutePath);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

        writer.Write(new FileRecord
        {
            Path = relPath,
            Language = "csharp",
            ContentHash = hash,
            SizeBytes = bytes.LongLength,
        });
    }

    private string ToRepoRelativePath(string absolutePath) =>
        Path.GetRelativePath(repoRoot, absolutePath).Replace('\\', '/');
}
