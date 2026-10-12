import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeGraphDb, openGraphDb } from "./db.js";

describe("openGraphDb mustExist", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-open-db-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws without creating anything when the db or its folder is missing", () => {
    const dbPath = path.join(tmpDir, "not-a-repo", ".rs-graph", "graph.db");
    expect(() => openGraphDb({ dbPath, mustExist: true })).toThrow(/does not exist/);
    expect(fs.existsSync(path.join(tmpDir, "not-a-repo"))).toBe(false);
  });

  it("opens an existing db unchanged", () => {
    const dbPath = path.join(tmpDir, ".rs-graph", "graph.db");
    closeGraphDb(openGraphDb({ dbPath }));
    closeGraphDb(openGraphDb({ dbPath, mustExist: true }));
  });

  it("still creates the db by default", () => {
    const dbPath = path.join(tmpDir, "repo", ".rs-graph", "graph.db");
    closeGraphDb(openGraphDb({ dbPath }));
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
