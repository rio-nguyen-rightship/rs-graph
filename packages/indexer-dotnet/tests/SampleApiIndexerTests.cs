using System.Text.Json;

namespace RsGraph.Indexer.Dotnet.Tests;

public sealed class SampleApiIndexerTests(SampleApiFixture fixture) : IClassFixture<SampleApiFixture>
{
    private IReadOnlyList<JsonElement> Records => fixture.Records;

    private static bool Is(JsonElement r, string recordType) => r.GetProperty("record").GetString() == recordType;

    private JsonElement GetSymbol(string id) =>
        Assert.Single(Records, r => Is(r, "symbol") && r.GetProperty("id").GetString() == id);

    private bool HasEdge(string edgeType, string from, string to) =>
        Records.Any(r =>
            Is(r, "edge") &&
            r.GetProperty("edgeType").GetString() == edgeType &&
            r.GetProperty("from").GetString() == from &&
            r.GetProperty("to").GetString() == to);

    [Fact]
    public void EmitsFileRecordsForEveryCsFileInTheFixture()
    {
        var filePaths = Records.Where(r => Is(r, "file")).Select(r => r.GetProperty("path").GetString()).ToList();
        Assert.Contains("Domain/IGreeter.cs", filePaths);
        Assert.Contains("Domain/Greeter.cs", filePaths);
        Assert.Contains("Api/GreetingController.cs", filePaths);
        Assert.Contains("Api/Program.cs", filePaths);
    }

    [Fact]
    public void PartialClassSpanningTwoFilesIsEmittedExactlyOnceWithMembersFromBoth()
    {
        // Regression test for a real crash: Greeter is `partial`, split across Greeter.cs and
        // Greeter.Diagnostics.cs. Roslyn merges both declarations into one symbol, so without
        // SymbolGraphBuilder's _emittedSymbolIds guard, walking each file separately emitted
        // the class (and re-walked all its members) once per partial file, producing a
        // duplicate "csharp:global::SampleApi.Domain.Greeter" row that crashed graph-store's
        // ingest with a SQLite UNIQUE constraint violation.
        var filePaths = Records.Where(r => Is(r, "file")).Select(r => r.GetProperty("path").GetString()).ToList();
        Assert.Contains("Domain/Greeter.cs", filePaths);
        Assert.Contains("Domain/Greeter.Diagnostics.cs", filePaths);

        // GetSymbol itself asserts exactly one match — this alone would fail on the old bug.
        GetSymbol("csharp:global::SampleApi.Domain.Greeter");

        // Members declared in *either* partial file must both be present.
        GetSymbol("csharp:global::SampleApi.Domain.Greeter.BuildMessage(string)");
        GetSymbol("csharp:global::SampleApi.Domain.Greeter.Describe()");
    }

    [Fact]
    public void GreeterImplementsIGreeterAcrossProjectBoundary()
    {
        var greeter = GetSymbol("csharp:global::SampleApi.Domain.Greeter");
        Assert.Equal("Class", greeter.GetProperty("kind").GetString());
        Assert.False(greeter.GetProperty("external").GetBoolean());

        Assert.True(HasEdge(
            "IMPLEMENTS",
            "csharp:global::SampleApi.Domain.Greeter",
            "csharp:global::SampleApi.Domain.IGreeter"));
    }

    [Fact]
    public void EmitsMethodLevelImplementsEdgeSoConcreteMethodCallersResolveThroughTheInterface()
    {
        // Regression test for a real-world bug: every real call site injects IGreeter (not
        // Greeter) and calls through that interface reference, so Roslyn resolves the CALLS
        // edge to IGreeter.Greet, never to Greeter.Greet directly. Without this member-level
        // IMPLEMENTS edge, graph_get_callers on the concrete method silently returned empty
        // even though the method is genuinely called — graph-store's polymorphism-aware
        // traversal (queries.ts) depends on this edge existing to bridge the two.
        Assert.True(HasEdge(
            "IMPLEMENTS",
            "csharp:global::SampleApi.Domain.Greeter.Greet(string)",
            "csharp:global::SampleApi.Domain.IGreeter.Greet(string)"));
    }

