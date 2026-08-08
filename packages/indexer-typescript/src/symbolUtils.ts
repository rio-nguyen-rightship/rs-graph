import * as ts from "typescript";
import type { SymbolKind } from "@rs-graph/core-schema";

/**
 * TypeScript normalizes `SourceFile.fileName` to forward slashes internally, even on Windows,
 * while `repoRoot` typically comes from Node's native `path` module (backslashes on win32) —
 * both sides must be normalized to the same separator before comparing, or the prefix check
 * silently fails and this falls through to returning the absolute path unchanged.
 */
export function toRepoRelativePath(root: string, absolutePath: string): string {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedPath = absolutePath.replaceAll("\\", "/");
  return normalizedPath.startsWith(normalizedRoot)
    ? normalizedPath.slice(normalizedRoot.length).replace(/^\//, "")
    : normalizedPath;
}

export function getSpanLines(node: ts.Node, sourceFile: ts.SourceFile): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { startLine: start.line + 1, endLine: end.line + 1 };
}

/** Stable id for a declaration known to live in one of our own (owned) source files —
 * `"typescript:" + relPath + "#" + qualifiedName`. Used identically by the main graph walk
 * and the Angular enrichment pass so ids line up between the two (e.g. BINDS_TEMPLATE edges
 * pointing at a Symbol row the main pass already emitted). */
export function buildOwnedId(repoRoot: string, node: ts.Node): string {
  const relPath = toRepoRelativePath(repoRoot, node.getSourceFile().fileName);
  return `typescript:${relPath}#${buildQualifiedName(node)}`;
}

/** Finds the nearest ancestor named-declaration chain (Class.method, Namespace.Class, ...),
 * giving a stable qualified name independent of import aliases used at call sites — mirrors
 * indexer-dotnet's use of the declaration site (OriginalDefinition) rather than reference site. */
export function buildQualifiedName(node: ts.Node): string {
  const parts: string[] = [];
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isConstructorDeclaration(current)) {
      parts.unshift("constructor");
    } else {
      const name = (current as ts.NamedDeclaration).name;
      if (name && ts.isIdentifier(name)) parts.unshift(name.text);
    }
    current = current.parent;
  }
  return parts.join(".");
}

/** Finds the `node_modules/<package>` segment of a path (handling scoped `@scope/name`
 * packages), used to group external stub symbols by the package that declares them. */
export function resolvePackageName(fileName: string): string | undefined {
  const normalized = fileName.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return undefined;
  const rest = normalized.slice(idx + marker.length).split("/");
  if (rest[0]?.startsWith("@") && rest.length > 1) return `${rest[0]}/${rest[1]}`;
  return rest[0];
}

export function getDeclarationKind(node: ts.Node): SymbolKind {
  if (ts.isClassDeclaration(node)) return "Class";
  if (ts.isInterfaceDeclaration(node)) return "Interface";
  if (ts.isEnumDeclaration(node)) return "Enum";
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return "Method";
  }
  if (ts.isFunctionDeclaration(node)) return "Function";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "Property";
  return "Variable";
}

function getDecoratorNames(node: ts.Node): string[] {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (!decorators) return [];
  return decorators
    .map((d) => (ts.isCallExpression(d.expression) ? d.expression.expression : d.expression))
    .filter(ts.isIdentifier)
    .map((id) => id.text.toLowerCase());
}

export function getModifiers(node: ts.Node): string[] {
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  const modifiers: string[] = [];
  if (flags & ts.ModifierFlags.Private) modifiers.push("private");
  else if (flags & ts.ModifierFlags.Protected) modifiers.push("protected");
  else modifiers.push("public");
  if (flags & ts.ModifierFlags.Static) modifiers.push("static");
  if (flags & ts.ModifierFlags.Abstract) modifiers.push("abstract");
  if (flags & ts.ModifierFlags.Readonly) modifiers.push("readonly");
  if (flags & ts.ModifierFlags.Export) modifiers.push("export");
  // Decorator names surfaced generically as modifiers (e.g. `bindable` for Aurelia's
  // @bindable properties) rather than special-cased per framework — any decorator is useful
  // signal in a signature, not just the ones this indexer specifically knows how to enrich.
  modifiers.push(...getDecoratorNames(node));
  return modifiers;
}

function getNameNode(node: ts.Node): ts.Node {
  return ts.isConstructorDeclaration(node) ? node : ((node as ts.NamedDeclaration).name ?? node);
}

export function getDocSummary(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  const symbol = checker.getSymbolAtLocation(getNameNode(node));
  if (!symbol) return undefined;
  const doc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (!doc) return undefined;
  return doc.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
}

function renderParams(params: ts.NodeArray<ts.ParameterDeclaration>): string {
  return params
    .map((p) => `${p.name.getText()}: ${p.type ? p.type.getText() : "any"}`)
    .join(", ");
}

function renderReturnType(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration,
  checker: ts.TypeChecker,
): string {
  if (node.type) return node.type.getText();
  const signature = checker.getSignatureFromDeclaration(node);
  return signature ? checker.typeToString(checker.getReturnTypeOfSignature(signature)) : "any";
}

export function renderSignature(node: ts.Node, checker: ts.TypeChecker): string {
  const modifiers = getModifiers(node).filter((m) => m !== "export").join(" ");
  const prefix = modifiers ? `${modifiers} ` : "";

  if (ts.isClassDeclaration(node)) return `${prefix}class ${node.name?.text ?? "<anonymous>"}`;
  if (ts.isInterfaceDeclaration(node)) return `${prefix}interface ${node.name.text}`;
  if (ts.isEnumDeclaration(node)) return `${prefix}enum ${node.name.text}`;
  if (ts.isConstructorDeclaration(node)) return `${prefix}constructor(${renderParams(node.parameters)})`;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return `${prefix}${node.name.text}(${renderParams(node.parameters)}): ${renderReturnType(node, checker)}`;
  }
  if (ts.isFunctionDeclaration(node)) {
    return `${prefix}function ${node.name?.text ?? "<anonymous>"}(${renderParams(node.parameters)}): ${renderReturnType(node, checker)}`;
  }
  if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name)) {
    return `${prefix}get ${node.name.text}(): ${renderReturnType(node, checker)}`;
  }
  if (ts.isSetAccessorDeclaration(node) && ts.isIdentifier(node.name)) {
    return `${prefix}set ${node.name.text}(${renderParams(node.parameters)})`;
  }
  if ((ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) && ts.isIdentifier(node.name)) {
    const type = node.type ? node.type.getText() : checker.typeToString(checker.getTypeAtLocation(node));
    return `${prefix}${node.name.text}: ${type}`;
  }
  return node.getText().split("\n")[0] ?? node.getText();
}
