import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import type { RecordSink } from "./sink.js";
import { buildOwnedId, toRepoRelativePath } from "./symbolUtils.js";

/**
 * Aurelia-specific enrichment over the same Program the main TsGraphBuilder pass already
 * walked. Aurelia 1.x's defining convention (unlike Angular, which always declares
 * templateUrl/selector via @Component) is that a view-model `foo.ts` and its view `foo.html`
 * pair up purely by filename — no decorator required — so component detection here is
 * primarily a filesystem-based naming match, with `@customElement(...)` supported as an
 * explicit alternative signal (closer to Aurelia 2 style).
 *
 * Template binding extraction reuses the same pragmatic regex-heuristic approach as
 * AngularEnricher, adapted to Aurelia's own template syntax: `${expr}` interpolation and
 * `attr.bind/trigger/delegate/call/one-time/two-way="expr"` binding commands, instead of
 * Angular's `{{ }}` and `[prop]`/`(event)` syntax.
 *
 * Router support covers the classic `configureRouter(config) { config.map([...]) }` pattern
 * with string `moduleId` route targets, resolved to the target file's exported component via
 * the TypeChecker's module exports (not by guessing a class-name convention).
 */
export class AureliaEnricher {
  private program!: ts.Program;

  constructor(
    private readonly repoRoot: string,
    private readonly sink: RecordSink,
    private readonly checker: ts.TypeChecker,
    private readonly ownedFiles: ReadonlySet<string>,
  ) {}

  process(program: ts.Program): void {
    this.program = program;
    const htmlByBaseName = this.buildHtmlSiblingMap();

    for (const sourceFile of program.getSourceFiles()) {
      if (!this.ownedFiles.has(path.resolve(sourceFile.fileName))) continue;
      const relPath = toRepoRelativePath(this.repoRoot, sourceFile.fileName);
      const baseName = relPath.replace(/\.tsx?$/, "");

      const visit = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) && node.name) {
          this.handleClass(node, baseName, htmlByBaseName);
          this.handleConfigureRouter(node, relPath);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }

