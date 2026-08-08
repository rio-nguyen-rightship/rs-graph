import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Imported after the mock is set up so indexRepo.ts's `import { spawn } from "node:child_process"`
// resolves to the wrapped vi.fn().
const { spawn } = await import("node:child_process");
const { runIndex } = await import("./commands/indexRepo.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DOTNET_INDEXER_SRC = path.join(REPO_ROOT, "packages/indexer-dotnet/src");

const FIXTURES = [
  "fixtures/sample-dotnet-api",
  "fixtures/sample-angular-app",
  "fixtures/sample-python-api",
  "fixtures/sample-aurelia-app",
].map((p) => path.join(REPO_ROOT, p));

// Package-manager/build subcommands an indexer must never invoke against a target repo (see
// docs/architecture.md's security note) — matched as a standalone argument (basename, not
// substring), so this doesn't false-positive on e.g. a file path that happens to contain "build".
const FORBIDDEN_ARGS = ["restore", "install", "build", "ci"];

describe("security: indexing never shells out to a package manager or build command", () => {
  beforeAll(() => {
    // Test setup only: building *our own* indexer and *our own* fixtures, not something the
    // code under test (runIndex) does — see the same distinction made in e2e.test.ts.
    execFileSync("dotnet", ["build"], { cwd: DOTNET_INDEXER_SRC, stdio: "pipe" });
    // Explicit SampleApi.slnx: the fixture has two .sln/.slnx files (for testing --sln), and a
    // bare `dotnet restore`/`build` fails with an ambiguity error once more than one
    // project/solution file is present in the directory.
    const dotnetFixture = path.join(REPO_ROOT, "fixtures/sample-dotnet-api");
    execFileSync("dotnet", ["restore", "SampleApi.slnx"], { cwd: dotnetFixture, stdio: "pipe" });
    execFileSync("dotnet", ["build", "SampleApi.slnx"], { cwd: dotnetFixture, stdio: "pipe" });
  }, 60_000);

  afterEach(() => {
    for (const fixture of FIXTURES) fs.rmSync(path.join(fixture, ".rs-graph"), { recursive: true, force: true });
  });

  it(
    "never spawns a package-manager/build subcommand while indexing any fixture",
    async () => {
      const mockedSpawn = vi.mocked(spawn);
      mockedSpawn.mockClear();

      for (const fixture of FIXTURES) {
        await runIndex(fixture);
      }

      expect(mockedSpawn).toHaveBeenCalled(); // sanity check the spy actually observed the dotnet/python spawns

      for (const call of mockedSpawn.mock.calls) {
        const [command, args] = call;
        const tokens = [String(command), ...(Array.isArray(args) ? args.map(String) : [])];
        for (const token of tokens) {
          const bareToken = path.basename(token).toLowerCase();
          expect(
            FORBIDDEN_ARGS,
            `spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}) looks like a build/install command`,
          ).not.toContain(bareToken);
        }
      }
    },
    30_000,
  );
});
