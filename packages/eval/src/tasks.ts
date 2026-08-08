import type { EvalTask } from "./types.js";

/**
 * .NET + TS task suite. Two tiers, deliberately kept separate:
 *
 * - `fixture-*` tasks run against fixtures/sample-dotnet-api and fixtures/sample-angular-app —
 *   small enough that every groundTruth entry below was hand-verified by reading the fixture
 *   source directly (see the files under fixtures/). These measure *correctness*, not cost: at
 *   5 files, grep is already close to optimal, so a token-savings win here wouldn't mean much.
 * - `real-*` tasks run against a real repo (configure one in repos.config.json — see
 *   repos.config.example.json) and have no groundTruth: correctness can't be auto-scored
 *   without an independent oracle (e.g. Rider/VS "Find All References"), so these measure cost
 *   (tokens, tool calls) and the final answer is recorded for manual review. This is where the
 *   actual value proposition (or lack of one) shows up — fixtures are too small to tell you
 *   anything about token savings at real-codebase scale.
 *
 * Prompts are deliberately tool-agnostic (never name graph_* / grep / read_file) so the model's
 * tool choice isn't primed by the question itself.
 */
export const TASKS: EvalTask[] = [
  // ---- .NET fixture tasks (fixtures/sample-dotnet-api) ----
  {
    id: "fixture-dotnet-callers",
    language: "csharp",
    category: "callers",
    repoKey: "fixture-dotnet",
    prompt: "Who calls Greeter.Greet in this codebase, and through what type is it called?",
    groundTruth: { mustMention: ["GreetingController", "Get"] },
  },
  {
    id: "fixture-dotnet-hierarchy",
    language: "csharp",
    category: "hierarchy",
    repoKey: "fixture-dotnet",
    prompt: "What interface does the Greeter class implement?",
    groundTruth: { mustMention: ["IGreeter"] },
  },
  {
    id: "fixture-dotnet-di",
    language: "csharp",
    category: "di",
    repoKey: "fixture-dotnet",
    prompt: "What concrete type is registered for IGreeter via dependency injection, and in which file?",
    groundTruth: { mustMention: ["Greeter", "Program.cs"] },
  },
  {
    id: "fixture-dotnet-routes",
    language: "csharp",
    category: "trivial-lookup",
    repoKey: "fixture-dotnet",
    prompt: "What HTTP route(s) does this API expose, and which method handles each one?",
    groundTruth: { mustMention: ["Greeting", "Get"] },
  },
  {
    id: "fixture-dotnet-outline",
    language: "csharp",
    category: "file-outline",
    repoKey: "fixture-dotnet",
    prompt: "Without reading the whole file, what public members does GreetingController declare?",
    groundTruth: { mustMention: ["Get"] },
  },

  // ---- TS/Angular fixture tasks (fixtures/sample-angular-app) ----
  {
    id: "fixture-ts-callers",
    language: "typescript",
    category: "callers",
    repoKey: "fixture-angular",
    prompt: "Who calls GreeterService.greet in this codebase, and through what type is it called?",
    groundTruth: { mustMention: ["AppComponent", "greetTitle"] },
  },
  {
    id: "fixture-ts-hierarchy",
    language: "typescript",
    category: "hierarchy",
    repoKey: "fixture-angular",
    prompt: "What interface does GreeterService implement?",
    groundTruth: { mustMention: ["IGreeter"] },
  },
  {
    id: "fixture-ts-routes",
    language: "typescript",
    category: "trivial-lookup",
    repoKey: "fixture-angular",
    prompt: "What routes does this Angular app define, and which component handles each?",
    groundTruth: { mustMention: ["AppComponent", "AboutComponent", "about"] },
  },
  {
    id: "fixture-ts-component-tree",
    language: "typescript",
    category: "file-outline",
    repoKey: "fixture-angular",
    prompt: "List every Angular component defined in this app.",
    groundTruth: { mustMention: ["AppComponent", "AboutComponent"] },
  },

  // ---- Real .NET repo tasks (configure "psc-riskiq-api" in repos.config.json) ----
  // Symbol names below are real, confirmed to exist in psc-riskiq-app as of this session —
  // if the repo changes significantly, re-verify before trusting a "no matches" result.
  {
    id: "real-dotnet-references",
    language: "csharp",
    category: "callers",
    repoKey: "psc-riskiq-api",
    prompt:
      "What calls or otherwise references PortCallPredictionHostedService, and how is it actually invoked at runtime?",
  },
  {
    id: "real-dotnet-impact",
    language: "csharp",
    category: "impact",
    repoKey: "psc-riskiq-api",
    prompt: "If I changed the signature of IVoyageService, what code in this repo would be affected?",
  },
  {
    id: "real-dotnet-di",
    language: "csharp",
    category: "di",
    repoKey: "psc-riskiq-api",
    prompt: "What's registered for IPscRiskIQPortsApiClient via dependency injection, and where?",
  },
  {
    id: "real-dotnet-outline",
    language: "csharp",
    category: "file-outline",
    repoKey: "psc-riskiq-api",
    prompt: "Summarize the public surface of PortCallPredictionHostedService.cs without reading the whole file.",
  },

  // ---- Real TS/Angular repo tasks (configure "psc-riskiq-ui" in repos.config.json) ----
  // Deliberately name-agnostic — fill in a repo without needing to know its symbols up front.
  {
    id: "real-ts-component-tree",
    language: "typescript",
    category: "file-outline",
    repoKey: "psc-riskiq-ui",
    prompt: "List every Angular component in this app, and what its template actually binds to on its class.",
  },
  {
    id: "real-ts-routes",
    language: "typescript",
    category: "trivial-lookup",
    repoKey: "psc-riskiq-ui",
    prompt: "What are all the routes defined in this app, and which component handles each one?",
  },
  {
    id: "real-ts-di-fanout",
    language: "typescript",
    category: "callers",
    repoKey: "psc-riskiq-ui",
    prompt:
      "Find an Angular service in this app that's injected into at least three different components or services, and list every place it's used.",
  },
];
