import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphRecord } from "@rs-graph/core-schema";
import { closeGraphDb, ingestGraphRecords, openGraphDb } from "@rs-graph/graph-store";
import { buildArguments, formatToolList, resolveToolName, runQuery } from "./query.js";

const TOOL = {
  name: "graph_get_callers",
  description: "Who calls X. More detail.",
  inputSchema: {
    properties: {
      symbolId: { type: "string" },
      line: { type: "integer" },
      detail: { type: "boolean" },
      kinds: { type: "array" },
    },
    required: ["symbolId"],
  },
};

describe("resolveToolName", () => {
  const names = ["graph_get_callers", "graph_search_symbol", "graph_workspace_route_consumers", "graph_get_route_map"];

  it("accepts the exact name and shorthands", () => {
    expect(resolveToolName("graph_get_callers", names)).toEqual({ name: "graph_get_callers" });
    expect(resolveToolName("callers", names)).toEqual({ name: "graph_get_callers" });
    expect(resolveToolName("search_symbol", names)).toEqual({ name: "graph_search_symbol" });
    expect(resolveToolName("route_consumers", names)).toEqual({ name: "graph_workspace_route_consumers" });
  });

  it("lists the available tools when the name is unknown", () => {
    const result = resolveToolName("nope", names);
    expect(result).toEqual({ error: expect.stringContaining("graph_get_callers") });
  });
});

describe("buildArguments", () => {
  it("types each --arg value from the tool's schema", () => {
    expect(buildArguments(TOOL, ["symbolId=a:b", "line=12", "detail=true", "kinds=x, y"])).toEqual({
      symbolId: "a:b",
      line: 12,
      detail: true,
      kinds: ["x", "y"],
    });
  });

  it("keeps '=' inside a value and lets --arg override --json", () => {
    expect(buildArguments(TOOL, ["symbolId=a=b"], '{"symbolId":"old","line":3}')).toEqual({ symbolId: "a=b", line: 3 });
  });

  it("rejects an unknown parameter, naming the real ones", () => {
    expect(() => buildArguments(TOOL, ["bogus=1"])).toThrow(/no parameter "bogus".*symbolId/);
  });

  it("rejects a non-numeric value for a number parameter", () => {
    expect(() => buildArguments(TOOL, ["line=abc"])).toThrow(/not a number/);
  });
});

describe("formatToolList", () => {
  it("shows the first sentence and marks optional parameters", () => {
    const text = formatToolList([TOOL]);
    expect(text).toContain("graph_get_callers");
    expect(text).toContain("Who calls X.");
    expect(text).not.toContain("More detail");
    expect(text).toContain("symbolId: string, line?: integer");
  });
});

describe("rs-graph query (against a real seeded graph)", () => {
  let repo: string;
  let out: string[];
  let err: string[];

  const records: GraphRecord[] = [
    { record: "file", path: "src/Foo.ts", language: "typescript", contentHash: "h1", sizeBytes: 10 },
    {
      record: "symbol",
      id: "Foo",
      name: "Foo",
      kind: "Class",
      signature: "class Foo",
      filePath: "src/Foo.ts",
      startLine: 1,
      endLine: 5,
      modifiers: [],
    },
  ];

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-query-test-"));
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function seed(): void {
    const db = openGraphDb({ dbPath: path.join(repo, ".rs-graph", "graph.db") });
    ingestGraphRecords(db, records);
    closeGraphDb(db);
  }

  it("answers through the same handlers as the MCP tools, with a shorthand name and typed args", async () => {
    seed();

    await runQuery("search_symbol", { repo, args: ["query=Foo", "scope=name", "limit=5"] });

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(out.join("\n"))).toEqual([expect.objectContaining({ name: "Foo", kind: "Class" })]);
  });

  it("accepts all arguments as one JSON object", async () => {
    seed();

    await runQuery("search_symbol", { repo, json: '{"query":"Foo","scope":"name"}' });

    expect(JSON.parse(out.join("\n"))).toHaveLength(1);
  });

  it("fails clearly, and creates nothing, when the repo isn't indexed", async () => {
    await runQuery("stats", { repo });

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("hasn't been indexed yet");
    expect(fs.existsSync(path.join(repo, ".rs-graph"))).toBe(false);
  });

  it("lists every tool when asked, even before the repo is indexed", async () => {
    await runQuery(undefined, { repo, list: true });

    const listing = out.join("\n");
    expect(listing).toContain("graph_get_callers");
    expect(listing).toContain("graph_search_symbol");
  });

  it("exits 1 for an unknown tool and for bad arguments", async () => {
    seed();

    await runQuery("nope", { repo });
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await runQuery("search_symbol", { repo, args: ["bogus=1"] });
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain('no parameter "bogus"');
  });
});
