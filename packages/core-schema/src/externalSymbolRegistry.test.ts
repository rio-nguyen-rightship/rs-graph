import { describe, expect, it } from "vitest";
import { ExternalSymbolRegistry } from "./externalSymbolRegistry.js";
import type { FileNode, SymbolNode } from "./nodes.js";

describe("ExternalSymbolRegistry", () => {
  it("registers a symbol once and reuses the id on repeat lookups", () => {
    const registry = new ExternalSymbolRegistry("typescript", () => "external:some-pkg");
    const id1 = registry.getOrRegister({ id: "a", name: "Foo", kind: "Class", signature: "class Foo" });
    const id2 = registry.getOrRegister({ id: "a", name: "Foo", kind: "Class", signature: "class Foo" });
    expect(id1).toBe("a");
    expect(id2).toBe("a");

    const records = [...registry.flush()];
    const symbolRecords = records.filter((r): r is SymbolNode => r.record === "symbol");
    expect(symbolRecords).toHaveLength(1);
  });

  it("groups symbols into pseudo-files by the caller-provided key", () => {
    const registry = new ExternalSymbolRegistry("typescript", (d) => `external:${d.name[0]}`);
    registry.getOrRegister({ id: "a", name: "Apple", kind: "Class", signature: "" });
    registry.getOrRegister({ id: "b", name: "Banana", kind: "Class", signature: "" });

    const fileRecords = [...registry.flush()].filter((r): r is FileNode => r.record === "file");
    expect(fileRecords.map((f) => f.path).sort()).toEqual(["external:A", "external:B"]);
  });

  it("changes a pseudo-file's contentHash when its set of known symbols changes", () => {
    const registry1 = new ExternalSymbolRegistry("typescript", () => "external:pkg");
    registry1.getOrRegister({ id: "a", name: "A", kind: "Class", signature: "" });
    const [file1] = [...registry1.flush()].filter((r): r is FileNode => r.record === "file");

    const registry2 = new ExternalSymbolRegistry("typescript", () => "external:pkg");
    registry2.getOrRegister({ id: "a", name: "A", kind: "Class", signature: "" });
    registry2.getOrRegister({ id: "b", name: "B", kind: "Class", signature: "" });
    const [file2] = [...registry2.flush()].filter((r): r is FileNode => r.record === "file");

    expect(file1?.contentHash).not.toBe(file2?.contentHash);
  });
});
