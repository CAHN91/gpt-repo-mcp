import type { SymbolCall, SymbolContextInput, SymbolContextResult, SymbolDefinition } from "../contracts/symbol-context.contract.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { SymbolIndexService } from "./symbol-index-service.js";

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_SYMBOLS = 200;
const DEFAULT_MAX_RELATIONS = 500;

export class SymbolContextService {
  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {}

  async analyze(input: SymbolContextInput): Promise<SymbolContextResult> {
    const paths = [...new Set((input.paths ?? []).map(validateRepoPath))].sort();
    const names = [...new Set(input.symbols ?? [])].sort();
    const maxFiles = input.max_files ?? DEFAULT_MAX_FILES;
    const maxSymbols = input.max_symbols ?? DEFAULT_MAX_SYMBOLS;
    const maxRelations = input.max_relations ?? DEFAULT_MAX_RELATIONS;
    const direction = input.direction ?? "both";
    const depth = input.depth ?? 1;
    const loaded = await new SymbolIndexService(this.root, this.sandbox).load(maxFiles);
    const index = loaded.index;
    const seedIds = new Set(index.definitions
      .filter((definition) => names.includes(definition.name) || paths.includes(definition.path))
      .map((definition) => definition.id));
    const selectedIds = expandCalls(seedIds, index.calls, direction, depth);
    for (const implementation of index.implementations) {
      if (selectedIds.has(implementation.interface_symbol_id) || selectedIds.has(implementation.implementation_symbol_id)) {
        selectedIds.add(implementation.interface_symbol_id);
        selectedIds.add(implementation.implementation_symbol_id);
      }
    }
    const warnings = [...index.warnings];
    if (seedIds.size === 0) warnings.push("SYMBOL_QUERY_NO_MATCHES");

    const selectedDefinitions = index.definitions.filter((definition) => selectedIds.has(definition.id));
    const definitions = selectedDefinitions.slice(0, maxSymbols);
    const returnedIds = new Set(definitions.map((definition) => definition.id));
    const relevantReferences = index.references.filter((reference) => returnedIds.has(reference.symbol_id));
    const relevantCalls = index.calls.filter((call) => returnedIds.has(call.from_symbol_id) || returnedIds.has(call.to_symbol_id));
    const relevantImplementations = index.implementations.filter((implementation) =>
      returnedIds.has(implementation.interface_symbol_id) || returnedIds.has(implementation.implementation_symbol_id)
    );
    const relationCount = relevantReferences.length + relevantCalls.length + relevantImplementations.length;
    const references = relevantReferences.slice(0, maxRelations);
    const remainingAfterReferences = Math.max(0, maxRelations - references.length);
    const calls = relevantCalls.slice(0, remainingAfterReferences);
    const remainingAfterCalls = Math.max(0, remainingAfterReferences - calls.length);
    const implementations = relevantImplementations.slice(0, remainingAfterCalls);
    const selectedPaths = new Set([...paths, ...definitions.map((definition) => definition.path)]);
    const imports = index.imports.filter((entry) => selectedPaths.has(entry.path)).slice(0, maxRelations);
    const reverseDependents = definitions.map((definition) => ({
      symbol_id: definition.id,
      paths: [...new Set(index.references.filter((reference) => reference.symbol_id === definition.id && reference.path !== definition.path).map((reference) => reference.path))].sort()
    })).filter((entry) => entry.paths.length > 0);
    const affectedTests = affectedTestsFor(definitions, index.references);
    const truncated = index.truncated || selectedDefinitions.length > definitions.length || relationCount > maxRelations || imports.length < index.imports.filter((entry) => selectedPaths.has(entry.path)).length;
    if (selectedDefinitions.length > definitions.length) warnings.push("SYMBOL_RESULT_LIMIT_REACHED");
    if (relationCount > maxRelations) warnings.push("SYMBOL_RELATION_LIMIT_REACHED");

    return {
      ok: true,
      repo_id: input.repo_id,
      definitions,
      references,
      calls,
      implementations,
      imports,
      exports: index.exports.filter((id) => returnedIds.has(id)),
      reverse_dependents: reverseDependents,
      affected_tests: affectedTests,
      cache: { key: index.cache_key, path: loaded.cache_path, hit: loaded.cache_hit },
      scanned_file_count: index.scanned_file_count,
      confidence: confidenceFor(seedIds.size, index.ambiguous_reference_count, truncated),
      truncated,
      warnings: [...new Set(warnings)].sort()
    };
  }
}

function expandCalls(
  seedIds: Set<string>,
  calls: SymbolCall[],
  direction: "inbound" | "outbound" | "both",
  depth: number
): Set<string> {
  const selected = new Set(seedIds);
  let frontier = new Set(seedIds);
  for (let level = 0; level < depth && frontier.size > 0; level += 1) {
    const next = new Set<string>();
    for (const call of calls) {
      if ((direction === "outbound" || direction === "both") && frontier.has(call.from_symbol_id) && !selected.has(call.to_symbol_id)) next.add(call.to_symbol_id);
      if ((direction === "inbound" || direction === "both") && frontier.has(call.to_symbol_id) && !selected.has(call.from_symbol_id)) next.add(call.from_symbol_id);
    }
    for (const id of next) selected.add(id);
    frontier = next;
  }
  return selected;
}

function affectedTestsFor(definitions: SymbolDefinition[], references: Array<{ symbol_id: string; path: string }>): string[] {
  const ids = new Set(definitions.map((definition) => definition.id));
  const paths = references.filter((reference) => ids.has(reference.symbol_id) && isTestPath(reference.path)).map((reference) => reference.path);
  for (const definition of definitions) if (isTestPath(definition.path)) paths.push(definition.path);
  return [...new Set(paths)].sort();
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function confidenceFor(seedCount: number, ambiguousCount: number, truncated: boolean): "high" | "medium" | "low" {
  if (seedCount === 0) return "low";
  if (ambiguousCount > 0 || truncated) return "medium";
  return "high";
}
