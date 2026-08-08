import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

export interface LoadedProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Absolute paths of files this tsconfig.json actually owns (its `include`d source, not
   * `node_modules`/lib .d.ts files pulled in transitively for type resolution). */
  ownedFiles: Set<string>;
  compilerOptions: ts.CompilerOptions;
}

/** Finds a tsconfig.json given a .json path, a directory containing one directly, or
 * (as a fallback) the nearest one found by a shallow walk — mirrors indexer-dotnet's
 * .sln/.csproj/directory discovery. */
export function findTsConfig(targetPath: string): string {
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) return path.resolve(targetPath);

  const direct = path.join(targetPath, "tsconfig.json");
  if (fs.existsSync(direct)) return path.resolve(direct);

  const ignored = new Set(["node_modules", "dist", ".git", ".rs-graph"]);
  const stack = [targetPath];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "tsconfig.json") return path.resolve(full);
      if (entry.isDirectory() && !entry.name.startsWith(".") && !ignored.has(entry.name)) stack.push(full);
    }
  }

  throw new Error(`No tsconfig.json found under ${targetPath}`);
}

/** Loads a tsconfig.json via the TypeScript Compiler API and builds a full type-checked
 * Program — purely static analysis against whatever's already on disk (source files +
 * whatever `node_modules` the developer already installed). Never invokes `npm install`. */
export function loadProgram(tsconfigPath: string): LoadedProgram {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const ownedFiles = new Set(parsed.fileNames.map((f) => path.resolve(f)));

  return { program, checker: program.getTypeChecker(), ownedFiles, compilerOptions: parsed.options };
}
