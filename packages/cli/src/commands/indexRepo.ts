import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  ExternalSymbolRegistry,
  parseGraphRecordLine,
  type GraphRecord,
} from "@rs-graph/core-schema";
import { closeGraphDb, ingestGraphRecords, openGraphDb, type GraphDb } from "@rs-graph/graph-store";
import {
  AngularEnricher,
  ArraySink,
  AureliaEnricher,
  TsGraphBuilder,
  findTsConfig,
  loadProgram,
} from "@rs-graph/indexer-typescript";
import { detectProjects } from "../detect.js";

/**
 * Locates indexer-dotnet's build output relative to this package's own install location.
 * This only resolves inside the rs-graph monorepo during development — real standalone
 * distribution (a `dotnet tool`, or a bundled self-contained binary) is a packaging decision
 * for later; `RS_GRAPH_DOTNET_INDEXER_DLL` is an escape hatch until then.
 */
function findDotnetIndexerDll(): string | undefined {
  const override = process.env.RS_GRAPH_DOTNET_INDEXER_DLL;
  if (override && fs.existsSync(override)) return override;

  const binRoot = path.resolve(import.meta.dirname, "../../../indexer-dotnet/src/bin");
  if (!fs.existsSync(binRoot)) return undefined;

  const stack = [binRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "RsGraph.Indexer.Dotnet.dll") return full;
    }
  }
  return undefined;
}

function runDotnetIndexer(dllPath: string, targetPath: string, repoRoot: string): Promise<GraphRecord[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", [dllPath, targetPath, repoRoot], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (stderr.trim()) console.error(stderr.trim());
      if (code !== 0) {
        reject(new Error(`indexer-dotnet exited with code ${code}`));
        return;
      }
      resolve(
        stdout
          .split("\n")
          .map(parseGraphRecordLine)
          .filter((r): r is GraphRecord => r !== undefined),
      );
    });
  });
}

/** Same development-mode resolution caveat as findDotnetIndexerDll — see its comment. */
function findPythonIndexerScript(): string | undefined {
  const override = process.env.RS_GRAPH_PYTHON_INDEXER_SCRIPT;
  if (override && fs.existsSync(override)) return override;

  const scriptPath = path.resolve(import.meta.dirname, "../../../indexer-python/src/main.py");
  return fs.existsSync(scriptPath) ? scriptPath : undefined;
}

function resolvePythonCommand(): string {
  return process.env.RS_GRAPH_PYTHON_COMMAND ?? (process.platform === "win32" ? "python" : "python3");
}

function runPythonIndexer(scriptPath: string, targetPath: string, repoRoot: string): Promise<GraphRecord[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePythonCommand(), [scriptPath, targetPath, repoRoot], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (stderr.trim()) console.error(stderr.trim());
      if (code !== 0) {
        reject(new Error(`indexer-python exited with code ${code}`));
        return;
      }
      resolve(
        stdout
          .split("\n")
          .map(parseGraphRecordLine)
          .filter((r): r is GraphRecord => r !== undefined),
      );
    });
  });
}

function runTypeScriptIndexer(tsconfigPath: string, repoRoot: string): GraphRecord[] {
  const { program, checker, ownedFiles, compilerOptions } = loadProgram(tsconfigPath);
  const sink = new ArraySink();
  const externalSymbols = new ExternalSymbolRegistry("typescript", (d) => `external:${d.groupKey ?? "unknown"}`);

  new TsGraphBuilder(repoRoot, sink, externalSymbols, checker, ownedFiles, compilerOptions).process(program);
  new AngularEnricher(repoRoot, sink, checker, ownedFiles).process(program);
  new AureliaEnricher(repoRoot, sink, checker, ownedFiles).process(program);
  for (const record of externalSymbols.flush()) sink.write(record);

  return sink.records;
}

export interface RunIndexOptions {
  /** Explicit .sln/.slnx (or .csproj) path, overriding auto-detection when a repo has more
   * than one and the wrong one gets picked. Relative paths are resolved against targetPath. */
  slnPath?: string;
  /** Explicit tsconfig.json path, same override rationale as slnPath. */
  tsconfigPath?: string;
  /** Delete any existing .rs-graph/graph.db before indexing, for a guaranteed-clean rebuild
   * (e.g. recovering from a database left in a bad state by an interrupted/crashed prior run,
   * or from an older, buggier version of an indexer). */
  fresh?: boolean;
}

