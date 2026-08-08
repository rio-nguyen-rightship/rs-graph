import { createHash } from "node:crypto";
import * as path from "node:path";
import * as ts from "typescript";
import { ExternalSymbolRegistry } from "@rs-graph/core-schema";
import type { RecordSink } from "./sink.js";
import {
  buildOwnedId,
  buildQualifiedName,
  getDeclarationKind,
  getDocSummary,
  getModifiers,
  renderSignature,
  resolvePackageName,
  toRepoRelativePath,
} from "./symbolUtils.js";

type TypeDecl = ts.ClassDeclaration | ts.InterfaceDeclaration | ts.EnumDeclaration;

export class TsGraphBuilder {
  private readonly emittedIds = new Set<string>();

  constructor(
    private readonly repoRoot: string,
    private readonly sink: RecordSink,
    private readonly externalSymbols: ExternalSymbolRegistry,
    private readonly checker: ts.TypeChecker,
    private readonly ownedFiles: ReadonlySet<string>,
    private readonly compilerOptions: ts.CompilerOptions,
  ) {}

  process(program: ts.Program): void {
    for (const sourceFile of program.getSourceFiles()) {
      if (!this.ownedFiles.has(path.resolve(sourceFile.fileName))) continue;
      this.processFile(sourceFile);
    }
  }

