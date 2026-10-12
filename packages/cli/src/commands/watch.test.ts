import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManifestRefresher, DebouncedReindexer, isIgnored, isRelevantFile } from "./watch.js";

describe("isIgnored", () => {
  it("ignores common build/dependency/VCS directories regardless of position in the path", () => {
    expect(isIgnored("/repo/node_modules/pkg/index.js")).toBe(true);
    expect(isIgnored("/repo/src/Api/bin/Debug/Api.dll")).toBe(true);
    expect(isIgnored("/repo/src/Api/obj/Api.csproj.nuget.g.props")).toBe(true);
    expect(isIgnored("/repo/.git/HEAD")).toBe(true);
    expect(isIgnored("/repo/.rs-graph/graph.db")).toBe(true);
  });

  it("does not ignore ordinary source paths", () => {
    expect(isIgnored("/repo/src/app.component.ts")).toBe(false);
    expect(isIgnored("/repo/Domain/Greeter.cs")).toBe(false);
  });
});

describe("isRelevantFile", () => {
  it("recognizes source extensions we index", () => {
    for (const f of ["a.cs", "a.ts", "a.tsx", "a.html", "a.py"]) {
      expect(isRelevantFile(f)).toBe(true);
    }
  });

  it("ignores everything else", () => {
    for (const f of ["a.json", "a.md", "a.png", "a.dll", "README"]) {
      expect(isRelevantFile(f)).toBe(false);
    }
  });
});

describe("DebouncedReindexer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of changes into a single reindex call", async () => {
    const reindex = vi.fn().mockResolvedValue(undefined);
    const reindexer = new DebouncedReindexer(reindex, 400);

    reindexer.notifyChange();
    vi.advanceTimersByTime(100);
    reindexer.notifyChange();
    vi.advanceTimersByTime(100);
    reindexer.notifyChange();

    await vi.advanceTimersByTimeAsync(400);
    expect(reindex).toHaveBeenCalledTimes(1);
  });

  it("queues exactly one more reindex if a change arrives mid-reindex", async () => {
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => (resolveFirst = resolve));
    const reindex = vi.fn().mockImplementationOnce(() => firstCall).mockResolvedValue(undefined);
    const reindexer = new DebouncedReindexer(reindex, 10);

    reindexer.notifyChange();
    await vi.advanceTimersByTimeAsync(10);
    expect(reindex).toHaveBeenCalledTimes(1); // first reindex now in flight

    // A change arrives while the first reindex is still running.
    reindexer.notifyChange();
    await vi.advanceTimersByTimeAsync(10);
    expect(reindex).toHaveBeenCalledTimes(1); // still just the one in-flight call, second is queued

    resolveFirst();
    await vi.waitFor(() => expect(reindex).toHaveBeenCalledTimes(2));
  });

  it("runs a fresh reindex for changes that arrive well after the previous one finished", async () => {
    const reindex = vi.fn().mockResolvedValue(undefined);
    const reindexer = new DebouncedReindexer(reindex, 10);

    reindexer.notifyChange();
    await vi.advanceTimersByTimeAsync(10);
    expect(reindex).toHaveBeenCalledTimes(1);

    reindexer.notifyChange();
    await vi.advanceTimersByTimeAsync(10);
    expect(reindex).toHaveBeenCalledTimes(2);
  });
});

describe("createManifestRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("regenerates once for a burst of repos finishing their reindex together", async () => {
    const generate = vi.fn().mockReturnValue({ written: [], unchanged: ["a", "b"], skipped: [] });
    const refresher = createManifestRefresher("/ws/workspace.json", generate, 10);

    refresher.notifyChange();
    refresher.notifyChange();
    refresher.notifyChange();
    await vi.advanceTimersByTimeAsync(10);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("/ws/workspace.json");
  });

  it("reports which manifests changed, and stays quiet when none did", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const generate = vi
      .fn()
      .mockReturnValueOnce({ written: ["producer"], unchanged: [], skipped: [] })
      .mockReturnValueOnce({ written: [], unchanged: ["producer"], skipped: [] });
    const refresher = createManifestRefresher("/ws/workspace.json", generate, 10);

    refresher.notifyChange();
    await vi.advanceTimersByTimeAsync(10);
    refresher.notifyChange();
    await vi.advanceTimersByTimeAsync(10);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[manifest] updated: producer");
  });

  it("survives a failing regeneration so the watcher keeps running", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const generate = vi.fn().mockImplementationOnce(() => {
      throw new Error("boom");
    }).mockReturnValue({ written: [], unchanged: [], skipped: [] });
    const refresher = createManifestRefresher("/ws/workspace.json", generate, 10);

    refresher.notifyChange();
    await vi.advanceTimersByTimeAsync(10);
    refresher.notifyChange();
    await vi.advanceTimersByTimeAsync(10);

    expect(error).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
