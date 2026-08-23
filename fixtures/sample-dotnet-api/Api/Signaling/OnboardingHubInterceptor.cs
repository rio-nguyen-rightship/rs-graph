using SampleApi.Signaling;

namespace SampleApi.Api;

// Exercises SymbolGraphBuilder's SignalR CONSUMES extraction: implements ISignalHubInterceptor
// with an InterceptorName carrying the dispatch name — the shape of Genesis.SignalR's real
// interceptor classes (e.g. the real OnboardingHubInterceptor.InterceptorName => "OnboardingHub").
public sealed class OnboardingHubInterceptor : ISignalHubInterceptor
{
    public string InterceptorName => "OnboardingHub";
}