function resolveAgainst(targetPath: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(targetPath, maybeRelative);
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/**
 * Wraps ingestGraphRecords so a duplicate-symbol-id constraint failure (most commonly: stale
 * data left in .rs-graph/graph.db by an older, buggier indexer version, or by an interrupted
 * prior run) surfaces as an actionable message instead of a raw SqliteError stack trace.
 * ingestGraphRecords runs inside a single db.transaction, so a thrown error has already been
 * rolled back — the database is left exactly as it was before this call.
 */
function ingestOrExit(db: GraphDb, records: GraphRecord[], language: string): ReturnType<typeof ingestGraphRecords> {
  try {
    return ingestGraphRecords(db, records);
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    console.error(
      `\n  - ${language}: ingest failed — .rs-graph/graph.db has a duplicate symbol id. This usually means ` +
        "it holds stale data from an older rs-graph version or an interrupted prior run.\n" +
        "    Fix: re-run with --fresh to delete .rs-graph/ and rebuild the database from scratch.\n",
    );
    closeGraphDb(db);
    process.exit(1);
  }
}

export async function runIndex(targetPath: string, options: RunIndexOptions = {}): Promise<void> {
  const detection = detectProjects(targetPath);

  if (detection.languages.size === 0) {
    console.log(
      "No recognized project type found under this path (looked for .sln/.csproj, package.json with @angular/core or aurelia, requirements.txt/pyproject.toml/setup.py).",
    );
    return;
  }

  const frameworkSuffix =
    detection.frameworks.size > 0 ? ` (frameworks: ${[...detection.frameworks].join(", ")})` : "";
  console.log(`Detected: ${[...detection.languages].join(", ")}${frameworkSuffix}`);

  const rsGraphDir = path.join(targetPath, ".rs-graph");
  const dbPath = path.join(rsGraphDir, "graph.db");
  if (options.fresh && fs.existsSync(rsGraphDir)) {
    console.log("  --fresh: removing existing .rs-graph/ before indexing...");
    fs.rmSync(rsGraphDir, { recursive: true, force: true });
  }
  const db = openGraphDb({ dbPath });

  try {
    for (const language of detection.languages) {
      if (language === "csharp") {
        const dllPath = findDotnetIndexerDll();
        if (!dllPath) {
          console.log(
            "  - csharp: indexer-dotnet isn't built yet — run `dotnet build` in packages/indexer-dotnet/src first.",
          );
          continue;
        }
        let target: string | undefined;
        if (options.slnPath) {
          target = resolveAgainst(targetPath, options.slnPath);
          if (!fs.existsSync(target)) {
            console.log(`  - csharp: --sln path not found: ${target}`);
            continue;
          }
        } else {
          target = detection.markers.slnFiles[0] ?? detection.markers.csprojFiles[0];
          if (detection.markers.slnFiles.length > 1) {
            console.log(
              `  - csharp: found ${detection.markers.slnFiles.length} .sln/.slnx files, using ` +
                `${target ? path.basename(target) : "(none)"} — pass --sln <path> to pick a different one.`,
            );
          }
        }
        if (!target) continue;
        console.log(`  - csharp: indexing ${path.basename(target)}...`);
        const records = await runDotnetIndexer(dllPath, target, targetPath);
        console.log(`    ${JSON.stringify(ingestOrExit(db, records, "csharp"))}`);
      } else if (language === "typescript") {
        let tsconfigPath: string;
        if (options.tsconfigPath) {
          tsconfigPath = resolveAgainst(targetPath, options.tsconfigPath);
          if (!fs.existsSync(tsconfigPath)) {
            console.log(`  - typescript: --tsconfig path not found: ${tsconfigPath}`);
            continue;
          }
        } else {
          try {
            tsconfigPath = findTsConfig(targetPath);
          } catch {
            console.log("  - typescript: no tsconfig.json found — skipping.");
            continue;
          }
        }
        console.log(`  - typescript: indexing via ${path.basename(tsconfigPath)}...`);
        const records = runTypeScriptIndexer(tsconfigPath, targetPath);
        console.log(`    ${JSON.stringify(ingestOrExit(db, records, "typescript"))}`);
      } else if (language === "python") {
        const scriptPath = findPythonIndexerScript();
        if (!scriptPath) {
          console.log("  - python: indexer-python script not found.");
          continue;
        }
        console.log("  - python: indexing...");
        const records = await runPythonIndexer(scriptPath, targetPath, targetPath);
        console.log(`    ${JSON.stringify(ingestOrExit(db, records, "python"))}`);
      } else {
        console.log(`  - ${language}: no indexer available yet — coming in a later phase.`);
      }
    }
  } finally {
    closeGraphDb(db);
  }
}
