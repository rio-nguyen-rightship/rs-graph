#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import { runDoctor } from "./commands/doctor.js";
import { runGenerateManifest } from "./commands/generateManifest.js";
import { runInit } from "./commands/init.js";
import { runIndex } from "./commands/indexRepo.js";
import { runIndexWorkspace } from "./commands/indexWorkspace.js";
import { installHook, installHookWorkspace } from "./commands/installHook.js";
import { runServe } from "./commands/serve.js";
import { runServeWorkspace } from "./commands/serveWorkspace.js";
import { runWatch, runWatchWorkspace } from "./commands/watch.js";

const program = new Command();

program
  .name("rs-graph")
  .description("Turn a codebase into a queryable graph, served to coding agents over MCP.")
  .version("0.1.0");

program
  .command("init")
  .description("Set up .rs-graph/ in a repo (creates the graph database file)")
  .argument("[path]", "target repo path", ".")
  .action((targetPath: string) => runInit(path.resolve(targetPath)));

program
  .command("index")
  .description("Detect project types and (re)build the graph for a repo")
  .argument("[path]", "target repo path", ".")
  .option("--sln <path>", "specific .sln/.slnx (or .csproj) to index, if a repo has more than one")
  .option("--tsconfig <path>", "specific tsconfig.json to index, if a repo has more than one")
  .option("--fresh", "delete any existing .rs-graph/graph.db first (recovers from a stale/corrupted database)")
  .action((targetPath: string, opts: { sln?: string; tsconfig?: string; fresh?: boolean }) =>
    runIndex(path.resolve(targetPath), { slnPath: opts.sln, tsconfigPath: opts.tsconfig, fresh: opts.fresh }),
  );

program
  .command("index-workspace")
  .description("Index every repo listed in a workspace.json (see docs/mcp-tools.md), reporting a pass/skip/fail summary")
  .argument("<workspaceConfig>", "path to a workspace.json file")
  .option("--fresh", "delete any existing .rs-graph/graph.db first, for every repo in the workspace")
  .action((workspaceConfig: string, opts: { fresh?: boolean }) =>
    runIndexWorkspace(path.resolve(workspaceConfig), { fresh: opts.fresh }),
  );

program
  .command("generate-manifest")
  .description(
    "Write CROSS_REPO_MANIFEST.md/.json into every indexed repo in a workspace.json, summarizing " +
      "its cross-repo integration surface for a repo-scoped PR reviewer (see docs/mcp-tools.md)",
  )
  .argument("<workspaceConfig>", "path to a workspace.json file")
  .action((workspaceConfig: string) => runGenerateManifest(path.resolve(workspaceConfig)));

program
  .command("serve")
  .description("Start the MCP server for a repo's graph over stdio")
  .argument("[path]", "target repo path", ".")
  .action((targetPath: string) => runServe(path.resolve(targetPath)));

program
  .command("serve-workspace")
  .description("Start the MCP server exposing cross-repo tools for a workspace.json's repos over stdio")
  .argument("<workspaceConfig>", "path to a workspace.json file")
  .action((workspaceConfig: string) => runServeWorkspace(path.resolve(workspaceConfig)));

program
  .command("install-hook")
  .description(
    "Install a git post-merge hook that re-indexes this repo in the background after `git pull` (see docs/mcp-tools.md)",
  )
  .argument("[path]", "target repo path", ".")
  .action((targetPath: string) => installHook(path.resolve(targetPath)));

program
  .command("install-hook-workspace")
  .description("Install the post-merge hook into every repo listed in a workspace.json")
  .argument("<workspaceConfig>", "path to a workspace.json file")
  .action((workspaceConfig: string) => installHookWorkspace(path.resolve(workspaceConfig)));

program
  .command("watch")
  .description("Watch a repo for changes and incrementally re-index")
  .argument("[path]", "target repo path", ".")
  .option("--sln <path>", "specific .sln/.slnx (or .csproj) to index, if a repo has more than one")
  .option("--tsconfig <path>", "specific tsconfig.json to index, if a repo has more than one")
  .option("--fresh", "delete any existing .rs-graph/graph.db first (recovers from a stale/corrupted database)")
  .action((targetPath: string, opts: { sln?: string; tsconfig?: string; fresh?: boolean }) =>
    runWatch(path.resolve(targetPath), { slnPath: opts.sln, tsconfigPath: opts.tsconfig, fresh: opts.fresh }),
  );

program
  .command("watch-workspace")
  .description("Watch every repo listed in a workspace.json for changes and incrementally re-index each")
  .argument("<workspaceConfig>", "path to a workspace.json file")
  .option("--fresh", "delete any existing .rs-graph/graph.db first, for every repo in the workspace")
  .action((workspaceConfig: string, opts: { fresh?: boolean }) =>
    runWatchWorkspace(path.resolve(workspaceConfig), { fresh: opts.fresh }),
  );

program
  .command("doctor")
  .description(
    "Report whether this repo's graph is missing, stale, needs a .NET restore/build first, or looks degraded — read-only, never indexes or builds",
  )
  .argument("[path]", "target repo path", ".")
  .option("--json", "machine-readable output (for hooks and agent skills)")
  .action((targetPath: string, opts: { json?: boolean }) => runDoctor(path.resolve(targetPath), { json: opts.json }));

program.parseAsync(process.argv);
