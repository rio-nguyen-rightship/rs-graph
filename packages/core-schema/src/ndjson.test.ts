import { describe, expect, it } from "vitest";
import { parseGraphRecordLine, stringifyGraphRecord } from "./ndjson.js";
import type { SymbolNode } from "./nodes.js";
import type { CallsEdge } from "./edges.js";

describe("ndjson roundtrip", () => {
  it("parses a stringified symbol node back to an equivalent object", () => {
    const symbol: SymbolNode = {
      record: "symbol",
      id: "csharp:src/Foo.cs#10:2:Bar",
      name: "Bar",
      kind: "Method",
      signature: "public Task<int> Bar(int x)",
      filePath: "src/Foo.cs",
      startLine: 10,
      endLine: 14,
      modifiers: ["public"],
      external: false,
    };
    const line = stringifyGraphRecord(symbol);
    expect(parseGraphRecordLine(line)).toEqual(symbol);
  });

  it("parses a stringified calls edge back to an equivalent object", () => {
    const edge: CallsEdge = {
      record: "edge",
      edgeType: "CALLS",
      from: "a",
      to: "b",
      line: 42,
    };
    expect(parseGraphRecordLine(stringifyGraphRecord(edge))).toEqual(edge);
  });

  it("returns undefined for blank lines", () => {
    expect(parseGraphRecordLine("   ")).toBeUndefined();
    expect(parseGraphRecordLine("")).toBeUndefined();
  });
});
