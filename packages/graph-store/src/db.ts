import Database from "better-sqlite3";
import { ALL_DDL } from "@rs-graph/core-schema";
import * as fs from "node:fs";
import * as path from "node:path";

export type GraphDb = Database.Database;

export interface OpenOptions {
  /** Path to the .db file, e.g. `<repo>/.rs-graph/graph.db`. Parent dir is created if missing. */
  dbPath: string;
}

/** Opens (creating + initializing if needed) the graph database. Foreign keys are enforced
 * and WAL mode is used so a long-lived `rs-graph serve` reader doesn't block concurrent
 * `rs-graph index`/`watch` writes. */
export function openGraphDb({ dbPath }: OpenOptions): GraphDb {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const isNew = !fs.existsSync(dbPath);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

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
