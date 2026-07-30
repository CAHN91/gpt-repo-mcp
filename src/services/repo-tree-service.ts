import { readdir } from "node:fs/promises";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";

export type TreeOptions = {
  path?: string;
  max_depth?: number;
  page_size?: number;
  include_files?: boolean;
  respect_default_excludes?: boolean;
  include_generated?: boolean;
  include_dependencies?: boolean;
  cursor?: string;
  exclude_prefixes?: string[];
};

type TreeEntry = {
  path: string;
  type: "file" | "directory" | "nested_repo" | "submodule";
  size_bytes?: number;
};

type ParsedCursor =
  | { kind: "path"; afterPath: string }
  | { kind: "legacy"; remaining: number };

export class RepoTreeService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(private readonly sandbox: PathSandbox) {}

  async tree(options: TreeOptions) {
    const start = validateRepoPath(options.path ?? ".");
    const maxDepth = Math.min(options.max_depth ?? DEFAULT_LIMITS.max_depth, DEFAULT_LIMITS.max_depth);
    const pageSize = Math.max(1, Math.min(options.page_size ?? DEFAULT_LIMITS.max_tree_entries, DEFAULT_LIMITS.max_tree_entries));
    const cursor = parseCursor(options.cursor);
    const includeFiles = options.include_files ?? true;
    const respectDefaultExcludes = options.respect_default_excludes ?? true;
    const excludePrefixes = (options.exclude_prefixes ?? [])
      .map(validateRepoPath)
      .map((prefix) => prefix === "." ? prefix : prefix.replace(/\/+$/, ""));
    const entries: TreeEntry[] = [];
    const excludedSummary: Record<string, number> = {};
    if (isExcludedPrefix(start, excludePrefixes)) {
      return {
        entries,
        excluded_summary: { consumer_excludes: 1 },
        truncated: false,
        next_cursor: undefined
      };
    }
    let legacyRemaining = cursor.kind === "legacy" ? cursor.remaining : 0;
    let pageFull = false;

    const addEntry = (entry: TreeEntry): void => {
      if (cursor.kind === "path" && compareTreePaths(entry.path, cursor.afterPath) <= 0) {
        return;
      }
      if (legacyRemaining > 0) {
        legacyRemaining -= 1;
        return;
      }
      entries.push(entry);
      pageFull = entries.length > pageSize;
    };

    const walk = async (repoPath: string, depth: number): Promise<void> => {
      if (pageFull || depth > maxDepth) {
        return;
      }

      const resolved = await this.resolveForTree(repoPath, excludedSummary);
      if (!resolved) {
        return;
      }
      const boundary = await this.sandbox.classifyBoundary(repoPath);
      if (boundary.kind !== "normal" && repoPath !== ".") {
        addEntry({ path: boundary.path, type: boundary.kind });
        return;
      }
      if (resolved.stat.isDirectory()) {
        if (repoPath !== ".") {
          addEntry({ path: repoPath, type: "directory" });
          if (pageFull) {
            return;
          }
        }
        const children = await readdir(resolved.absolutePath, { withFileTypes: true });
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          const childRepoPath = repoPath === "." ? child.name : `${repoPath}/${child.name}`;
          if (isExcludedPrefix(childRepoPath, excludePrefixes)) {
            excludedSummary.consumer_excludes = (excludedSummary.consumer_excludes ?? 0) + 1;
            continue;
          }
          if (cursor.kind === "path" && subtreePrecedesCursor(childRepoPath, cursor.afterPath)) {
            excludedSummary.cursor_skipped_subtrees = (excludedSummary.cursor_skipped_subtrees ?? 0) + 1;
            continue;
          }
          if (this.ignoreEngine.isSensitiveCandidate(childRepoPath)) {
            excludedSummary.secret_candidates = (excludedSummary.secret_candidates ?? 0) + 1;
            continue;
          }
          const isDependency = isDependencyPath(childRepoPath);
          const isGenerated = isGeneratedPath(childRepoPath);
          if (isDependency && !options.include_dependencies) {
            excludedSummary.dependencies = (excludedSummary.dependencies ?? 0) + 1;
            excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
            continue;
          }
          if (isGenerated && !options.include_generated) {
            excludedSummary.generated = (excludedSummary.generated ?? 0) + 1;
            excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
            continue;
          }
          const includedByFlag = (isDependency && options.include_dependencies) || (isGenerated && options.include_generated);
          if (respectDefaultExcludes && !includedByFlag && this.ignoreEngine.isIgnored(childRepoPath)) {
            excludedSummary.default_excludes = (excludedSummary.default_excludes ?? 0) + 1;
            continue;
          }
          await walk(childRepoPath, depth + 1);
          if (pageFull) {
            break;
          }
        }
        return;
      }
      if (includeFiles && resolved.stat.isFile()) {
        addEntry({ path: repoPath, type: "file", size_bytes: Number(resolved.stat.size) });
      }
    };

    await walk(start, 0);
    const pagedEntries = entries.slice(0, pageSize);
    const truncated = entries.length > pageSize;
    const lastPath = pagedEntries.at(-1)?.path;
    return {
      entries: pagedEntries,
      excluded_summary: excludedSummary,
      truncated,
      next_cursor: truncated && lastPath ? encodeCursor(lastPath) : undefined
    };
  }

  private async resolveForTree(
    repoPath: string,
    excludedSummary: Record<string, number>
  ): Promise<Awaited<ReturnType<PathSandbox["resolve"]>> | undefined> {
    try {
      return await this.sandbox.resolve(repoPath);
    } catch (error) {
      if (error instanceof RepoReaderError) {
        excludedSummary[error.code] = (excludedSummary[error.code] ?? 0) + 1;
        return undefined;
      }
      throw error;
    }
  }
}

