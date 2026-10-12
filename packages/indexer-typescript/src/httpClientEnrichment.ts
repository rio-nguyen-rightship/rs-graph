import * as path from "node:path";
import * as ts from "typescript";
import type { RecordSink } from "./sink.js";
import { buildCrossRepoRouteKey, normalizeRouteTemplate } from "./routeKey.js";
import { buildOwnedId, resolvePackageName } from "./symbolUtils.js";

const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch"]);

/**
 * Detects Angular `HttpClient` calls (`this.http.get(url)`/`.post(url)`/...) and emits the same
 * cross-repo INVOKES_ROUTE edge shape indexer-dotnet's raw-HttpClient/NSwag-[RouteUrl] passes do
 * — a real codebase mixes generated SDK clients with hand-written HTTP calls, and this covers the
 * TypeScript side of the latter. Mirrors AngularEnricher's constructor shape and per-file walk.
 */
export class HttpClientEnrichment {
  constructor(
    private readonly repoRoot: string,
    private readonly sink: RecordSink,
    private readonly checker: ts.TypeChecker,
    private readonly ownedFiles: ReadonlySet<string>,
  ) {}

  process(program: ts.Program): void {
    for (const sourceFile of program.getSourceFiles()) {
      if (!this.ownedFiles.has(path.resolve(sourceFile.fileName))) continue;

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) this.tryEmitHttpClientCall(node, sourceFile);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  private tryEmitHttpClientCall(node: ts.CallExpression, sourceFile: ts.SourceFile): void {
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    if (!HTTP_METHODS.has(node.expression.name.text)) return;
    if (!this.isAngularHttpClient(node.expression.expression)) return;

    const template = this.extractUrlTemplate(node.arguments[0]);
    if (template === undefined) return;

    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    this.sink.write({
      record: "edge",
      edgeType: "INVOKES_ROUTE",
      from: buildOwnedId(this.repoRoot, node),
      to: buildCrossRepoRouteKey(normalizeRouteTemplate(template)),
      line: start.line + 1,
      col: start.character + 1,
    });
  }

  /** Confirms the call's receiver resolves to @angular/common/http's HttpClient specifically
   * (not just any `.get(...)`, e.g. a Map or an unrelated service with the same method name). */
  private isAngularHttpClient(receiver: ts.Expression): boolean {
    const symbol = this.checker.getTypeAtLocation(receiver).getSymbol();
    const declaration = symbol?.declarations?.[0];
    if (!symbol || !declaration) return false;
    return symbol.name === "HttpClient" && resolvePackageName(declaration.getSourceFile().fileName) === "@angular/common";
  }

  /** A plain string/no-substitution template literal is used as-is; a template literal with
   * interpolations has each `${expr}` slot collapsed to the same `{}` placeholder
   * normalizeRouteTemplate uses, since the interpolated expression's text (a local variable name)
   * has no reason to match the route's own declared parameter name. Anything else — string
   * concatenation, a pre-built variable — is skipped rather than guessed at. */
  private extractUrlTemplate(expression: ts.Expression | undefined): string | undefined {
    if (!expression) return undefined;
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isTemplateExpression(expression)) {
      let result = expression.head.text;
      for (const span of expression.templateSpans) result += `{}${span.literal.text}`;
      return result;
    }
    return undefined;
  }
}
