import * as path from "node:path";
import chokidar from "chokidar";
import { runIndex, type RunIndexOptions } from "./indexRepo.js";

const RELEVANT_EXTENSIONS = [".cs", ".ts", ".tsx", ".html", ".py"];
const IGNORED_DIR_NAMES = new Set(["node_modules", "bin", "obj", "dist", ".git", ".rs-graph"]);

export function isIgnored(filePath: string): boolean {
  const segments = filePath.split(/[/\\]/);
  return segments.some((s) => IGNORED_DIR_NAMES.has(s) || s.startsWith("."));
}

export function isRelevantFile(filePath: string): boolean {
  return RELEVANT_EXTENSIONS.includes(path.extname(filePath));
}

/**
 * Coalesces a burst of change notifications into one reindex call, debounced so rapid saves
 * don't trigger redundant reindexing bursts; if a change arrives while a reindex is already
 * running, exactly one more reindex is queued to run right after (rather than dropped or
 * piled up per-event).
 */
export class DebouncedReindexer {
  private reindexing = false;
  private pending = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly reindex: () => Promise<void>,
    private readonly debounceMs = 400,
  ) {}

  notifyChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.trigger(), this.debounceMs);
  }

  private async trigger(): Promise<void> {
    if (this.reindexing) {
      this.pending = true;
      return;
    }
    this.reindexing = true;
    try {
      await this.reindex();
    } finally {
      this.reindexing = false;
      if (this.pending) {
        this.pending = false;
        void this.trigger();
      }
    }
  }
}

/**
 * Watches a repo and re-indexes on change. Re-indexing currently means re-running the full
 * per-language indexer (each already completes in ~1-2s for a single project) rather than a
 * surgical re-parse of just the changed file — graph-store's contentHash-keyed ingest still
 * only *writes* the files that actually changed, so this stays correct and cheap at the
 * database layer even though the indexer-side scan itself isn't minimized yet. Scoping the
 * scan down to just the affected project would be a good follow-up if full-repo re-scans ever
 * become a bottleneck on large codebases.
 */
export function runWatch(targetPath: string, options: RunIndexOptions = {}): void {
  console.log(`Watching ${targetPath} for changes (Ctrl+C to stop)...`);

  // options.fresh, if set, must only apply to the first reindex triggered after watch starts —
  // reapplying it on every debounced reindex would delete and rebuild .rs-graph/graph.db on
  // every file save, defeating the point of contentHash-keyed incremental ingest.
  let nextIndexOptions = options;
  const reindexer = new DebouncedReindexer(() => {
    const runOptions = nextIndexOptions;
    nextIndexOptions = { ...options, fresh: false };
    return runIndex(targetPath, runOptions).catch((err: unknown) => console.error("re-index failed:", err));
  });

  const watcher = chokidar.watch(targetPath, {
    ignored: (filePath: string) => isIgnored(filePath),
    ignoreInitial: true,
  });

  watcher.on("all", (event, filePath) => {
    if (!isRelevantFile(filePath)) return;
    console.log(`  [${event}] ${path.relative(targetPath, filePath)}`);
    reindexer.notifyChange();
  });

  watcher.on("error", (err) => console.error("watch error:", err));
}