  private buildHtmlSiblingMap(): Map<string, string> {
    const map = new Map<string, string>();
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          walk(full);
        } else if (entry.name.endsWith(".html")) {
          const rel = toRepoRelativePath(this.repoRoot, full);
          map.set(rel.slice(0, -".html".length), rel);
        }
      }
    };
    walk(this.repoRoot);
    return map;
  }

  private decoratorName(dec: ts.Decorator): string | undefined {
    const target = ts.isCallExpression(dec.expression) ? dec.expression.expression : dec.expression;
    return ts.isIdentifier(target) ? target.text : undefined;
  }

  private handleClass(node: ts.ClassDeclaration, baseName: string, htmlByBaseName: Map<string, string>): void {
    const decorators = ts.getDecorators(node) ?? [];
    // Angular's @Component-decorated classes are AngularEnricher's job, not ours — without
    // this guard, an Angular project's own `foo.component.ts` + `foo.component.html` naming
    // convention would also match Aurelia's filename-pairing heuristic and produce a second,
    // conflicting Component row for the same class id.
    if (decorators.some((d) => this.decoratorName(d) === "Component")) return;

    const customElementDecorator = decorators.find((d) => this.decoratorName(d) === "customElement");
    let selector: string | undefined;
    if (customElementDecorator && ts.isCallExpression(customElementDecorator.expression)) {
      const arg = customElementDecorator.expression.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) selector = arg.text;
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const nameProp = this.findProp(arg, "name");
        if (nameProp && ts.isStringLiteralLike(nameProp.initializer)) selector = nameProp.initializer.text;
      }
    }

    const templateRelPath = htmlByBaseName.get(baseName);
    if (!templateRelPath && !customElementDecorator) return; // not a component by either detection rule

    const classId = buildOwnedId(this.repoRoot, node);
    this.sink.write({
      record: "component",
      id: classId,
      name: node.name!.text,
      selector,
      framework: "aurelia",
      templatePath: templateRelPath,
    });

    if (templateRelPath) {
      const absTemplate = path.join(this.repoRoot, templateRelPath);
      if (fs.existsSync(absTemplate)) {
        this.emitTemplateBindings(fs.readFileSync(absTemplate, "utf8"), node, classId);
      }
    }
  }

  private emitTemplateBindings(templateText: string, classNode: ts.ClassDeclaration, componentId: string): void {
    const memberByName = new Map<string, ts.ClassElement>();
    for (const member of classNode.members) {
      const name = (member as ts.NamedDeclaration).name;
      if (name && ts.isIdentifier(name)) memberByName.set(name.text, member);
    }
    if (memberByName.size === 0) return;

    const expressions: string[] = [];
    for (const m of templateText.matchAll(/\$\{\s*([\s\S]*?)\s*\}/g)) expressions.push(m[1] ?? "");
    for (const m of templateText.matchAll(
      /[\w-]+\.(?:bind|trigger|delegate|call|one-time|two-way|one-way)="([^"]*)"/g,
    )) {
      expressions.push(m[1] ?? "");
    }

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

  private handleConfigureRouter(node: ts.ClassDeclaration, relPath: string): void {
    const configureRouterMethod = node.members.find(
      (m): m is ts.MethodDeclaration =>
        ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === "configureRouter" && !!m.body,
    );
    if (!configureRouterMethod?.body) return;

    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "map" &&
        n.arguments[0] &&
        ts.isArrayLiteralExpression(n.arguments[0])
      ) {
        for (const element of (n.arguments[0] as ts.ArrayLiteralExpression).elements) {
          if (ts.isObjectLiteralExpression(element)) this.emitAureliaRoute(element, relPath);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(configureRouterMethod.body);
  }

  private emitAureliaRoute(element: ts.ObjectLiteralExpression, relPath: string): void {
    const routeProp = this.findProp(element, "route");
    const moduleIdProp = this.findProp(element, "moduleId");
    if (!routeProp || !ts.isStringLiteralLike(routeProp.initializer)) return;
    if (!moduleIdProp || !ts.isStringLiteralLike(moduleIdProp.initializer)) return;

    const targetComponentId = this.resolveModuleIdToComponentId(moduleIdProp.initializer.text, relPath);
    if (!targetComponentId) return;

    const routePath = routeProp.initializer.text;
    const routeId = `typescript:route:${targetComponentId}:${routePath}`;
    const span = element.getSourceFile().getLineAndCharacterOfPosition(element.getStart());

    this.sink.write({
      record: "symbol",
      id: routeId,
      name: `ROUTE ${routePath || "/"}`,
      kind: "Route",
      signature: element.getText(),
      filePath: relPath,
      startLine: span.line + 1,
      endLine: span.line + 1,
      modifiers: [],
      external: false,
    });
    this.sink.write({ record: "edge", edgeType: "DEFINES", from: relPath, to: routeId });
    this.sink.write({ record: "edge", edgeType: "ROUTES_TO", from: routeId, to: targetComponentId });
  }

  /** Resolves a string `moduleId` (Aurelia 1.x route targets are file references, not live
   * imports) to the target module's exported component class, via the TypeChecker's module
   * exports rather than guessing a class-name-matches-filename convention. */
  private resolveModuleIdToComponentId(moduleId: string, fromRelPath: string): string | undefined {
    const fromAbsDir = path.dirname(path.join(this.repoRoot, fromRelPath));
    const resolvedAbs = path.resolve(fromAbsDir, moduleId) + ".ts";
    if (!this.ownedFiles.has(resolvedAbs)) return undefined;

    const targetSourceFile = this.program.getSourceFile(resolvedAbs);
    if (!targetSourceFile) return undefined;

    const moduleSymbol = this.checker.getSymbolAtLocation(targetSourceFile);
    if (!moduleSymbol) return undefined;

    const exportedClass = this.checker
      .getExportsOfModule(moduleSymbol)
      .map((s) => s.declarations?.[0])
      .find((d): d is ts.ClassDeclaration => !!d && ts.isClassDeclaration(d));

    return exportedClass ? buildOwnedId(this.repoRoot, exportedClass) : undefined;
  }

  private findProp(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
    return obj.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
    );
  }
}
