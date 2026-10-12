import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeGraphDb, openGraphDb, type GraphDb } from "@rs-graph/graph-store";
import { repoDbPath, type WorkspaceRepoConfig } from "@rs-graph/workspace-store";
import { generateManifests, runGenerateManifest } from "./generateManifest.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-generate-manifest-test-"));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function makeRepo(name: string): WorkspaceRepoConfig {
  return { name, path: path.join(workspaceDir, name) };
}

function seedDb(repo: WorkspaceRepoConfig, seed: (db: GraphDb) => void): void {
  fs.mkdirSync(repo.path, { recursive: true });
  const db = openGraphDb({ dbPath: repoDbPath(repo) });
  try {
    db.prepare(`INSERT INTO File (path, language, contentHash, sizeBytes) VALUES ('f.cs', 'csharp', 'h', 1)`).run();
    seed(db);
  } finally {
    closeGraphDb(db);
  }
}

function insertSymbol(db: GraphDb, id: string, name: string, kind: string): void {
  db.prepare(
    `INSERT INTO Symbol (id, name, kind, signature, filePath, startLine, endLine, modifiers, external)
     VALUES (?, ?, ?, ?, 'f.cs', 1, 1, '[]', 0)`,
  ).run(id, name, kind, name);
}

describe("runGenerateManifest", () => {
  it("writes CROSS_REPO_MANIFEST.md/.json into an indexed repo's own root", () => {
    const repo = makeRepo("producer");
    seedDb(repo, (db) => insertSymbol(db, "csharp:route:GET:api/greeting", "GET api/greeting", "Route"));

    const workspaceConfigPath = path.join(workspaceDir, "workspace.json");
    fs.writeFileSync(workspaceConfigPath, JSON.stringify({ repos: [{ name: "producer", path: "./producer" }] }));

    runGenerateManifest(workspaceConfigPath);

    const markdownPath = path.join(repo.path, "CROSS_REPO_MANIFEST.md");
    const jsonPath = path.join(repo.path, "CROSS_REPO_MANIFEST.json");
    expect(fs.existsSync(markdownPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);

    const markdown = fs.readFileSync(markdownPath, "utf8");
    expect(markdown).toContain("# Cross-repo integration surface: producer");
    expect(markdown).toContain("GET api/greeting");

    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { routesDefined: Array<{ name: string }> };
    expect(json.routesDefined).toEqual([expect.objectContaining({ name: "GET api/greeting" })]);
  });

  it("skips a repo with no .rs-graph/graph.db yet, without creating a manifest for it", () => {
    const repo = makeRepo("not-yet-indexed");
    fs.mkdirSync(repo.path, { recursive: true });

    const workspaceConfigPath = path.join(workspaceDir, "workspace.json");
    fs.writeFileSync(
      workspaceConfigPath,
      JSON.stringify({ repos: [{ name: "not-yet-indexed", path: "./not-yet-indexed" }] }),
    );

    expect(() => runGenerateManifest(workspaceConfigPath)).not.toThrow();
    expect(fs.existsSync(path.join(repo.path, "CROSS_REPO_MANIFEST.md"))).toBe(false);
  });
});

describe("generateManifests idempotency", () => {
  function setupProducer(): { repo: WorkspaceRepoConfig; workspaceConfigPath: string } {
    const repo = makeRepo("producer");
    seedDb(repo, (db) => insertSymbol(db, "csharp:route:GET:api/greeting", "GET api/greeting", "Route"));
    const workspaceConfigPath = path.join(workspaceDir, "workspace.json");
    fs.writeFileSync(workspaceConfigPath, JSON.stringify({ repos: [{ name: "producer", path: "./producer" }] }));
    return { repo, workspaceConfigPath };
  }

  it("leaves files byte-for-byte untouched when nothing but the timestamp would change", () => {
    const { repo, workspaceConfigPath } = setupProducer();
    const jsonPath = path.join(repo.path, "CROSS_REPO_MANIFEST.json");

    expect(generateManifests(workspaceConfigPath).written).toEqual(["producer"]);
    const before = fs.readFileSync(jsonPath, "utf8");
    const mtimeBefore = fs.statSync(jsonPath).mtimeMs;

    const second = generateManifests(workspaceConfigPath);

    expect(second).toEqual({ written: [], unchanged: ["producer"], skipped: [] });
    expect(fs.readFileSync(jsonPath, "utf8")).toBe(before);
    expect(fs.statSync(jsonPath).mtimeMs).toBe(mtimeBefore);
  });

  it("rewrites when the integration surface actually changed", () => {
    const { repo, workspaceConfigPath } = setupProducer();
    generateManifests(workspaceConfigPath);

    const db = openGraphDb({ dbPath: repoDbPath(repo) });
    insertSymbol(db, "csharp:route:POST:api/farewell", "POST api/farewell", "Route");
    closeGraphDb(db);

    expect(generateManifests(workspaceConfigPath).written).toEqual(["producer"]);
    expect(fs.readFileSync(path.join(repo.path, "CROSS_REPO_MANIFEST.md"), "utf8")).toContain("POST api/farewell");
  });

  it("rewrites a manifest whose .md was deleted, even if the .json still matches", () => {
    const { repo, workspaceConfigPath } = setupProducer();
    generateManifests(workspaceConfigPath);
    fs.rmSync(path.join(repo.path, "CROSS_REPO_MANIFEST.md"));

    expect(generateManifests(workspaceConfigPath).written).toEqual(["producer"]);
    expect(fs.existsSync(path.join(repo.path, "CROSS_REPO_MANIFEST.md"))).toBe(true);
  });
});
