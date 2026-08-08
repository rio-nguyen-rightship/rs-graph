#!/usr/bin/env node
import { Command } from "commander";
import * as path from "node:path";
import { runInit } from "./commands/init.js";
import { runIndex } from "./commands/indexRepo.js";
import { runServe } from "./commands/serve.js";
import { runWatch } from "./commands/watch.js";

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
  .command("serve")
  .description("Start the MCP server for a repo's graph over stdio")
  .argument("[path]", "target repo path", ".")
  .action((targetPath: string) => runServe(path.resolve(targetPath)));

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

program.parseAsync(process.argv);
