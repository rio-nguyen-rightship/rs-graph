# rs-graph Claude Code plugin

Makes Claude Code use the rs-graph code graph without any per-repo setup:

- **SessionStart hook** ([hooks/session-start.mjs](hooks/session-start.mjs)) — in a git repo root with a
  recognized project, runs `rs-graph doctor` and, if the graph is missing or stale, re-indexes in the
  background (output and exit code go to `.rs-graph/hooks.log`). It then tells the agent the graph's state.
  It never runs restore/build: for a .NET repo that was never restored it only says so.
- **MCP server** ([.mcp.json](.mcp.json)) — `rs-graph serve .`. The server starts even before the graph
  exists and answers "not indexed yet" until it does, so a first-time index doesn't need a restart.
- **Skill** ([skills/rs-graph](skills/rs-graph/SKILL.md)) — when to use which `graph_*` tool, how to read
  the graph's status, when Grep is still the right call, and the cross-repo checks.

## Install

Prerequisite: the `rs-graph` CLI on `PATH` (`npm link --workspace @rs-graph/cli` from this repo, after
`npm run build`; rebuild after pulling changes).

```
/plugin marketplace add C:\Works\rs-graph
/plugin install rs-graph@rs-graph
```

Restart the session afterwards so the hook and MCP server load.

## Behaviour and opt-outs

| Env var | Effect |
| --- | --- |
| `RS_GRAPH_AUTO_INDEX=0` | hook does nothing |
| `RS_GRAPH_AUTO_INDEX=missing` | only builds graphs that don't exist; never re-indexes a stale one (a re-index recompiles the whole repo, slow on big .NET solutions) |

- Only a directory containing `.git` is handled, so a session opened in a folder that merely
  *contains* repos is left alone.
- `.rs-graph/` is added to `.git/info/exclude` (local to the clone, no tracked file changes) when the repo
  doesn't already ignore it.
- If the repo's own `.mcp.json` also registers `rs-graph` (from `rs-graph index`), the tools appear twice;
  remove the repo entry once the plugin is installed.
- Cross-repo tools (`rs-graph-workspace`) still come from the repo's `.mcp.json` written by
  `rs-graph index-workspace` — the plugin doesn't know where your `workspace.json` is.
