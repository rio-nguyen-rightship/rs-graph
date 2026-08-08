#!/usr/bin/env node
import * as path from "node:path";
import { ExternalSymbolRegistry } from "@rs-graph/core-schema";
import { AngularEnricher } from "./angularEnrichment.js";
import { AureliaEnricher } from "./aureliaEnrichment.js";
import { TsGraphBuilder } from "./graphBuilder.js";
import { findTsConfig, loadProgram } from "./program.js";
import { NdjsonSink } from "./sink.js";

function main(): void {
  const [targetPathArg, repoRootArg] = process.argv.slice(2);
  if (!targetPathArg) {
    console.error("usage: rs-graph-indexer-typescript <path-to-tsconfig.json-or-directory> [repoRoot]");
    process.exit(1);
  }

  const tsconfigPath = findTsConfig(targetPathArg);
  const repoRoot = repoRootArg ? path.resolve(repoRootArg) : path.dirname(tsconfigPath);

  const { program, checker, ownedFiles, compilerOptions } = loadProgram(tsconfigPath);
  const sink = new NdjsonSink(process.stdout);
  const externalSymbols = new ExternalSymbolRegistry("typescript", (d) => `external:${d.groupKey ?? "unknown"}`);

  new TsGraphBuilder(repoRoot, sink, externalSymbols, checker, ownedFiles, compilerOptions).process(program);
  new AngularEnricher(repoRoot, sink, checker, ownedFiles).process(program);
  new AureliaEnricher(repoRoot, sink, checker, ownedFiles).process(program);

  for (const record of externalSymbols.flush()) sink.write(record);
}

main();
