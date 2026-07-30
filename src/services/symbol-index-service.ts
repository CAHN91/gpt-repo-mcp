import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  SymbolCallSchema,
  SymbolDefinitionSchema,
  SymbolImplementationSchema,
  SymbolImportSchema,
  SymbolLocationSchema,
  type SymbolCall,
  type SymbolDefinition,
  type SymbolImplementation,
  type SymbolImport,
  type SymbolLocation
} from "../contracts/symbol-context.contract.js";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { atomicWriteJson } from "../runtime/fs-helpers.js";
import { readFilePrefix } from "./bounded-read.js";
import { GitService } from "./git-service.js";
import { PathSandbox } from "./path-sandbox.js";
import { RepoTreeService } from "./repo-tree-service.js";
import { extractSymbolSyntax, parseSymbolSource, type ParsedSymbolFile } from "./symbol-syntax-extractor.js";

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 5 * 1024 * 1024;
const MAX_CACHE_FILES = 5;
const CACHE_ROOT = ".chatgpt/index/symbols";
const MAX_INDEX_DEFINITIONS = 10_000;
const MAX_INDEX_RELATIONS = 25_000;
const MAX_INDEX_IMPORTS = 10_000;
const SafeRepoPathSchema = z.string().max(500).refine(isSafeRepoPath, { message: "Expected a safe repo-relative path." });
const SafeIdSchema = z.string().min(1).max(800).refine((value) => !value.includes("\n") && !value.includes("\r"));
const SymbolIndexCacheSchema = z.object({
  schema_version: z.literal(1),
  cache_key: z.string().min(1).max(200),
  max_files: z.number().int().positive().max(500),
  definitions: z.array(SymbolDefinitionSchema.extend({ id: SafeIdSchema, path: SafeRepoPathSchema })).max(MAX_INDEX_DEFINITIONS),
  references: z.array(SymbolLocationSchema.extend({ symbol_id: SafeIdSchema, path: SafeRepoPathSchema, from_symbol_id: SafeIdSchema.optional() })).max(MAX_INDEX_RELATIONS),
  calls: z.array(SymbolCallSchema.extend({ from_symbol_id: SafeIdSchema, to_symbol_id: SafeIdSchema, path: SafeRepoPathSchema })).max(MAX_INDEX_RELATIONS),
  implementations: z.array(SymbolImplementationSchema.extend({ interface_symbol_id: SafeIdSchema, implementation_symbol_id: SafeIdSchema, path: SafeRepoPathSchema })).max(MAX_INDEX_DEFINITIONS),
  imports: z.array(SymbolImportSchema.extend({ path: SafeRepoPathSchema })).max(MAX_INDEX_IMPORTS),
  exports: z.array(SafeIdSchema).max(MAX_INDEX_DEFINITIONS),
  scanned_file_count: z.number().int().nonnegative().max(500),
  ambiguous_reference_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warnings: z.array(z.string().max(300)).max(1_000)
});

export type SymbolIndex = {
  schema_version: 1;
  cache_key: string;
  max_files: number;
  definitions: SymbolDefinition[];
  references: SymbolLocation[];
  calls: SymbolCall[];
  implementations: SymbolImplementation[];
  imports: SymbolImport[];
  exports: string[];
  scanned_file_count: number;
  ambiguous_reference_count: number;
  truncated: boolean;
  warnings: string[];
};

export type SymbolIndexResult = { index: SymbolIndex; cache_path: string; cache_hit: boolean };

export type SymbolIndexServiceOptions = {
  maxCacheBytes?: number;
  maxCacheFiles?: number;
};