    [Fact]
    public void IGreeterHasDocSummaryFromXmlDocComment()
    {
        var iGreeter = GetSymbol("csharp:global::SampleApi.Domain.IGreeter");
        Assert.Equal("Greets a named visitor.", iGreeter.GetProperty("docSummary").GetString());
    }

    [Fact]
    public void ControllerCallsInterfaceMethodAcrossProjectBoundary()
    {
        // The Api project's controller calls the Domain project's IGreeter.Greet — this only
        // resolves correctly because Runner builds a real multi-project Compilation graph
        // (CSharpCompilationReference between projects) rather than compiling each project in
        // isolation against bin output.
        Assert.True(HasEdge(
            "CALLS",
            "csharp:global::SampleApi.Api.GreetingController.Get(string)",
            "csharp:global::SampleApi.Domain.IGreeter.Greet(string)"));
    }

    [Fact]
    public void ControllerBaseIsMarkedExternalWithAReadableName()
    {
        var controllerBase = Assert.Single(
            Records,
            r => Is(r, "symbol") &&
                r.GetProperty("name").GetString() == "ControllerBase" &&
                r.TryGetProperty("external", out var ext) &&
                ext.GetBoolean());
        Assert.Equal("Class", controllerBase.GetProperty("kind").GetString());
    }

    [Fact]
    public void ExtractsRouteMappedToControllerAction()
    {
        var route = Assert.Single(
            Records,
            r => Is(r, "symbol") && r.GetProperty("kind").GetString() == "Route" &&
                r.GetProperty("name").GetString() == "GET api/Greeting/{name}");

        Assert.True(HasEdge(
            "ROUTES_TO",
            route.GetProperty("id").GetString()!,
            "csharp:global::SampleApi.Api.GreetingController.Get(string)"));
    }

    [Fact]
    public void TwoActionsSharingARouteTemplateUnderDifferentVerbsGetDistinctRouteSymbols()
    {
        // Regression test: Route symbol ids used to be keyed off the handling method
        // (csharp:route:{methodId}), so two actions registered under the exact same route
        // template but different HTTP verbs never collided only by accident — every method
        // already has its own unique id regardless of its route. Now that RouteUtils.BuildRouteId
        // keys the id off {verb}:{normalizedTemplate} instead (so an external NSwag client's
        // [RouteUrl], which only ever sees the template, can compute a matching join key), this
        // proves the fix still produces two distinct, correctly-linked Route symbols rather than
        // one silently claiming the other's id.
        var getRoute = Assert.Single(
            Records,
            r => Is(r, "symbol") && r.GetProperty("kind").GetString() == "Route" &&
                r.GetProperty("name").GetString() == "GET api/Greeting/{name}");
        var postRoute = Assert.Single(
            Records,
            r => Is(r, "symbol") && r.GetProperty("kind").GetString() == "Route" &&
                r.GetProperty("name").GetString() == "POST api/Greeting/{name}");

        Assert.NotEqual(getRoute.GetProperty("id").GetString(), postRoute.GetProperty("id").GetString());

        Assert.True(HasEdge(
            "ROUTES_TO",
            getRoute.GetProperty("id").GetString()!,
            "csharp:global::SampleApi.Api.GreetingController.Get(string)"));
        Assert.True(HasEdge(
            "ROUTES_TO",
            postRoute.GetProperty("id").GetString()!,
            "csharp:global::SampleApi.Api.GreetingController.Post(string)"));
    }