  private processFile(sourceFile: ts.SourceFile): void {
    const relPath = toRepoRelativePath(this.repoRoot, sourceFile.fileName);
    this.emitFileRecord(sourceFile, relPath);

    const visitTop = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
        this.emitType(node, sourceFile, relPath);
        return; // members handled inside emitType — don't re-descend into the body
      }
      if (ts.isFunctionDeclaration(node) && node.body && node.name) {
        this.emitCallable(node, sourceFile, relPath);
        return;
      }
      ts.forEachChild(node, visitTop);
    };
    visitTop(sourceFile);

    this.emitImportEdges(sourceFile, relPath);
    this.emitCallEdges(sourceFile);
  }

  private emitFileRecord(sourceFile: ts.SourceFile, relPath: string): void {
    const bytes = Buffer.from(sourceFile.getFullText(), "utf8");
    this.sink.write({
      record: "file",
      path: relPath,
      language: "typescript",
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    });
  }

  private emitType(node: TypeDecl, sourceFile: ts.SourceFile, relPath: string): void {
    if (!node.name) return; // anonymous default-export class/enum — skip for MVP

    const id = buildOwnedId(this.repoRoot, node);
    if (this.emittedIds.has(id)) return;
    this.emittedIds.add(id);

    const span = this.getSpan(node, sourceFile);
    this.sink.write({
      record: "symbol",
      id,
      name: node.name.text,
      kind: getDeclarationKind(node),
      signature: renderSignature(node, this.checker),
      docSummary: getDocSummary(node, this.checker),
      filePath: relPath,
      ...span,
      modifiers: getModifiers(node),
      external: false,
    });
    this.sink.write({ record: "edge", edgeType: "DEFINES", from: relPath, to: id });

    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      for (const clause of node.heritageClauses ?? []) {
        const edgeType = clause.token === ts.SyntaxKind.ExtendsKeyword ? "EXTENDS" : "IMPLEMENTS";
        for (const t of clause.types) {
          const symbol = this.resolveAliasedSymbol(this.checker.getSymbolAtLocation(t.expression));
          if (!symbol) continue;
          this.sink.write({ record: "edge", edgeType, from: id, to: this.resolveSymbolId(symbol) });
          if (ts.isClassDeclaration(node) && edgeType === "IMPLEMENTS") {
            this.emitInterfaceMemberImplementations(node, symbol);
          }
        }
      }
    }

    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      for (const member of node.members) this.emitMember(member, sourceFile, relPath, id);
    }
  }

  /**
   * Emits a member-level IMPLEMENTS edge for each interface member matched by name to a class
   * member, on top of the class-level IMPLEMENTS edge already emitted by the caller.
   *
   * Closes the same gap as indexer-dotnet's EmitInterfaceMemberImplementations: real code
   * overwhelmingly calls through an interface-typed reference (a constructor-injected service
   * typed as its interface), so the TypeChecker resolves the call target to the *interface*
   * member, never the concrete class member directly. Without this edge,
   * graph_get_callers/graph_get_references on the concrete member would silently return empty
   * even when it's heavily called — graph-store's polymorphism-aware traversal needs this edge
   * to know the two are the same call target. TS has no compiler API for "find the class member
   * implementing this interface member" (unlike Roslyn's FindImplementationForInterfaceMember)
   * since implementation is purely structural — matching by member name is the practical
   * equivalent here.
   */
  private emitInterfaceMemberImplementations(classNode: ts.ClassDeclaration, interfaceSymbol: ts.Symbol): void {
    const interfaceMembersByName = new Map<string, ts.Symbol>();
    interfaceSymbol.members?.forEach((member, escapedName) => {
      interfaceMembersByName.set(String(escapedName), member);
    });
    if (interfaceMembersByName.size === 0) return;

    for (const classMember of classNode.members) {
      const name = (classMember as ts.NamedDeclaration).name;
      if (!name || !ts.isIdentifier(name)) continue;

      const interfaceMember = interfaceMembersByName.get(name.text);
      if (!interfaceMember?.declarations?.[0]) continue;

      const classMemberId = buildOwnedId(this.repoRoot, classMember);
      const interfaceMemberId = this.resolveSymbolId(interfaceMember);
      this.sink.write({ record: "edge", edgeType: "IMPLEMENTS", from: classMemberId, to: interfaceMemberId });
    }
  }

  private emitMember(
    member: ts.ClassElement | ts.TypeElement,
    sourceFile: ts.SourceFile,
    relPath: string,
    classId: string,
  ): void {
    const isCallable =
      ts.isMethodDeclaration(member) ||
      ts.isConstructorDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member) ||
      ts.isPropertyDeclaration(member) ||
      ts.isMethodSignature(member) || // interface method — e.g. IGreeter.greet(name: string): string
      ts.isPropertySignature(member); // interface property
    if (!isCallable) return;
    if (ts.isMethodDeclaration(member) && !member.body) return; // overload signature; the implementation carries the body

    const nameNode = ts.isConstructorDeclaration(member) ? undefined : (member as ts.NamedDeclaration).name;
    if (nameNode && !ts.isIdentifier(nameNode)) return; // computed/string-literal member names — skip for MVP

    const id = buildOwnedId(this.repoRoot, member);
    if (this.emittedIds.has(id)) return; // safety net: catches any other duplicate-id edge case
    this.emittedIds.add(id);

    const span = this.getSpan(member, sourceFile);
    this.sink.write({
      record: "symbol",
      id,
      name: ts.isConstructorDeclaration(member) ? "constructor" : (nameNode as ts.Identifier).text,
      kind: getDeclarationKind(member),
      signature: renderSignature(member, this.checker),
      docSummary: getDocSummary(member, this.checker),
      filePath: relPath,
      ...span,
      modifiers: getModifiers(member),
      external: false,
    });
    this.sink.write({ record: "edge", edgeType: "DEFINES", from: relPath, to: id });

    if (ts.isConstructorDeclaration(member)) {
      for (const param of member.parameters) this.emitConstructorInjection(param, id);
    }
  }

  private emitCallable(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile, relPath: string): void {
    const id = buildOwnedId(this.repoRoot, node);
    if (this.emittedIds.has(id)) return;
    this.emittedIds.add(id);

    const span = this.getSpan(node, sourceFile);
    this.sink.write({
      record: "symbol",
      id,
      name: node.name!.text,
      kind: "Function",
      signature: renderSignature(node, this.checker),
      docSummary: getDocSummary(node, this.checker),
      filePath: relPath,
      ...span,
      modifiers: getModifiers(node),
      external: false,
    });
    this.sink.write({ record: "edge", edgeType: "DEFINES", from: relPath, to: id });
  }

  private emitConstructorInjection(param: ts.ParameterDeclaration, constructorId: string): void {
    if (!param.type || !ts.isTypeReferenceNode(param.type)) return;
    const typeName = param.type.typeName;
    const nameNode = ts.isQualifiedName(typeName) ? typeName.right : typeName;
    const symbol = this.resolveAliasedSymbol(this.checker.getSymbolAtLocation(nameNode));
    const decl = symbol?.declarations?.[0];
    if (!decl || !(ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl))) return;

    this.sink.write({
      record: "edge",
      edgeType: "INJECTS",
      from: constructorId,
      to: this.resolveSymbolId(symbol),
    });
  }

  private emitImportEdges(sourceFile: ts.SourceFile, relPath: string): void {
    for (const stmt of sourceFile.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const resolved = ts.resolveModuleName(
        stmt.moduleSpecifier.text,
        sourceFile.fileName,
        this.compilerOptions,
        ts.sys,
      );
      const resolvedFileName = resolved.resolvedModule?.resolvedFileName;
      if (!resolvedFileName) continue;
      const absResolved = path.resolve(resolvedFileName);
      if (!this.ownedFiles.has(absResolved)) continue; // node_modules/external import — no File node for those
      this.sink.write({
        record: "edge",
        edgeType: "IMPORTS",
        from: relPath,
        to: toRepoRelativePath(this.repoRoot, absResolved),
      });
    }
  }

  private emitCallEdges(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const rawSymbol = this.checker.getSymbolAtLocation(node.expression);
        const targetSymbol = rawSymbol ? this.resolveAliasedSymbol(rawSymbol) : undefined;
        if (targetSymbol) {
          const type = this.checker.getTypeOfSymbolAtLocation(targetSymbol, node.expression);
          const isCallable = type.getCallSignatures().length > 0;
          const containerId = isCallable ? this.findEnclosingCallableId(node) : undefined;
          if (isCallable && containerId) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            this.sink.write({
              record: "edge",
              edgeType: "CALLS",
              from: containerId,
              to: this.resolveSymbolId(targetSymbol),
              line: line + 1,
              col: character + 1,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private findEnclosingCallableId(node: ts.Node): string | undefined {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (
        (ts.isMethodDeclaration(current) && current.body) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current) ||
        (ts.isFunctionDeclaration(current) && current.body)
      ) {
        return buildOwnedId(this.repoRoot, current);
      }
      if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent && ts.isPropertyDeclaration(current.parent)) {
        return buildOwnedId(this.repoRoot, current.parent);
      }
      current = current.parent;
    }
    return undefined;
  }

  private resolveAliasedSymbol(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (!symbol) return undefined;
    return symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  /** Returns the stable id for a symbol, registering it as an external stub first (grouped by
   * declaring package) if it isn't backed by one of our own owned source files. */
  private resolveSymbolId(symbol: ts.Symbol): string {
    const decl = symbol.declarations?.[0];
    if (decl) {
      const absPath = path.resolve(decl.getSourceFile().fileName);
      if (this.ownedFiles.has(absPath)) return buildOwnedId(this.repoRoot, decl);

      const pkg = resolvePackageName(decl.getSourceFile().fileName) ?? "unknown";
      const qualifiedName = buildQualifiedName(decl) || symbol.getName();
      return this.externalSymbols.getOrRegister({
        id: `typescript:external:${pkg}#${qualifiedName}`,
        name: symbol.getName(),
        kind: getDeclarationKind(decl),
        signature: this.checker.typeToString(this.checker.getTypeOfSymbolAtLocation(symbol, decl)),
        groupKey: pkg,
      });
    }

    return this.externalSymbols.getOrRegister({
      id: `typescript:external:unknown#${symbol.getName()}`,
      name: symbol.getName(),
      kind: "Variable",
      signature: symbol.getName(),
      groupKey: "unknown",
    });
  }

  private getSpan(node: ts.Node, sourceFile: ts.SourceFile) {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    return {
      startLine: start.line + 1,
      startCol: start.character + 1,
      endLine: end.line + 1,
      endCol: end.character + 1,
    };
  }
}
