import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCrossRepoRouteKey, normalizeRouteTemplate } from "./routeKey.js";

interface ParityCase {
  input: string;
  expectedKey: string;
}

/**
 * Guards normalizeRouteTemplate/buildCrossRepoRouteKey against drifting from indexer-dotnet's
 * RouteUtils equivalent — both read the same fixtures/route-key-parity.json table, so a change to
 * one implementation without the other fails here instead of silently breaking cross-repo route
 * resolution between a C# producer and a TypeScript (Angular HttpClient) consumer, or vice versa.
 */
describe("normalizeRouteTemplate + buildCrossRepoRouteKey", () => {
  const fixturePath = path.resolve(import.meta.dirname, "../../../fixtures/route-key-parity.json");
  const cases: ParityCase[] = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  it.each(cases)("matches the shared parity table for $input", ({ input, expectedKey }) => {
    expect(buildCrossRepoRouteKey(normalizeRouteTemplate(input))).toBe(expectedKey);
  });
});