function parseCursor(cursor?: string): ParsedCursor {
  if (!cursor) {
    return { kind: "legacy", remaining: 0 };
  }
  if (cursor.startsWith("v2:")) {
    try {
      const decoded = Buffer.from(cursor.slice(3), "base64url").toString("utf8");
      return { kind: "path", afterPath: validateRepoPath(decoded) };
    } catch {
      return { kind: "legacy", remaining: 0 };
    }
  }
  const parsed = Number.parseInt(cursor, 10);
  return { kind: "legacy", remaining: Number.isFinite(parsed) && parsed > 0 ? parsed : 0 };
}

function encodeCursor(path: string): string {
  return `v2:${Buffer.from(path, "utf8").toString("base64url")}`;
}

function compareTreePaths(left: string, right: string): number {
  const leftParts = left === "." ? [] : left.split("/");
  const rightParts = right === "." ? [] : right.split("/");
  const sharedLength = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const compared = leftParts[index].localeCompare(rightParts[index]);
    if (compared !== 0) {
      return compared;
    }
  }
  return leftParts.length - rightParts.length;
}

function subtreePrecedesCursor(repoPath: string, cursorPath: string): boolean {
  const pathParts = repoPath.split("/");
  const cursorParts = cursorPath.split("/");
  const sharedLength = Math.min(pathParts.length, cursorParts.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const compared = pathParts[index].localeCompare(cursorParts[index]);
    if (compared < 0) {
      return true;
    }
    if (compared > 0) {
      return false;
    }
  }
  return false;
}

function isExcludedPrefix(repoPath: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) =>
    prefix === "." || repoPath === prefix || repoPath.startsWith(`${prefix}/`)
  );
}

function isGeneratedPath(repoPath: string): boolean {
  return /(^|\/)(dist|build|out|coverage)(\/|$)/.test(repoPath);
}

function isDependencyPath(repoPath: string): boolean {
  return /(^|\/)node_modules(\/|$)/.test(repoPath);
}
