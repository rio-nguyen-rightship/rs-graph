import * as fs from "node:fs";
import { closeGraphDb, openGraphDb, type GraphDb } from "@rs-graph/graph-store";

/**
 * Returns a getter that opens `dbPath` on first use instead of at server startup, so the MCP
 * server can come up before the repo has been indexed (a SessionStart hook or `rs-graph index`
 * may still be building the graph when Claude launches it) and starts answering as soon as the
 * graph appears — no session restart. Until then every tool call fails with a clear message.
 * Never creates anything: the db is opened with `mustExist`, so a wrong path can't fabricate an
 * empty `.rs-graph` folder.
 */
export function createLazyDbGetter(dbPath: string): (() => GraphDb) & { close(): void } {
  let db: GraphDb | undefined;

  const getDb = () => {
    if (db) return db;
    if (!fs.existsSync(dbPath)) {
      throw new Error(
        `This repo hasn't been indexed yet (${dbPath} not found). Run \`rs-graph index\` on it; if ` +
          "indexing is already running, retry in a minute — no restart needed.",
      );
    }

    const opened = openGraphDb({ dbPath, mustExist: true });
    const hasSchema = opened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Symbol'").get();
    if (!hasSchema) {
      closeGraphDb(opened);
      throw new Error("Indexing is still in progress (the graph has no tables yet) — retry in a minute.");
    }
    db = opened;
    return db;
  };

  return Object.assign(getDb, {
    close() {
      if (db) closeGraphDb(db);
      db = undefined;
    },
  });
}
