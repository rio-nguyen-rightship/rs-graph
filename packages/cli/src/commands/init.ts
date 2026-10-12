import * as fs from "node:fs";
import * as path from "node:path";
import { closeGraphDb, openGraphDb } from "@rs-graph/graph-store";
import { isExistingDirectory } from "@rs-graph/workspace-store";

export function runInit(targetPath: string): void {
  if (!isExistingDirectory(targetPath)) {
    console.error(`${targetPath} is not an existing directory — nothing to initialize.`);
    process.exitCode = 1;
    return;
  }
  const rsGraphDir = path.join(targetPath, ".rs-graph");
  fs.mkdirSync(rsGraphDir, { recursive: true });

  const dbPath = path.join(rsGraphDir, "graph.db");
  const db = openGraphDb({ dbPath });
  closeGraphDb(db);

  console.log(`Initialized rs-graph at ${rsGraphDir}`);
  console.log(
    `Note: ".rs-graph/" contains extracted source structure and signatures — treat it as sensitive as the source itself and make sure it's in this repo's .gitignore.`,
  );
}
