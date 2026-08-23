import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMcpServerEntry, toPosixPath } from "./mcpConfig.js";

describe("ensureMcpServerEntry", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-mcp-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  function readConfig(): unknown {
    return JSON.parse(fs.readFileSync(path.join(repoPath, ".mcp.json"), "utf8"));
  }

  it("creates .mcp.json when none exists", () => {
    const result = ensureMcpServerEntry(repoPath, "rs-graph", { command: "rs-graph", args: ["serve", "."] });

    expect(result).toBe("added");
    expect(readConfig()).toEqual({
      mcpServers: { "rs-graph": { command: "rs-graph", args: ["serve", "."] } },
    });
  });

  it("merges a new entry into an existing .mcp.json, preserving other fields", () => {
    fs.writeFileSync(
      path.join(repoPath, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-tool", args: [] } }, someOtherField: true }),
    );

    const result = ensureMcpServerEntry(repoPath, "rs-graph", { command: "rs-graph", args: ["serve", "."] });

    expect(result).toBe("added");
    expect(readConfig()).toEqual({
      mcpServers: {
        other: { command: "other-tool", args: [] },
        "rs-graph": { command: "rs-graph", args: ["serve", "."] },
      },
      someOtherField: true,
    });
  });

  it("does not overwrite an existing entry under the same name", () => {
    fs.writeFileSync(
      path.join(repoPath, ".mcp.json"),
      JSON.stringify({ mcpServers: { "rs-graph": { command: "npx", args: ["rs-graph", "serve", "--custom"] } } }),
    );

    const result = ensureMcpServerEntry(repoPath, "rs-graph", { command: "rs-graph", args: ["serve", "."] });

    expect(result).toBe("exists");
    expect(readConfig()).toEqual({
      mcpServers: { "rs-graph": { command: "npx", args: ["rs-graph", "serve", "--custom"] } },
    });
  });

  it("throws a clear error rather than clobbering an unparseable .mcp.json", () => {
    fs.writeFileSync(path.join(repoPath, ".mcp.json"), "{ not valid json");

    expect(() => ensureMcpServerEntry(repoPath, "rs-graph", { command: "rs-graph", args: ["serve", "."] })).toThrow(
      /isn't valid JSON/,
    );
  });
});

describe("toPosixPath", () => {
  it("converts platform separators to forward slashes", () => {
    expect(toPosixPath(["..", "workspace.json"].join(path.sep))).toBe("../workspace.json");
  });
});