    [Fact]
    public void VerbAttributeAndSeparateRouteAttributeOnTheSameMethodAreBothPickedUp()
    {
        // Regression test: GetHttpVerbAndRoute used to return on whichever attribute it saw
        // first — [HttpDelete] (no inline path) and [Route("{name}")] are two separate
        // attributes on Delete(), and real ASP.NET Core code splits verb/template across two
        // attributes like this at least as often as it uses a single [HttpGet("id")]-style
        // attribute. The bug either dropped the template entirely (verb attribute seen first) or
        // mislabeled the verb as the literal string "ROUTE" (Route attribute seen first).
        var deleteRoute = Assert.Single(
            Records,
            r => Is(r, "symbol") && r.GetProperty("kind").GetString() == "Route" &&
                r.GetProperty("name").GetString() == "DELETE api/Greeting/{name}");

        Assert.True(HasEdge(
            "ROUTES_TO",
            deleteRoute.GetProperty("id").GetString()!,
            "csharp:global::SampleApi.Api.GreetingController.Delete(string)"));
    }

    [Fact]
    public void ExtractsDiRegistrationForBothInterfaceAndImplementation()
    {
        var registration = Assert.Single(Records, r => Is(r, "symbol") && r.GetProperty("kind").GetString() == "DIRegistration");
        var registrationId = registration.GetProperty("id").GetString()!;

        Assert.True(HasEdge("REGISTERS", registrationId, "csharp:global::SampleApi.Domain.Greeter"));
        Assert.True(HasEdge("REGISTERS", registrationId, "csharp:global::SampleApi.Domain.IGreeter"));
    }

    [Fact]
    public void ExtractsConstructorInjectionOfIGreeter()
    {
        Assert.True(HasEdge(
            "INJECTS",
            "csharp:global::SampleApi.Api.GreetingController.GreetingController(global::SampleApi.Domain.IGreeter)",
            "csharp:global::SampleApi.Domain.IGreeter"));
    }

    [Fact]
    public void ExtractsInvokesRouteEdgeFromAnNSwagShapedClientCallSite()
    {
        // VesselLookupService calls IVesselApiClient.GetVesselHeaderAsync, which is decorated
        // with a locally-declared stand-in for RightShip.ApiClient's [RouteUrl("...")] — Roslyn
        // resolves attributes by name regardless of which assembly declares them, so this
        // exercises the same path the real internal NuGet attribute would. The edge target is a
        // verb-less, normalized cross-repo join key (RouteUtils.BuildCrossRepoRouteKey), not a
        // real Symbol id — no Symbol row for it exists in this fixture's own graph. The `{}`
        // placeholder (not `{vesselid}`) is deliberate — see RouteUtils.NormalizeTemplate: routes
        // match by path shape, not by the route parameter's own name, since a hand-written
        // HttpClient call site's local variable name never has any reason to match it.
        Assert.True(HasEdge(
            "INVOKES_ROUTE",
            "csharp:global::SampleApi.Api.VesselLookupService.LookupAsync(int)",
            "xrepo:route:api/v1/vessel/getvesselheader/{}"));
    }

    [Fact]
    public void ExtractsInvokesRouteEdgeFromARawHttpClientCallSite()
    {
        // VesselRawHttpClientLookup calls HttpClient.GetAsync directly — no generated NSwag
        // client, no [RouteUrl] attribute to read at all. The interpolated {vesselId} slot
        // collapses to the same {} placeholder RouteUtils.NormalizeTemplate uses for a producer's
        // own {id}-style route parameter, since the caller's local variable name has no reason to
        // match it.
        Assert.True(HasEdge(
            "INVOKES_ROUTE",
            "csharp:global::SampleApi.Api.VesselRawHttpClientLookup.LookupAsync(int)",
            "xrepo:route:api/v1/vessel/{}"));
    }

    [Fact]
    public void ResolvesACallThroughAnInterfaceMethodThatReliesOnAnImplicitUsing()
    {
        // Domain/AsyncGreeter.cs has no explicit `using System.Threading.Tasks;` at all — its
        // Task<string> return type only resolves via <ImplicitUsings>enable</ImplicitUsings>'s
        // auto-generated GlobalUsings.g.cs file (see ProjectLoader.Load). End-to-end coverage for
        // that pattern; ProjectLoaderTests has the precise regression guard — in this small a
        // fixture, Roslyn's error recovery is lenient enough that the CALLS edge below still
        // resolves even with that file left out entirely (the real repo where this was found had
        // hundreds of cascading errors in one compilation; a 3-file one doesn't reproduce that).
        Assert.True(HasEdge(
            "CALLS",
            "csharp:global::SampleApi.Api.AsyncGreeterConsumer.GreetAsync(string)",
            "csharp:global::SampleApi.Domain.IAsyncGreeter.GreetAsync(string)"));
    }

