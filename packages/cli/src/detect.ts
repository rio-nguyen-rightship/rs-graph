import * as fs from "node:fs";
import * as path from "node:path";

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "bin",
  "obj",
  "dist",
  ".rs-graph",
  "__pycache__",
  "venv",
  ".venv",
]);

export type DetectedLanguage = "csharp" | "typescript" | "python";
export type DetectedFramework =
  | "angular"
  | "aurelia"
  | "aspnetcore"
  | "flask"
  | "fastapi"
  | "django";

export interface ProjectDetection {
  languages: Set<DetectedLanguage>;
  frameworks: Set<DetectedFramework>;
  markers: {
    slnFiles: string[];
    csprojFiles: string[];
    packageJsonFiles: string[];
    pythonProjectFiles: string[];
  };
}

/** Bounded breadth-first walk skipping build output / dependency / VCS directories. Good
 * enough for project-type detection; the real per-language indexers do their own precise
 * project-file discovery (e.g. following .sln references) once a language is known. */
export function walk(root: string, maxFiles = 20_000): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && results.length < maxFiles) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIR_NAMES.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        results.push(path.join(dir, entry.name));
      }
    }
  }
  return results;
}

function readTextSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function fileContainsAny(filePath: string, needles: string[]): boolean {
  const content = readTextSafe(filePath);
  return needles.some((needle) => content.includes(needle));
}

export function detectProjects(root: string): ProjectDetection {
  const files = walk(root);
  const languages = new Set<DetectedLanguage>();
  const frameworks = new Set<DetectedFramework>();

  const slnFiles = files.filter((f) => f.endsWith(".sln") || f.endsWith(".slnx"));
  const csprojFiles = files.filter((f) => f.endsWith(".csproj"));
  const packageJsonFiles = files.filter((f) => path.basename(f) === "package.json");
  const pythonProjectFiles = files.filter((f) =>
    ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"].includes(path.basename(f)),
  );

  if (slnFiles.length > 0 || csprojFiles.length > 0) {
    languages.add("csharp");
    if (
      csprojFiles.some((f) =>
        fileContainsAny(f, ["Microsoft.NET.Sdk.Web", "Microsoft.AspNetCore"]),
      )
    ) {
      frameworks.add("aspnetcore");
    }
  }

  for (const pkgPath of packageJsonFiles) {
    const raw = readTextSafe(pkgPath);
    if (!raw) continue;
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["@angular/core"]) {
      languages.add("typescript");
      frameworks.add("angular");
    }
    if (deps["aurelia-framework"] || deps["aurelia-bootstrapper"] || deps["@aurelia/runtime"]) {
      languages.add("typescript");
      frameworks.add("aurelia");
    }
  }
  // package.json + tsconfig.json but no recognized framework: still plain TypeScript.
  if (!languages.has("typescript") && packageJsonFiles.length > 0) {
    if (files.some((f) => path.basename(f) === "tsconfig.json")) {
      languages.add("typescript");
    }
  }

  if (pythonProjectFiles.length > 0) {
    languages.add("python");
    for (const marker of pythonProjectFiles) {
      if (fileContainsAny(marker, ["Flask", "flask"])) frameworks.add("flask");
      if (fileContainsAny(marker, ["fastapi", "FastAPI"])) frameworks.add("fastapi");
      if (fileContainsAny(marker, ["Django", "django"])) frameworks.add("django");
    }
  }

  return {
    languages,
    frameworks,
    markers: { slnFiles, csprojFiles, packageJsonFiles, pythonProjectFiles },
  };
}
