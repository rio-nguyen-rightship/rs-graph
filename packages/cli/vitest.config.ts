import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e.test.ts and noBuildCommands.test.ts both index the same on-disk fixtures/ directories
    // and open the same .rs-graph/graph.db files — running test files in parallel (vitest's
    // default) causes Windows file-lock contention (EPERM) when one file's cleanup races
    // another's still-open SQLite handle. These tests do real subprocess/filesystem work, so
    // sequential execution is the correct tradeoff here, not just a workaround.
    fileParallelism: false,
  },
});