export class SymbolIndexService {
  private readonly maxCacheBytes: number;
  private readonly maxCacheFiles: number;

  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    options: SymbolIndexServiceOptions = {}
  ) {
    this.maxCacheBytes = Math.max(4_096, options.maxCacheBytes ?? MAX_CACHE_BYTES);
    this.maxCacheFiles = Math.max(1, options.maxCacheFiles ?? MAX_CACHE_FILES);
  }

  async load(maxFiles: number): Promise<SymbolIndexResult> {
    const { key, warnings: keyWarnings } = await this.cacheKey();
    const cachePath = `${CACHE_ROOT}/${key}.json`;
    const cached = await this.readCache(cachePath, key, maxFiles);
    if (cached.index) {
      const pruneWarning = await this.pruneCache(cachePath);
      return {
        index: withWarnings(cached.index, pruneWarning ? [pruneWarning] : []),
        cache_path: cachePath,
        cache_hit: true
      };
    }

    const built = await this.build(key, maxFiles, [...keyWarnings, ...(cached.missWarning ? [cached.missWarning] : [])]);
    const index = fitIndexToCacheLimit(built, this.maxCacheBytes);
    await atomicWriteJson(join(this.root, cachePath), index);
    const pruneWarning = await this.pruneCache(cachePath);
    return {
      index: withWarnings(index, pruneWarning ? [pruneWarning] : []),
      cache_path: cachePath,
      cache_hit: false
    };
  }

  private async build(cacheKey: string, maxFiles: number, initialWarnings: string[]): Promise<SymbolIndex> {
    const warnings = [...initialWarnings];
    const tree = await new RepoTreeService(this.sandbox).tree({
      include_files: true,
      include_generated: false,
      include_dependencies: false,
      respect_default_excludes: true,
      page_size: DEFAULT_LIMITS.max_tree_entries,
      exclude_prefixes: [".chatgpt"]
    });
    const candidates = tree.entries
      .filter((entry) => entry.type === "file" && SOURCE_EXTENSION.test(entry.path))
      .map((entry) => entry.path)
      .sort();
    const paths = candidates.slice(0, maxFiles);
    let truncated = tree.truncated || candidates.length > paths.length;
    if (tree.truncated) warnings.push("SYMBOL_TREE_TRUNCATED");
    if (candidates.length > paths.length) warnings.push("SYMBOL_FILE_LIMIT_REACHED");

    const parsed: ParsedSymbolFile[] = [];
    for (const path of paths) {
      const resolved = await this.sandbox.resolve(path);
      const bounded = await readFilePrefix(resolved.absolutePath, MAX_SOURCE_BYTES);
      if (bounded.truncated) {
        warnings.push(`SYMBOL_SOURCE_TRUNCATED:${path}`);
        truncated = true;
        continue;
      }
      parsed.push(parseSymbolSource(path, bounded.buffer.toString("utf8")));
    }
    const extracted = extractSymbolSyntax(parsed);
    if (extracted.ambiguous_reference_count > 0) warnings.push("SYMBOL_AMBIGUOUS_REFERENCES_SKIPPED");
    const definitions = dedupeBy(extracted.definitions, (item) => item.id);
    const definitionIds = new Set(definitions.slice(0, MAX_INDEX_DEFINITIONS).map((definition) => definition.id));
    const references = dedupeBy(extracted.references, (item) => `${item.symbol_id}:${item.path}:${item.line}:${item.from_symbol_id ?? ""}`)
      .filter((item) => definitionIds.has(item.symbol_id) && (!item.from_symbol_id || definitionIds.has(item.from_symbol_id)));
    const calls = dedupeBy(extracted.calls, (item) => `${item.from_symbol_id}:${item.to_symbol_id}:${item.path}:${item.line}`)
      .filter((item) => definitionIds.has(item.from_symbol_id) && definitionIds.has(item.to_symbol_id));
    const implementations = dedupeBy(extracted.implementations, (item) => `${item.interface_symbol_id}:${item.implementation_symbol_id}`)
      .filter((item) => definitionIds.has(item.interface_symbol_id) && definitionIds.has(item.implementation_symbol_id));
    const imports = dedupeBy(extracted.imports, (item) => `${item.path}:${item.module}:${item.names.join(",")}`);
    if (definitions.length > MAX_INDEX_DEFINITIONS || references.length > MAX_INDEX_RELATIONS || calls.length > MAX_INDEX_RELATIONS || implementations.length > MAX_INDEX_DEFINITIONS || imports.length > MAX_INDEX_IMPORTS) {
      truncated = true;
      warnings.push("SYMBOL_INDEX_LIMIT_REACHED");
    }
    return {
      schema_version: 1,
      cache_key: cacheKey,
      max_files: maxFiles,
      definitions: definitions.slice(0, MAX_INDEX_DEFINITIONS),
      references: references.slice(0, MAX_INDEX_RELATIONS),
      calls: calls.slice(0, MAX_INDEX_RELATIONS),
      implementations: implementations.slice(0, MAX_INDEX_DEFINITIONS),
      imports: imports.slice(0, MAX_INDEX_IMPORTS),
      exports: definitions.filter((definition) => definition.exported && definitionIds.has(definition.id)).map((definition) => definition.id).sort(),
      scanned_file_count: parsed.length,
      ambiguous_reference_count: extracted.ambiguous_reference_count,
      truncated,
      warnings: [...new Set(warnings)].sort()
    };
  }

  private async cacheKey(): Promise<{ key: string; warnings: string[] }> {
    try {
      const git = new GitService(this.root);
      const [status, fingerprint] = await Promise.all([git.status(), git.worktreeFingerprint()]);
      return { key: `${status.head_sha}-${fingerprint}`, warnings: [] };
    } catch {
      return { key: "unversioned", warnings: ["SYMBOL_CACHE_UNVERSIONED"] };
    }
  }

  private async readCache(
    cachePath: string,
    key: string,
    maxFiles: number
  ): Promise<{ index?: SymbolIndex; missWarning?: string }> {
    try {
      if ((await stat(join(this.root, cachePath))).size > this.maxCacheBytes) {
        return { missWarning: "SYMBOL_CACHE_TOO_LARGE_REBUILT" };
      }
      const parsed = SymbolIndexCacheSchema.safeParse(JSON.parse(await readFile(join(this.root, cachePath), "utf8")) as unknown);
      if (!parsed.success || parsed.data.cache_key !== key) {
        return { missWarning: "SYMBOL_CACHE_INVALID_REBUILT" };
      }
      if (parsed.data.max_files !== maxFiles) {
        return { missWarning: "SYMBOL_CACHE_PARAMETERS_CHANGED" };
      }
      const ids = new Set(parsed.data.definitions.map((definition) => definition.id));
      if (parsed.data.references.some((reference) => !ids.has(reference.symbol_id) || Boolean(reference.from_symbol_id && !ids.has(reference.from_symbol_id)))) {
        return { missWarning: "SYMBOL_CACHE_INVALID_REBUILT" };
      }
      if (parsed.data.calls.some((call) => !ids.has(call.from_symbol_id) || !ids.has(call.to_symbol_id))) {
        return { missWarning: "SYMBOL_CACHE_INVALID_REBUILT" };
      }
      if (parsed.data.implementations.some((item) => !ids.has(item.interface_symbol_id) || !ids.has(item.implementation_symbol_id))) {
        return { missWarning: "SYMBOL_CACHE_INVALID_REBUILT" };
      }
      if (parsed.data.exports.some((id) => !ids.has(id))) {
        return { missWarning: "SYMBOL_CACHE_INVALID_REBUILT" };
      }
      return { index: parsed.data };
    } catch (error) {
      return isNotFoundError(error) ? {} : { missWarning: "SYMBOL_CACHE_READ_FAILED_REBUILT" };
    }
  }

  private async pruneCache(currentCachePath: string): Promise<string | undefined> {
    try {
      const cacheDirectory = join(this.root, dirname(currentCachePath));
      const currentName = basename(currentCachePath);
      const entries = await readdir(cacheDirectory, { withFileTypes: true });
      const candidates = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== currentName)
        .map(async (entry) => ({
          name: entry.name,
          modified: (await stat(join(cacheDirectory, entry.name))).mtimeMs
        })));
      candidates.sort((left, right) => right.modified - left.modified || left.name.localeCompare(right.name));
      const stale = candidates.slice(Math.max(0, this.maxCacheFiles - 1));
      await Promise.all(stale.map((entry) => unlink(join(cacheDirectory, entry.name))));
      return undefined;
    } catch {
      return "SYMBOL_CACHE_PRUNE_FAILED";
    }
  }
}

