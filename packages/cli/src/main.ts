#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import { runDoctor } from "./commands/doctor.js";
import { runGenerateManifest } from "./commands/generateManifest.js";
import { runInit } from "./commands/init.js";
import { runIndex } from "./commands/indexRepo.js";
import { runIndexWorkspace } from "./commands/indexWorkspace.js";
import { installHook, installHookWorkspace } from "./commands/installHook.js";
import { installSkillsWorkspace, runInstallSkills } from "./commands/installSkills.js";
import { runQuery } from "./commands/query.js";
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
  .option("--no-mcp-config", "don't add an rs-graph entry to the repo's .mcp.json (the Claude Code plugin registers the server itself)")
  .action((targetPath: string, opts: { sln?: string; tsconfig?: string; fresh?: boolean; mcpConfig?: boolean }) =>
    runIndex(path.resolve(targetPath), {
      slnPath: opts.sln,
      tsconfigPath: opts.tsconfig,
      fresh: opts.fresh,
      skipMcpConfig: opts.mcpConfig === false,
    }),
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
  .command("install-skills")
  .description(
    "Copy the rs-graph skills into <path>/.claude/skills/ so they're committed with the repo — for repos or CI jobs where the Claude Code plugin isn't installed",
  )
  .argument("[path]", "target repo path", ".")
  .option("--force", "overwrite skill files that were edited locally")
  .action((targetPath: string, opts: { force?: boolean }) => runInstallSkills(path.resolve(targetPath), { force: opts.force }));

program
  .command("install-skills-workspace")
  .description("Install the skills into every repo listed in a workspace.json")
  .argument("<workspaceConfig>", "path to a workspace.json file")
  .option("--force", "overwrite skill files that were edited locally")
  .action((workspaceConfig: string, opts: { force?: boolean }) =>
    installSkillsWorkspace(path.resolve(workspaceConfig), { force: opts.force }),
  );

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
  .command("query")
  .description(
    "Run one graph tool from the shell (same handlers as the MCP server) — for agents or scripts without a registered MCP server. " +
      "`rs-graph query --list` shows every tool and its parameters; the tool name may be shortened, e.g. `callers`.",
  )
  .argument("[tool]", "tool name, or shorthand like `callers` / `route_map`")
  .option("--repo <path>", "repo whose graph to query", ".")
  .option("--workspace <workspace.json>", "query the cross-repo graph_workspace_* tools instead of one repo")
  .option("-a, --arg <key=value>", "a tool argument; repeatable, typed from the tool's schema", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--json <object>", 'all arguments as one JSON object, or "-" to read it from stdin')
  .option("--list", "list the available tools and their parameters")
  .option("--pretty", "pretty-print JSON output")
  .action(
    (
      tool: string | undefined,
      opts: { repo?: string; workspace?: string; arg: string[]; json?: string; list?: boolean; pretty?: boolean },
    ) => runQuery(tool, { repo: opts.repo, workspace: opts.workspace, args: opts.arg, json: opts.json, list: opts.list, pretty: opts.pretty }),
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
