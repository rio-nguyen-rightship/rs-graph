#!/usr/bin/env node
// Detached helper started by session-start.mjs: runs `rs-graph index` for one repo with its output
// appended to .rs-graph/hooks.log, and records how it ended. A separate process (rather than
// redirecting inside the hook) because shell redirection and inherited file descriptors behave
// differently across cmd.exe, Git Bash and POSIX shells; plain Node stdio redirection doesn't.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const projectDir = process.argv[2];
if (!projectDir) process.exit(0);

const log = fs.openSync(path.join(projectDir, ".rs-graph", "hooks.log"), "a");
const stamp = (message) => fs.writeSync(log, `[${new Date().toISOString()}] ${message}\n`);

// --no-mcp-config: the plugin registers the MCP server itself, so don't also drop an untracked
// .mcp.json entry into the repo.
const args = ["index", ".", "--no-mcp-config"];
// `rs-graph` is an npm-linked .cmd shim on Windows, which only resolves through a shell; every
// argument is a fixed, space-free token, so joining them into one command string is safe.
const useShell = process.platform === "win32";

const child = useShell
  ? spawn(`rs-graph ${args.join(" ")}`, [], { cwd: projectDir, shell: true, windowsHide: true, stdio: ["ignore", log, log] })
  : spawn("rs-graph", args, { cwd: projectDir, stdio: ["ignore", log, log] });

child.on("error", (err) => {
  stamp(`could not start rs-graph: ${err.message}`);
  process.exit(0);
});
child.on("exit", (code) => {
  stamp(`rs-graph index finished (exit ${code})`);
  process.exit(0);
});
