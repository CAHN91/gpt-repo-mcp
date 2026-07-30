import { RootRegistry } from "./root-registry.js";
import { PathSandbox } from "./path-sandbox.js";
import { FileReader } from "./file-reader.js";
import { RepoTreeService } from "./repo-tree-service.js";
import { isExcludedByGlob, matchesGlob } from "./glob-service.js";
import { RepoReaderError, toRepoReaderError } from "../runtime/errors.js";

export type ReadManyOptions = {
  paths?: string[];
  include_globs?: string[];
  exclude_globs?: string[];
  max_files?: number;
  max_bytes_per_file?: number;
  max_total_bytes?: number;
  cursor?: string;
};

export type ReadManyResult = {
  files: Array<Awaited<ReturnType<FileReader["read"]>>>;
  skipped: Array<{ path: string; reason: string }>;
  matched_count: number;
  returned_count: number;
  truncated: boolean;
  next_cursor?: string;
};

export class ReadManyService {
  constructor(
    private readonly sandbox: PathSandbox,
    private readonly limits: RootRegistry["limits"]
  ) {}

  async readMany(options: ReadManyOptions): Promise<ReadManyResult> {
    if ((options.paths?.length ?? 0) === 0 && (options.include_globs?.length ?? 0) === 0) {
      throw new RepoReaderError("VALIDATION_ERROR", "repo_read_many requires paths or include_globs.");
    }

    const reader = new FileReader(this.sandbox);
    const paths = await this.expandPaths(options);
    const start = parseCursor(options.cursor);
    const maxFiles = Math.min(options.max_files ?? this.limits.max_files, this.limits.max_files);
    const maxTotalBytes = options.max_total_bytes ?? this.limits.max_total_bytes;
    const window = paths.slice(start, start + maxFiles);
    const files: ReadManyResult["files"] = [];
    const skipped: ReadManyResult["skipped"] = [];
    let totalBytes = 0;

    for (const path of window) {
      try {
        const file = await reader.read({ path, max_bytes: options.max_bytes_per_file });
        if (totalBytes + file.size_bytes > maxTotalBytes) {
          skipped.push({ path, reason: "MAX_TOTAL_BYTES_EXCEEDED" });
          continue;
        }
        totalBytes += file.size_bytes;
        files.push(file);
      } catch (error) {
        const normalized = toRepoReaderError(error);
        if (normalized.code !== "INTERNAL_ARTIFACT_BLOCKED") {
          skipped.push({ path, reason: normalized.code });
        }
      }
    }

    const nextIndex = start + window.length;
    const truncated = nextIndex < paths.length;
    return {
      files,
      skipped,
      matched_count: paths.length,
      returned_count: files.length,
      truncated,
      next_cursor: truncated ? String(nextIndex) : undefined
    };
  }

  private async expandPaths(options: ReadManyOptions): Promise<string[]> {
    const explicitPaths = options.paths ?? [];
    const tree = options.include_globs?.length
      ? await new RepoTreeService(this.sandbox).tree({ include_files: true, respect_default_excludes: true })
      : { entries: [] };
    const globPaths = (options.include_globs ?? []).flatMap((glob) =>
      tree.entries
        .filter((entry) => entry.type === "file" && matchesGlob(entry.path, glob))
        .map((entry) => entry.path)
    );
    return [...new Set([...explicitPaths, ...globPaths])]
      .filter((path) => !isExcludedByGlob(path, options.exclude_globs))
      .sort((a, b) => explicitPaths.includes(a) && explicitPaths.includes(b) ? 0 : a.localeCompare(b));
  }
}

function parseCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
