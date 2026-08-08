import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDef } from "../types.js";

/** Mirrors watch.ts's IGNORED_DIR_NAMES — a re-index/search baseline shouldn't wander into
 * build output or dependency trees any more than the real tool does. */
const IGNORED_DIR_NAMES = new Set(["node_modules", "bin", "obj", "dist", ".git", ".rs-graph"]);

function isIgnoredSegment(segment: string): boolean {
  return IGNORED_DIR_NAMES.has(segment) || segment.startsWith(".");
}

/** Resolves a repo-relative path and refuses anything that escapes repoRoot — the baseline
 * arm's tools take paths from model output, and this is a benchmark harness, not a sandboxed
 * product surface, so this is a cheap backstop rather than the last line of defense. */
function resolveSafe(repoRoot: string, relPath: string): string {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes repo root: ${relPath}`);
  }
  return resolved;
}

function walk(root: string, dir: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (isIgnoredSegment(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out, limit);
    } else {
      out.push(path.relative(root, full).replaceAll("\\", "/"));
    }
  }
}

/** The grep/Read baseline arm: three tools standing in for what an agent actually reaches for
 * without rs-graph — a recursive text search, a file reader with line-range support (so it
 * isn't artificially crippled versus Claude Code's real Read tool), and a directory listing.
 * No external `grep`/`rg` binary dependency — implemented directly so the eval harness doesn't
 * depend on what's installed on the machine running it. */
export function createFsTools(repoRoot: string): ToolDef[] {
  return [
    {
      name: "grep",
      description:
        "Recursively search file contents for a regular expression under the repo root. Returns matching lines as 'path:line: text', capped at 200 matches.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression (JavaScript RegExp syntax)" },
          path: { type: "string", description: "Directory to search under, relative to repo root. Defaults to the whole repo." },
          caseInsensitive: { type: "boolean" },
        },
        required: ["pattern"],
      },
      handler: async (input) => {
        const pattern = String(input.pattern ?? "");
        const searchDir = resolveSafe(repoRoot, (input.path as string | undefined) ?? ".");
        const flags = input.caseInsensitive ? "i" : "";
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, flags);
        } catch (err) {
          return `Invalid regex: ${(err as Error).message}`;
        }
        const files: string[] = [];
        walk(repoRoot, searchDir, files, 5000);
        const matches: string[] = [];
        for (const relFile of files) {
          if (matches.length >= 200) break;
          const abs = path.join(repoRoot, relFile);
          let content: string;
          try {
            content = fs.readFileSync(abs, "utf8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= 200) break;
            if (regex.test(lines[i] ?? "")) {
              matches.push(`${relFile}:${i + 1}: ${(lines[i] ?? "").trim()}`);
            }
          }
        }
        return matches.length > 0 ? matches.join("\n") : "(no matches)";
      },
    },
    {
      name: "read_file",
      description: "Read a file's contents, optionally a line range. Path is relative to the repo root.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "1-indexed starting line" },
          limit: { type: "number", description: "Max lines to read" },
        },
        required: ["path"],
      },
      handler: async (input) => {
        const abs = resolveSafe(repoRoot, String(input.path ?? ""));
        let content: string;
        try {
          content = fs.readFileSync(abs, "utf8");
        } catch (err) {
          return `Could not read file: ${(err as Error).message}`;
        }
        const lines = content.split("\n");
        const offset = Math.max(1, Number(input.offset ?? 1));
        const limit = Number(input.limit ?? 2000);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        return slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
      },
    },
    {
      name: "list_files",
      description: "Recursively list files under a directory (relative to repo root), capped at 500 entries.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string", description: "Defaults to the repo root" } },
        required: [],
      },
      handler: async (input) => {
        const dir = resolveSafe(repoRoot, (input.path as string | undefined) ?? ".");
        const files: string[] = [];
        walk(repoRoot, dir, files, 500);
        return files.length > 0 ? files.join("\n") : "(empty)";
      },
    },
  ];
}
