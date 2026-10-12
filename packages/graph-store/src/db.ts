import Database from "better-sqlite3";
import { ALL_DDL } from "@rs-graph/core-schema";
import * as fs from "node:fs";
import * as path from "node:path";

export type GraphDb = Database.Database;

export interface OpenOptions {
  /** Path to the .db file, e.g. `<repo>/.rs-graph/graph.db`. Parent dir is created if missing
   * (unless `mustExist` is set). */
  dbPath: string;
  /** For read-only consumers (`serve`): throw instead of creating the directory/db when it isn't
   * already there. A relative path resolved against an unexpected cwd would otherwise silently
   * fabricate an empty `.rs-graph/graph.db` inside whatever unrelated folder cwd happened to be. */
  mustExist?: boolean;
}

/** Opens (creating + initializing if needed) the graph database. Foreign keys are enforced
 * and WAL mode is used so a long-lived `rs-graph serve` reader doesn't block concurrent
 * `rs-graph index`/`watch` writes. A busy_timeout is also set: `watch` and a git post-merge
 * hook's background reindex are both meant to run against the same repo, and WAL still fully
 * serializes writer-vs-writer — without a timeout, whichever one loses that race throws
 * SQLITE_BUSY immediately instead of just waiting the sub-second it takes for the other one
 * to finish its transaction. */
export function openGraphDb({ dbPath, mustExist }: OpenOptions): GraphDb {
  if (mustExist) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`${dbPath} does not exist — run \`rs-graph index\` on that repo first`);
    }
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const isNew = !fs.existsSync(dbPath);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");

  if (isNew) {
    initSchema(db);
  }

  return db;
}

function initSchema(db: GraphDb): void {
  const runAll = db.transaction(() => {
    for (const statement of ALL_DDL) {
      db.exec(statement);
    }
  });
  runAll();
}

export function closeGraphDb(db: GraphDb): void {
  db.close();
}
