import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import type { RecordSink } from "./sink.js";
import { buildOwnedId, getSpanLines, toRepoRelativePath } from "./symbolUtils.js";

/**
 * Angular-specific enrichment over the same Program the main TsGraphBuilder pass already
 * walked. Reuses `buildOwnedId` so ids line up with the Symbol rows the main pass emitted.
 *
 * Template binding extraction is a pragmatic regex heuristic (interpolations, property/event
 * bindings, `*ngIf`-style structural directives → identifier tokens matched against the
 * component class's own member names) rather than a full `@angular/compiler` template parse.
 * It isn't expression-scope-aware, but it captures the practical signal MCP tools need ("what
 * does this template reference on the component") without depending on `@angular/compiler`'s
 * template AST at all. Upgradeable later to a real template parse if precision matters more
 * than simplicity.
 */
export class AngularEnricher {
  constructor(
    private readonly repoRoot: string,
    private readonly sink: RecordSink,
    private readonly checker: ts.TypeChecker,
    private readonly ownedFiles: ReadonlySet<string>,
  ) {}

  process(program: ts.Program): void {
    for (const sourceFile of program.getSourceFiles()) {
      if (!this.ownedFiles.has(path.resolve(sourceFile.fileName))) continue;
      const relPath = toRepoRelativePath(this.repoRoot, sourceFile.fileName);

      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) && node.name) this.handleClassDecorators(node, sourceFile);
        if (ts.isVariableDeclaration(node)) this.handleRoutesArray(node, sourceFile, relPath);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  private handleClassDecorators(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): void {
    for (const decorator of ts.getDecorators(node) ?? []) {
      if (!ts.isCallExpression(decorator.expression)) continue;
      const callee = decorator.expression.expression;
      if (!ts.isIdentifier(callee)) continue;

      if (callee.text === "Component") {
        const config = decorator.expression.arguments[0];
        this.emitComponent(node, sourceFile, "angular", config && ts.isObjectLiteralExpression(config) ? config : undefined);
      }
    }
  }

  private emitComponent(
    node: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    framework: "angular",
    config: ts.ObjectLiteralExpression | undefined,
  ): void {
    const classId = buildOwnedId(this.repoRoot, node);
    let selector: string | undefined;
    let templateAbsPath: string | undefined;
    let inlineTemplate: string | undefined;

    for (const prop of config?.properties ?? []) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      const init = prop.initializer;
      if (prop.name.text === "selector" && ts.isStringLiteralLike(init)) selector = init.text;
      if (prop.name.text === "templateUrl" && ts.isStringLiteralLike(init)) {
        templateAbsPath = path.resolve(path.dirname(sourceFile.fileName), init.text);
      }
      if (prop.name.text === "template" && ts.isStringLiteralLike(init)) inlineTemplate = init.text;
    }

    this.sink.write({
      record: "component",
      id: classId,
      name: node.name!.text,
      selector,
      framework,
      templatePath: templateAbsPath ? toRepoRelativePath(this.repoRoot, templateAbsPath) : undefined,
    });

    const templateText =
      templateAbsPath && fs.existsSync(templateAbsPath) ? fs.readFileSync(templateAbsPath, "utf8") : inlineTemplate;
    if (templateText) this.emitTemplateBindings(templateText, node, classId);
  }

  private emitTemplateBindings(templateText: string, classNode: ts.ClassDeclaration, componentId: string): void {
    const memberByName = new Map<string, ts.ClassElement>();
    for (const member of classNode.members) {
      const name = (member as ts.NamedDeclaration).name;
      if (name && ts.isIdentifier(name)) memberByName.set(name.text, member);
    }
    if (memberByName.size === 0) return;

    const expressions: string[] = [];
    for (const m of templateText.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)) expressions.push(m[1] ?? "");
    for (const m of templateText.matchAll(/[[(][\w.-]+[\])]\s*=\s*"([^"]*)"/g)) expressions.push(m[1] ?? "");
    for (const m of templateText.matchAll(/\*ng\w+\s*=\s*"([^"]*)"/g)) expressions.push(m[1] ?? "");

    const emitted = new Set<string>();
    for (const expr of expressions) {
      for (const idMatch of expr.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const identifier = idMatch[0];
        const member = memberByName.get(identifier);
        if (!member || emitted.has(identifier)) continue;
        emitted.add(identifier);
        this.sink.write({
          record: "edge",
          edgeType: "BINDS_TEMPLATE",
          from: componentId,
          to: buildOwnedId(this.repoRoot, member),
        });
      }
    }
  }

  private handleRoutesArray(node: ts.VariableDeclaration, sourceFile: ts.SourceFile, relPath: string): void {
    if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer)) return;

    for (const element of node.initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const pathProp = this.findProp(element, "path");
      const componentProp = this.findProp(element, "component");
      if (!pathProp || !ts.isStringLiteralLike(pathProp.initializer)) continue;
      if (!componentProp || !ts.isIdentifier(componentProp.initializer)) continue;

      const rawSymbol = this.checker.getSymbolAtLocation(componentProp.initializer);
      const symbol = rawSymbol && rawSymbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(rawSymbol) : rawSymbol;
      const decl = symbol?.declarations?.[0];
      if (!decl || !ts.isClassDeclaration(decl) || !this.ownedFiles.has(path.resolve(decl.getSourceFile().fileName))) {
        continue;
      }

      const componentId = buildOwnedId(this.repoRoot, decl);
      const routePath = pathProp.initializer.text;
      const routeId = `typescript:route:${componentId}:${routePath}`;
      const span = getSpanLines(element, sourceFile);

      this.sink.write({
        record: "symbol",
        id: routeId,
        name: `ROUTE ${routePath || "/"}`,
        kind: "Route",
        signature: element.getText(),
        filePath: relPath,
        startLine: span.startLine,
        endLine: span.endLine,
        modifiers: [],
        external: false,
      });
      this.sink.write({ record: "edge", edgeType: "DEFINES", from: relPath, to: routeId });
      this.sink.write({ record: "edge", edgeType: "ROUTES_TO", from: routeId, to: componentId });
    }
  }

  private findProp(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
    return obj.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
    );
  }
}
