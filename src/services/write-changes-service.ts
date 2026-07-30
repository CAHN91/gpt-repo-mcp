import { lstat, readFile, rmdir, unlink } from "node:fs/promises";
import { join, posix } from "node:path";
import type { WriteChange, WriteChangesInput, WriteChangesResult, WriteSimpleChange } from "../contracts/write.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { atomicWriteFile, isNotFoundError } from "../runtime/fs-helpers.js";
import { FileWriter } from "./file-writer.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { WritePolicy } from "./write-policy.js";

const MAX_CHANGES_PER_PACK = 25;
const MAX_TOTAL_CHANGE_CONTENT_BYTES = 5 * 1024 * 1024;
const NEXT_STEPS = [
  "Run repo_git_review to inspect the resulting diff.",
  "If the edit pack is wrong, use the repo_write_recover payload returned by repo_git_review.",
  "If the diff is good, use the repo_write_stage_commit payload returned by repo_git_review."
];
const PARTIAL_FAILURE_RECOVERY_HINT =
  "Run repo_git_review and use its repo_write_recover payload for the paths whose rollback failed.";

type TargetSnapshot = {
  path: string;
  absolutePath: string;
  existed: boolean;
  oldContent?: Buffer;
  missingParentPaths: string[];
};

export class WriteChangesService {
  private readonly writer: FileWriter;

  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    policy: WritePolicy
  ) {
    this.writer = new FileWriter(root, sandbox, policy);
  }

  async apply(input: Omit<WriteChangesInput, "repo_id">): Promise<WriteChangesResult> {
    if (input.changes.length > MAX_CHANGES_PER_PACK) {
      throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `Edit pack exceeds maximum changes: ${MAX_CHANGES_PER_PACK}`);
    }
    if (totalPayloadBytes(input.changes) > MAX_TOTAL_CHANGE_CONTENT_BYTES) {
      throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `Edit pack exceeds maximum total content bytes: ${MAX_TOTAL_CHANGE_CONTENT_BYTES}`);
    }
    assertUniqueTargetPaths(input.changes);

    const previewFiles: WriteChangesResult["files"] = [];
    for (const change of input.changes) {
      const result = await this.applyChange(change, true);
      previewFiles.push(toFileResult(result));
    }

    const dryRun = input.dry_run ?? false;
    const files: WriteChangesResult["files"] = [];
    const appliedPaths: string[] = [];
    if (dryRun) {
      files.push(...previewFiles);
      appliedPaths.push(...previewFiles.filter((file) => file.changed).map((file) => file.path));
    } else {
      const snapshots = new Map<string, TargetSnapshot>();
      for (const change of input.changes) {
        const snapshot = await this.captureSnapshot(change.path);
        snapshots.set(snapshot.path, snapshot);
      }

      for (const [index, change] of input.changes.entries()) {
        try {
          const result = await this.applyChange(change, false, previewFiles[index]);
          files.push(toFileResult(result));
          if (result.changed) {
            appliedPaths.push(result.path);
          }
        } catch (error) {
          const rollback = await rollbackAppliedPaths(this.root, snapshots, appliedPaths);
          throw atomicFailure(error, rollback, change.path);
        }
      }
    }

    const changedPaths = unique(appliedPaths);
    const changed = files.filter((file) => file.changed).length;
    const created = files.filter((file) => file.created).length;
    const unchanged = files.length - changed;

    return {
      ok: true,
      dry_run: dryRun,
      changed_paths: changedPaths,
      files,
      counts: {
        requested: input.changes.length,
        changed,
        created,
        unchanged
      },
      summary: summarize(input.changes.length, changed, changedPaths.length, dryRun),
      warnings: [],
      next_steps: NEXT_STEPS
    };
  }

  private applyChange(
    change: WriteChange,
    dryRun: boolean,
    preview?: WriteChangesResult["files"][number]
  ) {
    const transactionGuard = preview
      ? preview.created
        ? { expected_missing: true }
        : { expected_old_sha256: preview.old_sha256 }
      : {};
    return change.type === "edit"
      ? this.writer.writeGroupedEdit({
          path: change.path,
          edits: change.edits,
          dry_run: dryRun,
          ...transactionGuard
        })
      : this.writer.write(toWriteFileInput(change, dryRun, transactionGuard));
  }

  private async captureSnapshot(path: string): Promise<TargetSnapshot> {
    const repoPath = validateRepoPath(path);
    try {
      const resolved = await this.sandbox.resolve(repoPath);
      return {
        path: repoPath,
        absolutePath: resolved.absolutePath,
        existed: true,
        oldContent: await readFile(resolved.absolutePath),
        missingParentPaths: []
      };
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    return {
      path: repoPath,
      absolutePath: join(this.root, repoPath),
      existed: false,
      missingParentPaths: await findMissingParentPaths(this.root, repoPath)
    };
  }
}

function toFileResult(result: Awaited<ReturnType<FileWriter["write"]>> | Awaited<ReturnType<FileWriter["writeGroupedEdit"]>>) {
  return {
    path: result.path,
    type: result.action,
    changed: result.changed,
    created: result.created,
    bytes_written: result.bytes_written,
    ...(result.old_sha256 ? { old_sha256: result.old_sha256 } : {}),
    ...(result.new_sha256 ? { new_sha256: result.new_sha256 } : {}),
    summary: result.summary
  };
}

