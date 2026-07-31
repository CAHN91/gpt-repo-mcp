import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import type { WriteFileActionSchema, WriteFileInput, WriteFileResult, WriteGroupedEditChange } from "../contracts/write.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { atomicWriteFile, isNotFoundError } from "../runtime/fs-helpers.js";
import { normalizeRepoPath } from "./ignore-engine.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { SecretScanner } from "./secret-scanner.js";
import { WritePolicy } from "./write-policy.js";
import type { z } from "zod";

type WriteAction = z.infer<typeof WriteFileActionSchema>;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type ExistingTarget = {
  exists: true;
  repoPath: string;
  absolutePath: string;
  oldContent: Buffer;
  oldText: string;
  oldSha256: string;
};

type NewTarget = {
  exists: false;
  repoPath: string;
  absolutePath: string;
};

type WriteTarget = ExistingTarget | NewTarget;

type ComputedWrite = {
  action: WriteAction;
  nextText: string;
  nextContent: Buffer;
};

export type WriteGroupedEditResult = Omit<WriteFileResult, "action" | "summary"> & {
  action: "edit";
  summary: string;
};

export class FileWriter {
  private readonly secretScanner = new SecretScanner();

  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    private readonly policy: WritePolicy
  ) {}

  async checkPreconditions(input: {
    path: string;
    create_dirs?: boolean;
    expected_old_sha256?: string;
    expected_missing?: boolean;
  }): Promise<void> {
    if (!input.expected_old_sha256 && !input.expected_missing) {
      return;
    }
    const repoPath = validateRepoPath(input.path);
    const target = await this.resolveTarget(repoPath, Boolean(input.create_dirs), true);
    assertPreconditions(target, input);
  }

  async write(input: Omit<WriteFileInput, "repo_id">): Promise<WriteFileResult> {
    const action = input.action ?? "write";
    const repoPath = validateRepoPath(input.path);
    const dryRun = input.dry_run ?? false;

    this.policy.assertAllowed({ path: repoPath, bytes: 0, action });

    const target = await this.resolveTarget(repoPath, Boolean(input.create_dirs), dryRun);
    assertPreconditions(target, input);
    const computed = this.computeNextContent(action, input, target);

    const hasBlockedSecret = action === "write"
      ? this.secretScanner.hasSecretValue(computed.nextText)
      : this.secretScanner.hasNewSecretValue(target.exists ? target.oldText : "", computed.nextText);
    if (hasBlockedSecret) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret content blocked: ${repoPath}`);
    }
    this.policy.assertAllowed({ path: repoPath, bytes: computed.nextContent.byteLength, action });

    const oldSha256 = target.exists ? target.oldSha256 : undefined;
    const newSha256 = sha256(computed.nextContent);
    const created = !target.exists;
    const changed = !target.exists || oldSha256 !== newSha256;
    const bytesWritten = dryRun || !changed ? 0 : computed.nextContent.byteLength;

    const result: WriteFileResult = {
      ok: true,
      path: repoPath,
      action,
      dry_run: dryRun,
      changed,
      created,
      bytes_written: bytesWritten,
      ...(oldSha256 ? { old_sha256: oldSha256 } : {}),
      new_sha256: newSha256,
      summary: summarize(repoPath, action, created, changed, dryRun),
      warnings: []
    };

    if (dryRun || !changed) {
      return result;
    }

    await atomicWriteFile(target.absolutePath, computed.nextContent);
    return result;
  }

  async writeGroupedEdit(input: Omit<WriteGroupedEditChange, "type"> & { dry_run?: boolean }): Promise<WriteGroupedEditResult> {
    const repoPath = validateRepoPath(input.path);

    this.policy.assertAllowed({ path: repoPath, bytes: 0, action: "edit" });

    const target = await this.resolveTarget(repoPath, false);
    assertPreconditions(target, input);
    if (!target.exists) {
      throw new RepoReaderError("WRITE_TARGET_MISSING", `File does not exist: ${target.repoPath}`);
    }
    if (target.oldContent.includes(0)) {
      throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file cannot be edited: ${target.repoPath}`);
    }

    const nextText = applyGroupedEdits(target.oldText, input.edits, target.repoPath);
    if (this.secretScanner.hasNewSecretValue(target.oldText, nextText)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret content blocked: ${repoPath}`);
    }
    const nextContent = Buffer.from(nextText, "utf8");
    this.policy.assertAllowed({ path: repoPath, bytes: nextContent.byteLength, action: "edit" });

    const oldSha256 = target.oldSha256;
    const newSha256 = sha256(nextContent);
    const changed = oldSha256 !== newSha256;
    const dryRun = input.dry_run ?? false;
    const bytesWritten = dryRun || !changed ? 0 : nextContent.byteLength;

    const result: WriteGroupedEditResult = {
      ok: true,
      path: repoPath,
      action: "edit",
      dry_run: dryRun,
      changed,
      created: false,
      bytes_written: bytesWritten,
      old_sha256: oldSha256,
      new_sha256: newSha256,
      summary: summarizeGroupedEdit(repoPath, input.edits.length, changed, dryRun),
      warnings: []
    };

    if (dryRun || !changed) {
      return result;
    }

    await atomicWriteFile(target.absolutePath, nextContent);
    return result;
  }

  private computeNextContent(
    action: WriteAction,
    input: Omit<WriteFileInput, "repo_id">,
    target: WriteTarget
  ): ComputedWrite {
    if (action === "write") {
      return {
        action,
        nextText: requireContent(input, action),
        nextContent: Buffer.from(requireContent(input, action), "utf8")
      };
    }

    if (!target.exists) {
      throw new RepoReaderError("WRITE_TARGET_MISSING", `File does not exist: ${target.repoPath}`);
    }
    if (target.oldContent.includes(0)) {
      throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file cannot be edited: ${target.repoPath}`);
    }

    const oldText = target.oldText;
    let nextText: string;
    if (action === "append") {
      nextText = oldText + requireContent(input, action);
    } else if (action === "prepend") {
      nextText = requireContent(input, action) + oldText;
    } else if (action === "replace") {
      const find = requireFind(input, action);
      const replace = requireReplace(input, action);
      assertFindAppearsExactlyOnce(oldText, find, target.repoPath);
      nextText = oldText.replace(find, replace);
    } else if (action === "insert_before") {
      const find = requireFind(input, action);
      assertFindAppearsExactlyOnce(oldText, find, target.repoPath);
      const index = oldText.indexOf(find);
      nextText = oldText.slice(0, index) + requireContent(input, action) + oldText.slice(index);
    } else {
      const find = requireFind(input, action);
      assertFindAppearsExactlyOnce(oldText, find, target.repoPath);
      const index = oldText.indexOf(find) + find.length;
      nextText = oldText.slice(0, index) + requireContent(input, action) + oldText.slice(index);
    }

    return { action, nextText, nextContent: Buffer.from(nextText, "utf8") };
  }

  private async resolveTarget(repoPath: string, createDirs: boolean, dryRun = false): Promise<WriteTarget> {
    try {
      const resolved = await this.sandbox.resolve(repoPath);
      if (!resolved.stat.isFile()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Not a regular file: ${resolved.repoPath}`);
      }
      const oldContent = await readFile(resolved.absolutePath);
      const oldText = decodeUtf8(oldContent, resolved.repoPath);
      return {
        exists: true,
        repoPath: resolved.repoPath,
        absolutePath: resolved.absolutePath,
        oldContent,
        oldText,
        oldSha256: sha256(oldContent)
      };
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    await this.ensureParentDirectory(repoPath, createDirs, dryRun);
    return {
      exists: false,
      repoPath,
      absolutePath: join(this.root, repoPath)
    };
  }

  private async ensureParentDirectory(repoPath: string, createDirs: boolean, dryRun: boolean): Promise<void> {
    const parentPath = posix.dirname(repoPath);
    if (parentPath === ".") {
      await assertWithinRoot(this.root, this.root);
      return;
    }

    const segments = normalizeRepoPath(parentPath).split("/").filter(Boolean);
    let currentRepoPath = "";
    for (const segment of segments) {
      currentRepoPath = currentRepoPath ? `${currentRepoPath}/${segment}` : segment;
      const absolutePath = join(this.root, currentRepoPath);
      try {
        const stat = await lstat(absolutePath);
        if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
          throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Unsupported file type: ${currentRepoPath}`);
        }
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Parent is not a directory: ${currentRepoPath}`);
        }
        await assertWithinRoot(this.root, absolutePath);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        if (!createDirs) {
          throw new RepoReaderError("WRITE_PARENT_MISSING", `Parent directory does not exist: ${parentPath}`);
        }
        if (!dryRun) {
          await mkdir(absolutePath);
          await assertWithinRoot(this.root, absolutePath);
        }
      }
    }
  }
}

function assertPreconditions(
  target: WriteTarget,
  input: { expected_old_sha256?: string; expected_missing?: boolean }
): void {
  if (input.expected_missing && target.exists) {
    throw new RepoReaderError("WRITE_TARGET_EXISTS", `Path already exists: ${target.repoPath}`, {
      diagnostics: {
        failed_path: target.repoPath,
        current_sha256: target.oldSha256
      }
    });
  }
  if (input.expected_old_sha256 && !target.exists) {
    throw new RepoReaderError("WRITE_TARGET_MISSING", `File does not exist: ${target.repoPath}`, {
      diagnostics: {
        failed_path: target.repoPath,
        expected_old_sha256: input.expected_old_sha256
      }
    });
  }
  if (input.expected_old_sha256 && target.exists && input.expected_old_sha256 !== target.oldSha256) {
    throw new RepoReaderError("WRITE_STALE_EXPECTED_SHA", `Current file SHA does not match expected_old_sha256: ${target.repoPath}`, {
      diagnostics: {
        failed_path: target.repoPath,
        expected_old_sha256: input.expected_old_sha256,
        current_sha256: target.oldSha256
      }
    });
  }
}

function decodeUtf8(content: Buffer, repoPath: string): string {
  try {
    return textDecoder.decode(content);
  } catch {
    throw new RepoReaderError("BINARY_FILE_REJECTED", `File is not valid UTF-8: ${repoPath}`);
  }
}

function requireContent(input: Omit<WriteFileInput, "repo_id">, action: WriteAction): string {
  if (typeof input.content !== "string") {
    throw new RepoReaderError("WRITE_CONTENT_REQUIRED", `content is required for ${action}.`);
  }
  return input.content;
}

function requireFind(input: Omit<WriteFileInput, "repo_id">, action: WriteAction): string {
  if (typeof input.find !== "string" || input.find.length === 0) {
    throw new RepoReaderError("WRITE_FIND_REQUIRED", `find is required for ${action}.`);
  }
  return input.find;
}

function requireReplace(input: Omit<WriteFileInput, "repo_id">, action: WriteAction): string {
  if (typeof input.replace !== "string") {
    throw new RepoReaderError("WRITE_CONTENT_REQUIRED", `replace is required for ${action}.`);
  }
  return input.replace;
}

function assertFindAppearsExactlyOnce(text: string, find: string, repoPath: string): void {
  const first = text.indexOf(find);
  if (first === -1) {
    throw new RepoReaderError("WRITE_FIND_NOT_FOUND", `find text was not found in ${repoPath}.`);
  }
  if (text.indexOf(find, first + find.length) !== -1) {
    throw new RepoReaderError("WRITE_FIND_NOT_UNIQUE", `find text appears more than once in ${repoPath}.`);
  }
}

function applyGroupedEdits(text: string, edits: WriteGroupedEditChange["edits"], repoPath: string): string {
  let nextText = text;
  for (const edit of edits) {
    const find = requireGroupedFind(edit, repoPath);
    assertFindAppearsExactlyOnce(nextText, find, repoPath);
    if (edit.type === "replace") {
      nextText = nextText.replace(find, requireGroupedReplace(edit));
    } else if (edit.type === "insert_before") {
      const index = nextText.indexOf(find);
      nextText = nextText.slice(0, index) + requireGroupedContent(edit) + nextText.slice(index);
    } else {
      const index = nextText.indexOf(find) + find.length;
      nextText = nextText.slice(0, index) + requireGroupedContent(edit) + nextText.slice(index);
    }
  }
  return nextText;
}

function requireGroupedFind(edit: WriteGroupedEditChange["edits"][number], repoPath: string): string {
  if (typeof edit.find !== "string" || edit.find.length === 0) {
    throw new RepoReaderError("WRITE_FIND_REQUIRED", `find is required for grouped edit in ${repoPath}.`);
  }
  return edit.find;
}

function requireGroupedReplace(edit: WriteGroupedEditChange["edits"][number]): string {
  if (typeof edit.replace !== "string") {
    throw new RepoReaderError("WRITE_CONTENT_REQUIRED", "replace is required for grouped replace.");
  }
  return edit.replace;
}

function requireGroupedContent(edit: WriteGroupedEditChange["edits"][number]): string {
  if (typeof edit.content !== "string") {
    throw new RepoReaderError("WRITE_CONTENT_REQUIRED", `content is required for grouped ${edit.type}.`);
  }
  return edit.content;
}

function summarize(repoPath: string, action: WriteAction, created: boolean, changed: boolean, dryRun: boolean): string {
  if (!changed) {
    return `No changes for ${repoPath}.`;
  }
  if (dryRun) {
    return `Dry run would ${created ? "create" : action} ${repoPath}.`;
  }
  if (created) {
    return `Created ${repoPath}.`;
  }
  return `Updated ${repoPath}.`;
}

function summarizeGroupedEdit(repoPath: string, editCount: number, changed: boolean, dryRun: boolean): string {
  if (!changed) {
    return `No changes for ${repoPath}.`;
  }
  if (dryRun) {
    return `Dry run would apply ${editCount} ${editCount === 1 ? "edit" : "edits"} to ${repoPath}.`;
  }
  return `Applied ${editCount} ${editCount === 1 ? "edit" : "edits"} to ${repoPath}.`;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function assertWithinRoot(root: string, target: string): Promise<void> {
  const [rootReal, targetReal] = await Promise.all([
    realpath(root),
    realpath(target)
  ]);
  const rel = relative(resolve(rootReal), resolve(targetReal));
  if (rel !== "" && (rel.startsWith("..") || rel.includes(`..${sep}`))) {
    throw new RepoReaderError("SYMLINK_ESCAPE_REJECTED", `Path escapes approved repository: ${dirname(target)}`);
  }
}