function fitIndexToCacheLimit(index: SymbolIndex, maxBytes: number): SymbolIndex {
  let fitted = withWarnings(index, []);
  if (serializedIndexBytes(fitted) <= maxBytes) {
    return fitted;
  }
  fitted = withWarnings({ ...fitted, truncated: true }, ["SYMBOL_CACHE_SIZE_LIMIT_REACHED"]);

  while (serializedIndexBytes(fitted) > maxBytes) {
    const reducedRelations = reduceRelations(fitted);
    if (reducedRelations !== fitted) {
      fitted = reducedRelations;
      continue;
    }
    if (fitted.definitions.length > 0) {
      const definitions = halve(fitted.definitions);
      const ids = new Set(definitions.map((definition) => definition.id));
      fitted = {
        ...fitted,
        definitions,
        references: fitted.references.filter((reference) =>
          ids.has(reference.symbol_id) && (!reference.from_symbol_id || ids.has(reference.from_symbol_id))
        ),
        calls: fitted.calls.filter((call) => ids.has(call.from_symbol_id) && ids.has(call.to_symbol_id)),
        implementations: fitted.implementations.filter((item) =>
          ids.has(item.interface_symbol_id) && ids.has(item.implementation_symbol_id)
        ),
        exports: fitted.exports.filter((id) => ids.has(id))
      };
      continue;
    }
    throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `Symbol index metadata exceeds cache byte limit: ${maxBytes}`);
  }
  return fitted;
}

function reduceRelations(index: SymbolIndex): SymbolIndex {
  if (index.references.length > 0) return { ...index, references: halve(index.references) };
  if (index.calls.length > 0) return { ...index, calls: halve(index.calls) };
  if (index.implementations.length > 0) return { ...index, implementations: halve(index.implementations) };
  if (index.imports.length > 0) return { ...index, imports: halve(index.imports) };
  if (index.exports.length > 0) return { ...index, exports: halve(index.exports) };
  return index;
}

function halve<T>(items: T[]): T[] {
  return items.slice(0, Math.floor(items.length / 2));
}

function serializedIndexBytes(index: SymbolIndex): number {
  return Buffer.byteLength(`${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function withWarnings(index: SymbolIndex, warnings: string[]): SymbolIndex {
  if (warnings.length === 0) {
    return index;
  }
  return { ...index, warnings: [...new Set([...index.warnings, ...warnings])].sort() };
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function isSafeRepoPath(value: string): boolean {
  return value.length > 0
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.includes("\\")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