function toWriteFileInput(
  change: WriteSimpleChange,
  dryRun: boolean,
  transactionGuard: { expected_old_sha256?: string; expected_missing?: boolean } = {}
) {
  return {
    path: change.path,
    action: change.type,
    ...(typeof change.content === "string" ? { content: change.content } : {}),
    ...(typeof change.find === "string" ? { find: change.find } : {}),
    ...(typeof change.replace === "string" ? { replace: change.replace } : {}),
    ...(typeof change.expected_old_sha256 === "string" ? { expected_old_sha256: change.expected_old_sha256 } : {}),
    ...(typeof change.expected_missing === "boolean" ? { expected_missing: change.expected_missing } : {}),
    create_dirs: change.type === "write" ? true : undefined,
    dry_run: dryRun,
    ...transactionGuard
  };
}

function assertUniqueTargetPaths(changes: WriteChange[]): void {
  const seen = new Set<string>();
  for (const change of changes) {
    const normalized = safeDuplicatePathKey(change.path);
    if (seen.has(normalized)) {
      throw new RepoReaderError("VALIDATION_ERROR", `Edit pack contains multiple changes for the same path: ${normalized}`);
    }
    seen.add(normalized);
  }
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function totalPayloadBytes(changes: WriteChange[]): number {
  return changes.reduce((total, change) => {
    if (change.type === "edit") {
      return total + change.edits.reduce((editTotal, edit) => {
        const contentBytes = typeof edit.content === "string" ? Buffer.byteLength(edit.content, "utf8") : 0;
        const replaceBytes = typeof edit.replace === "string" ? Buffer.byteLength(edit.replace, "utf8") : 0;
        return editTotal + contentBytes + replaceBytes;
      }, 0);
    }
    const contentBytes = typeof change.content === "string" ? Buffer.byteLength(change.content, "utf8") : 0;
    const replaceBytes = typeof change.replace === "string" ? Buffer.byteLength(change.replace, "utf8") : 0;
    return total + contentBytes + replaceBytes;
  }, 0);
}

function summarize(requested: number, changed: number, changedPathCount: number, dryRun: boolean): string {
  if (changed === 0) {
    return `No changes across ${requested} requested ${requested === 1 ? "file" : "changes"}.`;
  }
  const verb = dryRun ? "Dry run would apply" : "Applied";
  return `${verb} ${changed} ${changed === 1 ? "change" : "changes"} across ${changedPathCount} ${changedPathCount === 1 ? "file" : "files"}.`;
}

async function findMissingParentPaths(root: string, repoPath: string): Promise<string[]> {
  const parentPath = posix.dirname(repoPath);
  if (parentPath === ".") return [];
  const missing: string[] = [];
  let current = "";
  for (const segment of parentPath.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    try {
      await lstat(join(root, current));
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      missing.push(current);
    }
  }
  return missing;
}

async function rollbackAppliedPaths(
  root: string,
  snapshots: Map<string, TargetSnapshot>,
  appliedPaths: string[]
): Promise<{ rolledBackPaths: string[]; failedPaths: string[] }> {
  const rolledBackPaths: string[] = [];
  const failedPaths: string[] = [];
  const snapshotsToRestore = unique(appliedPaths).reverse().map((path) => snapshots.get(path)).filter(
    (snapshot): snapshot is TargetSnapshot => snapshot !== undefined
  );

  for (const snapshot of snapshotsToRestore) {
    try {
      if (snapshot.existed && snapshot.oldContent) {
        await atomicWriteFile(snapshot.absolutePath, snapshot.oldContent);
      } else {
        await unlink(snapshot.absolutePath);
      }
      rolledBackPaths.push(snapshot.path);
    } catch (error) {
      if (!snapshot.existed && isNotFoundError(error)) {
        rolledBackPaths.push(snapshot.path);
      } else {
        failedPaths.push(snapshot.path);
      }
    }
  }

  const parentPaths = unique(snapshotsToRestore.flatMap((snapshot) => snapshot.missingParentPaths))
    .sort((left, right) => right.split("/").length - left.split("/").length);
  for (const parentPath of parentPaths) {
    try {
      await rmdir(join(root, parentPath));
    } catch {
      // A non-empty or concurrently created directory is left intact.
    }
  }

  return { rolledBackPaths: rolledBackPaths.reverse(), failedPaths: failedPaths.reverse() };
}

function atomicFailure(
  error: unknown,
  rollback: { rolledBackPaths: string[]; failedPaths: string[] },
  failedPath: string
): RepoReaderError {
  const normalizedFailedPath = safeFailedPath(failedPath);
  if (rollback.failedPaths.length > 0) {
    return new RepoReaderError("INTERNAL_ERROR", "Atomic edit pack failed and rollback was incomplete.", {
      diagnostics: {
        applied_paths: rollback.failedPaths,
        rolled_back_paths: rollback.rolledBackPaths,
        ...(normalizedFailedPath ? { failed_path: normalizedFailedPath } : {}),
        recovery_hint: PARTIAL_FAILURE_RECOVERY_HINT
      }
    });
  }
  if (error instanceof RepoReaderError) {
    return new RepoReaderError(error.code, error.message, {
      retryable: error.retryable,
      diagnostics: {
        ...error.diagnostics,
        rolled_back_paths: rollback.rolledBackPaths,
        ...(normalizedFailedPath ? { failed_path: normalizedFailedPath } : {})
      }
    });
  }
  return new RepoReaderError("INTERNAL_ERROR", "Atomic edit pack failed and was rolled back.", {
    diagnostics: {
      rolled_back_paths: rollback.rolledBackPaths,
      ...(normalizedFailedPath ? { failed_path: normalizedFailedPath } : {})
    }
  });
}

function safeFailedPath(path: string): string | undefined {
  try {
    return validateRepoPath(path);
  } catch {
    return undefined;
  }
}

function safeDuplicatePathKey(path: string): string {
  try {
    return validateRepoPath(path);
  } catch {
    return path;
  }
}
