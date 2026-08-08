import * as fs from "node:fs";
import * as path from "node:path";
import type { Language } from "./types.js";

export interface RepoInfo {
  path: string;
  language: Language;
}

/** packages/eval/dist -> repo root, three levels up. */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const BUILTIN_REPOS: Record<string, RepoInfo> = {
  "fixture-dotnet": { path: path.join(REPO_ROOT, "fixtures", "sample-dotnet-api"), language: "csharp" },
  "fixture-angular": { path: path.join(REPO_ROOT, "fixtures", "sample-angular-app"), language: "typescript" },
};

const USER_CONFIG_PATH = path.join(REPO_ROOT, "packages", "eval", "repos.config.json");

function loadUserRepos(): Record<string, RepoInfo> {
  if (!fs.existsSync(USER_CONFIG_PATH)) return {};
  return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) as Record<string, RepoInfo>;
}

/** Resolves a task's repoKey to an absolute path + language. Built-in fixture keys always
 * work; anything else must be declared in the gitignored repos.config.json (real repo paths
 * are machine-specific and shouldn't be committed) — see repos.config.example.json. */
export function resolveRepo(repoKey: string): RepoInfo {
  const builtin = BUILTIN_REPOS[repoKey];
  if (builtin) return builtin;
  const entry = loadUserRepos()[repoKey];
  if (!entry) {
    throw new Error(
      `Unknown repo key "${repoKey}". Built-in: ${Object.keys(BUILTIN_REPOS).join(", ")}. ` +
        `For real repos, add an entry to packages/eval/repos.config.json (see repos.config.example.json), ` +
        `then run 'rs-graph index --fresh <path>' on it before evaluating.`,
    );
  }
  return entry;
}
