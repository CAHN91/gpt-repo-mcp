import ts from "typescript";
import type { SymbolCall, SymbolDefinition, SymbolImplementation, SymbolImport, SymbolLocation } from "../contracts/symbol-context.contract.js";

export type ParsedSymbolFile = { path: string; source: ts.SourceFile };

export type ExtractedSymbolSyntax = {
  definitions: SymbolDefinition[];
  references: SymbolLocation[];
  calls: SymbolCall[];
  implementations: SymbolImplementation[];
  imports: SymbolImport[];
  ambiguous_reference_count: number;
};

export function parseSymbolSource(path: string, text: string): ParsedSymbolFile {
  return { path, source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path)) };
}

export function extractSymbolSyntax(files: ParsedSymbolFile[]): ExtractedSymbolSyntax {
  const definitions: SymbolDefinition[] = [];
  const imports: SymbolImport[] = [];
  const definitionNodes = new Map<ts.Node, string>();
  const declarationNames = new Set<ts.Node>();
  for (const file of files) collectDeclarations(file.path, file.source, definitions, imports, definitionNodes, declarationNames);

  const definitionsByName = new Map<string, SymbolDefinition[]>();
  for (const definition of definitions) {
    const bucket = definitionsByName.get(definition.name) ?? [];
    bucket.push(definition);
    definitionsByName.set(definition.name, bucket);
  }

  const references: SymbolLocation[] = [];
  const calls: SymbolCall[] = [];
  const implementations: SymbolImplementation[] = [];
  let ambiguousReferenceCount = 0;
  for (const file of files) {
    const visit = (node: ts.Node, currentSymbolId?: string): void => {
      const activeSymbolId = definitionNodes.get(node) ?? currentSymbolId;
      if (ts.isClassDeclaration(node) && node.name) {
        const implementation = definitionNodes.get(node);
        if (implementation) {
          for (const clause of node.heritageClauses ?? []) {
            if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
            for (const type of clause.types) {
              const target = resolveDefinition(type.expression.getText(file.source), file.path, definitionsByName, "interface");
              if (target) implementations.push({ interface_symbol_id: target.id, implementation_symbol_id: implementation, path: file.path, line: lineOf(file.source, type) });
            }
          }
        }
      }
      if (ts.isCallExpression(node) && activeSymbolId) {
        const name = callName(node.expression);
        if (name) {
          const target = resolveDefinition(name, file.path, definitionsByName);
          if (target) calls.push({ from_symbol_id: activeSymbolId, to_symbol_id: target.id, path: file.path, line: lineOf(file.source, node) });
          else if ((definitionsByName.get(name)?.length ?? 0) > 1) ambiguousReferenceCount += 1;
        }
      }
      if (ts.isIdentifier(node) && !declarationNames.has(node) && !isImportIdentifier(node)) {
        const target = resolveDefinition(node.text, file.path, definitionsByName);
        if (target) references.push({ symbol_id: target.id, path: file.path, line: lineOf(file.source, node), ...(activeSymbolId ? { from_symbol_id: activeSymbolId } : {}) });
        else if ((definitionsByName.get(node.text)?.length ?? 0) > 1) ambiguousReferenceCount += 1;
      }
      ts.forEachChild(node, (child) => visit(child, activeSymbolId));
    };
    visit(file.source);
  }

  return { definitions, references, calls, implementations, imports, ambiguous_reference_count: ambiguousReferenceCount };
}

function collectDeclarations(
  path: string,
  source: ts.SourceFile,
  definitions: SymbolDefinition[],
  imports: SymbolImport[],
  definitionNodes: Map<ts.Node, string>,
  declarationNames: Set<ts.Node>
): void {
  const visit = (node: ts.Node, container?: string): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ path, module: node.moduleSpecifier.text, names: importNames(node.importClause) });
    }
    const declaration = declarationInfo(node, source, container);
    let nextContainer = container;
    if (declaration) {
      const id = `${path}:${declaration.line}:${declaration.kind}:${declaration.name}`;
      definitions.push({ id, path, ...declaration });
      definitionNodes.set(node, id);
      nextContainer = declaration.name;
      const nameNode = declarationNameNode(node);
      if (nameNode) declarationNames.add(nameNode);
    }
    ts.forEachChild(node, (child) => visit(child, nextContainer));
  };
  visit(source);
}

function declarationInfo(node: ts.Node, source: ts.SourceFile, container?: string): Omit<SymbolDefinition, "id" | "path"> | undefined {
  let name: string | undefined;
  let kind: SymbolDefinition["kind"] | undefined;
  if (ts.isFunctionDeclaration(node) && node.name) { name = node.name.text; kind = "function"; }
  else if (ts.isClassDeclaration(node) && node.name) { name = node.name.text; kind = "class"; }
  else if (ts.isInterfaceDeclaration(node)) { name = node.name.text; kind = "interface"; }
  else if (ts.isTypeAliasDeclaration(node)) { name = node.name.text; kind = "type"; }
  else if (ts.isEnumDeclaration(node)) { name = node.name.text; kind = "enum"; }
  else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) { name = node.name.text; kind = "variable"; }
  else if (ts.isMethodDeclaration(node) && node.name) { name = propertyName(node.name); kind = "method"; }
  if (!name || !kind) return undefined;
  return { name, kind, line: lineOf(source, node), exported: isExported(node), ...(container ? { container } : {}) };
}

function isExported(node: ts.Node): boolean {
  const declaration = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  return ts.canHaveModifiers(declaration) && (ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function declarationNameNode(node: ts.Node): ts.Node | undefined {
  if ("name" in node && node.name && typeof node.name === "object") return node.name as ts.Node;
  return undefined;
}

function resolveDefinition(
  name: string,
  path: string,
  definitionsByName: Map<string, SymbolDefinition[]>,
  kind?: SymbolDefinition["kind"]
): SymbolDefinition | undefined {
  const candidates = (definitionsByName.get(name) ?? []).filter((candidate) => !kind || candidate.kind === kind);
  const local = candidates.filter((candidate) => candidate.path === path);
  if (local.length === 1) return local[0];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function importNames(clause: ts.ImportClause | undefined): string[] {
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push(clause.name.text);
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push(clause.namedBindings.name.text);
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) names.push(...clause.namedBindings.elements.map((element) => element.name.text));
  return names.sort();
}

function isImportIdentifier(node: ts.Identifier): boolean {
  return ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent);
}

function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/i.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}
