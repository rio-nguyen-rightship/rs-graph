import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeGraphDb, openGraphDb } from "@rs-graph/graph-store";
import { writeIndexReport, type IndexReport } from "../indexReport.js";
import { DEGRADED_UNRESOLVED_THRESHOLD, diagnoseRepo } from "./doctor.js";

describe("rs-graph doctor", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-doctor-test-"));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const writeFile = (rel: string, content = "", mtime?: Date) => {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (mtime) fs.utimesSync(full, mtime, mtime);
    return full;
  };

  const addRestoredCsproj = (rel = "Api/Api.csproj") => {
    writeFile(rel, "<Project Sdk=\"Microsoft.NET.Sdk\" />");
    writeFile(path.join(path.dirname(rel), "obj", "project.assets.json"), "{}");
  };

  const indexNow = (overrides: Partial<IndexReport> = {}, startedAt = new Date()) => {
    closeGraphDb(openGraphDb({ dbPath: path.join(repo, ".rs-graph", "graph.db") }));
    writeIndexReport(repo, { startedAt: startedAt.toISOString(), languages: ["csharp"], ...overrides });
  };

  it("reports missing — and creates nothing — when there is no graph", () => {
    const report = diagnoseRepo(repo);

    expect(report.status).toBe("missing");
    expect(report.suggestedAction).toContain("rs-graph index");
    expect(fs.existsSync(path.join(repo, ".rs-graph"))).toBe(false);
  });

  it("reports missing for a db file that has no schema yet (index still starting)", () => {
    writeFile(".rs-graph/graph.db", "");

    expect(diagnoseRepo(repo).status).toBe("missing");
  });

  it("reports needs-build when .NET projects were never restored", () => {
    writeFile("Api/Api.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />");

    const report = diagnoseRepo(repo);

    expect(report.status).toBe("needs-build");
    expect(report.dotnet).toMatchObject({ projects: 1, projectsWithoutAssets: 1 });
    expect(report.suggestedAction).toContain("never runs restore/build");
  });

  it("still reports needs-build for an already-indexed repo whose projects aren't restored", () => {
    writeFile("Api/Api.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />");
    indexNow();

    expect(diagnoseRepo(repo).status).toBe("needs-build");
  });

  it("reports ok for an indexed, restored repo with nothing changed since", () => {
    addRestoredCsproj();
    writeFile("Api/Foo.cs", "class Foo {}", new Date(Date.now() - 60_000));
    indexNow();

    const report = diagnoseRepo(repo);

    expect(report.status).toBe("ok");
    expect(report.suggestedAction).toBe("");
    expect(report.gitIgnored).toBeNull();
  });

  it("reports stale, naming the files, when source changed after the index started", () => {
    addRestoredCsproj();
    writeFile("Api/Foo.cs", "class Foo {}", new Date(Date.now() + 60_000));
    indexNow();

    const report = diagnoseRepo(repo);

    expect(report.status).toBe("stale");
    expect(report.changedSinceIndex?.count).toBe(1);
    expect(report.changedSinceIndex?.examples).toEqual([path.join("Api", "Foo.cs")]);
  });

  it("reports degraded when many declarations were unresolved at index time", () => {
    addRestoredCsproj();
    indexNow({
      dotnet: {
        projects: 1,
        unresolvedReferenceErrors: DEGRADED_UNRESOLVED_THRESHOLD,
        worstProjects: [{ project: "Api", errors: DEGRADED_UNRESOLVED_THRESHOLD }],
      },
    });

    const report = diagnoseRepo(repo);

    expect(report.status).toBe("degraded");
    expect(report.summary).toContain("Api");
    expect(report.suggestedAction).toContain("--fresh");
  });

  it("does not call a handful of unresolved references degraded", () => {
    addRestoredCsproj();
    indexNow({ dotnet: { projects: 1, unresolvedReferenceErrors: 3, worstProjects: [] } });

    expect(diagnoseRepo(repo).status).toBe("ok");
  });

  it("detects MCP registration from .mcp.json", () => {
    writeFile(".mcp.json", JSON.stringify({ mcpServers: { "rs-graph": { command: "rs-graph", args: ["serve", "."] } } }));

    expect(diagnoseRepo(repo).mcpRegistered).toBe(true);
  });
});
