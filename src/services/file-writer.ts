import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import type { WriteFileActionSchema, WriteFileInput, WriteFileResult, WriteGroupedEditChange } from "../contracts/write.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
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
  canonicalRepoPath: string;
  absolutePath: string;
  oldContent: Buffer;
  oldText: string;
  oldSha256: string;
};

type NewTarget = {
  exists: false;
  repoPath: string;
  canonicalRepoPath: string;
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

  async write(input: Omit<WriteFileInput, "repo_id">): Promise<WriteFileResult> {
    const action = input.action ?? "write";
    const repoPath = validateRepoPath(input.path);

    this.assertAllowedForPaths([repoPath], 0, action);

    const target = await this.resolveTarget(repoPath, Boolean(input.create_dirs), action);
    const computed = this.computeNextContent(action, input, target);

    if (this.secretScanner.hasSecretValue(computed.nextText)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret content blocked: ${repoPath}`);
    }
    this.assertAllowedForPaths([repoPath, target.canonicalRepoPath], computed.nextContent.byteLength, action);

    const oldSha256 = target.exists ? target.oldSha256 : undefined;
    const newSha256 = sha256(computed.nextContent);
    const created = !target.exists;
    const changed = !target.exists || oldSha256 !== newSha256;
    const dryRun = input.dry_run ?? false;
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

    this.assertAllowedForPaths([repoPath], 0, "edit");

    const target = await this.resolveTarget(repoPath, false, "edit");
    if (!target.exists) {
      throw new RepoReaderError("WRITE_TARGET_MISSING", `File does not exist: ${target.repoPath}`);
    }
    if (target.oldContent.includes(0)) {
      throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file cannot be edited: ${target.repoPath}`);
    }

    const nextText = applyGroupedEdits(target.oldText, input.edits, target.repoPath);
    if (this.secretScanner.hasSecretValue(nextText)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret content blocked: ${repoPath}`);
    }
    const nextContent = Buffer.from(nextText, "utf8");
    this.assertAllowedForPaths([repoPath, target.canonicalRepoPath], nextContent.byteLength, "edit");

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

  private async resolveTarget(repoPath: string, createDirs: boolean, action: WriteAction | "edit"): Promise<WriteTarget> {
    try {
      const resolved = await this.sandbox.resolve(repoPath);
      if (!resolved.stat.isFile()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Not a regular file: ${resolved.repoPath}`);
      }
      this.assertAllowedForPaths([resolved.repoPath, resolved.canonicalRepoPath], 0, action);
      const oldContent = await readFile(resolved.absolutePath);
      const oldText = decodeUtf8(oldContent, resolved.repoPath);
      return {
        exists: true,
        repoPath: resolved.repoPath,
        canonicalRepoPath: resolved.canonicalRepoPath,
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

    const target = await this.ensureParentDirectory(repoPath, createDirs);
    this.assertAllowedForPaths([repoPath, target.canonicalRepoPath], 0, action);
    return {
      exists: false,
      repoPath,
      canonicalRepoPath: target.canonicalRepoPath,
      absolutePath: target.absolutePath
    };
  }

  private assertAllowedForPaths(paths: string[], bytes: number, action: WriteAction | "edit"): void {
    for (const path of [...new Set(paths)]) {
      this.policy.assertAllowed({ path, bytes, action });
    }
  }

  private async ensureParentDirectory(
    repoPath: string,
    createDirs: boolean
  ): Promise<{ absolutePath: string; canonicalRepoPath: string }> {
    const parentPath = posix.dirname(repoPath);
    if (parentPath === ".") {
      await assertWithinRoot(this.root, this.root);
      return {
        absolutePath: join(this.root, repoPath),
        canonicalRepoPath: repoPath
      };
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
        await mkdir(absolutePath);
        await assertWithinRoot(this.root, absolutePath);
      }
    }

    const parentAbsolutePath = join(this.root, parentPath);
    const [rootReal, parentReal] = await Promise.all([
      realpath(this.root),
      realpath(parentAbsolutePath)
    ]);
    const rel = relative(resolve(rootReal), resolve(parentReal));
    if (rel !== "" && (rel.startsWith("..") || rel.includes(`..${sep}`))) {
      throw new RepoReaderError("SYMLINK_ESCAPE_REJECTED", `Path escapes approved repository: ${parentPath}`);
    }
    const canonicalParentPath = rel === "" ? "." : rel.split(sep).join(posix.sep);
    const targetName = basename(repoPath);
    return {
      absolutePath: join(parentReal, targetName),
      canonicalRepoPath: canonicalParentPath === "." ? targetName : `${canonicalParentPath}/${targetName}`
    };
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

async function atomicWriteFile(path: string, content: Buffer): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.repo-write-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { flag: "wx" });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
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

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "ENOENT"
  );
}