    [Fact]
    public void ExtractsPublishesEdgeFromAnEnqueueMessageCallSite()
    {
        // VoyageChecklistPublisher calls EnqueueMessage(new VoyageChecklistsGeneratedMessage{...}),
        // the shape of this org's internal IMessageQueueService wrapper over MassTransit. The edge
        // target is the normalized xrepo:message:{TypeName} key, not the message class's real
        // Symbol id — see MessageUtils/PublishesEdge for why.
        Assert.True(HasEdge(
            "PUBLISHES",
            "csharp:global::SampleApi.Api.VoyageChecklistPublisher.PublishVoyageChecklistsGenerated(int)",
            "xrepo:message:VoyageChecklistsGeneratedMessage"));
    }

    [Fact]
    public void ExtractsConsumesEdgeFromAnIConsumerImplementation()
    {
        // VoyageChecklistConsumer implements IConsumer<VoyageChecklistsGeneratedMessage>, the same
        // shape as MassTransit's native consumer interface.
        Assert.True(HasEdge(
            "CONSUMES",
            "csharp:global::SampleApi.Api.VoyageChecklistConsumer",
            "xrepo:message:VoyageChecklistsGeneratedMessage"));
    }

    [Fact]
    public void EmitsOneMessageContractSymbolSharedByPublisherAndConsumer()
    {
        // Both the publisher and consumer reference the same message type — TryClaim should
        // guard against emitting the MessageContract Symbol row twice.
        var contract = GetSymbol("xrepo:message:VoyageChecklistsGeneratedMessage");
        Assert.Equal("MessageContract", contract.GetProperty("kind").GetString());
        Assert.Equal("VoyageChecklistsGeneratedMessage", contract.GetProperty("name").GetString());
    }

    [Fact]
    public void ExtractsPublishesEdgeFromASignalServiceSendCallSite()
    {
        // VoyageStatusPublisher calls Send("eventName", data) on a receiver whose type name
        // contains "SignalService" — the shape of Genesis.SignalR.Services.SignalService.Send.
        Assert.True(HasEdge(
            "PUBLISHES",
            "csharp:global::SampleApi.Api.VoyageStatusPublisher.PublishVoyageStatusChanged(int)",
            "xrepo:signal:voyageStatusChanged"));
    }

    [Fact]
    public void ExtractsConsumesEdgeFromAnISignalHubInterceptorImplementation()
    {
        // OnboardingHubInterceptor implements ISignalHubInterceptor with InterceptorName =>
        // "OnboardingHub" — the shape of Genesis.SignalR's real interceptor classes, which a
        // client's .invoke('InvokeServerFunction', interceptorName, ...) call dispatches to by
        // this name.
        Assert.True(HasEdge(
            "CONSUMES",
            "csharp:global::SampleApi.Api.OnboardingHubInterceptor",
            "xrepo:signal:OnboardingHub"));
    }

    [Fact]
    public void IsIdempotentAcrossRuns()
    {
        var stringWriter = new StringWriter();
        var originalOut = Console.Out;
        Console.SetOut(stringWriter);
        try
        {
            Runner.Run([fixture.SlnxPath, fixture.RepoRoot]);
        }
        finally
        {
            Console.SetOut(originalOut);
        }

        var secondRunIds = stringWriter
            .ToString()
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => JsonDocument.Parse(line).RootElement)
            .Where(r => Is(r, "symbol"))
            .Select(r => r.GetProperty("id").GetString())
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToList();

        var firstRunIds = Records
            .Where(r => Is(r, "symbol"))
            .Select(r => r.GetProperty("id").GetString())
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToList();

        Assert.Equal(firstRunIds, secondRunIds);
    }
}
