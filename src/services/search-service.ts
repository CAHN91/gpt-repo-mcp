import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { readFilePrefix } from "./bounded-read.js";
import { FileClassifier } from "./file-classifier.js";
import { isExcludedByGlob, matchesGlob } from "./glob-service.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";
import { RepoTreeService } from "./repo-tree-service.js";
import { SecretScanner } from "./secret-scanner.js";

export type SearchOptions = {
  query: string;
  mode?: "literal" | "regex";
  include_globs?: string[];
  exclude_globs?: string[];
  context_lines?: number;
  max_results?: number;
  cursor?: string;
};

export class SearchService {
  private readonly ignoreEngine = new IgnoreEngine();
  private readonly classifier = new FileClassifier(this.ignoreEngine);
  private readonly secretScanner = new SecretScanner();

  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {}

  async search(options: SearchOptions) {
    const maxResults = Math.min(options.max_results ?? DEFAULT_LIMITS.max_search_results, DEFAULT_LIMITS.max_search_results);
    const contextLines = Math.min(options.context_lines ?? 0, 5);
    const start = parseCursor(options.cursor);
    const tree = await new RepoTreeService(this.root, this.sandbox).tree({
      include_files: true,
      respect_default_excludes: true
    });
    const matcher = createMatcher(options);
    const matches: Array<{
      path: string;
      line: number;
      column: number;
      text: string;
      before: string[];
      after: string[];
    }> = [];
    const warnings: string[] = [];

    for (const entry of tree.entries) {
      if (entry.type !== "file") {
        continue;
      }
      if (!isIncluded(entry.path, options.include_globs) || isExcludedByGlob(entry.path, options.exclude_globs)) {
        continue;
      }
      if (this.ignoreEngine.isSensitiveCandidate(entry.path)) {
        continue;
      }
      const maxBytes = DEFAULT_LIMITS.max_bytes_per_file;
      if (typeof entry.size_bytes === "number" && entry.size_bytes > maxBytes) {
        warnings.push(`Skipped ${entry.path}: file exceeds max_bytes_per_file (${maxBytes}).`);
        continue;
      }
      const resolved = await this.sandbox.resolve(entry.path);
      const classification = await this.classifier.classify(entry.path, resolved.absolutePath);
      if (classification.is_binary) {
        continue;
      }
      const { buffer, truncated } = await readFilePrefix(resolved.absolutePath, maxBytes);
      if (truncated) {
        warnings.push(`Skipped ${entry.path}: file exceeds max_bytes_per_file (${maxBytes}).`);
        continue;
      }
      const text = this.secretScanner.redact(buffer.toString("utf8"));
      const lines = text.split(/\r?\n/);
      lines.forEach((lineText, index) => {
        const column = matcher.column(lineText);
        if (column === undefined) {
          return;
        }
        matches.push({
          path: entry.path,
          line: index + 1,
          column,
          text: lineText,
          before: lines.slice(Math.max(0, index - contextLines), index),
          after: lines.slice(index + 1, index + 1 + contextLines)
        });
      });
    }

    matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    const results = matches.slice(start, start + maxResults);
    const nextIndex = start + results.length;
    const truncated = nextIndex < matches.length;
    return {
      results,
      matched_count: matches.length,
      returned_count: results.length,
      truncated,
      next_cursor: truncated ? String(nextIndex) : undefined,
      warnings
    };
  }
}

function createMatcher(options: SearchOptions): { column: (line: string) => number | undefined } {
  if (options.query.length > DEFAULT_LIMITS.max_search_query_length) {
    throw new RepoReaderError(
      "VALIDATION_ERROR",
      `Search query exceeds max length (${DEFAULT_LIMITS.max_search_query_length}).`
    );
  }

  if (options.mode === "regex") {
    try {
      const regex = new RegExp(options.query, "i");
      return {
        column: (line: string) => {
          const index = line.search(regex);
          return index >= 0 ? index + 1 : undefined;
        }
      };
    } catch {
      throw new RepoReaderError("VALIDATION_ERROR", "Invalid regex query.");
    }
  }

  const query = options.query.toLowerCase();
  return {
    column: (line: string) => {
      const index = line.toLowerCase().indexOf(query);
      return index >= 0 ? index + 1 : undefined;
    }
  };
}

function isIncluded(path: string, includeGlobs: string[] = []): boolean {
  if (includeGlobs.length === 0) {
    return true;
  }
  return includeGlobs.some((glob) => matchesGlob(path, glob));
}

function parseCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
