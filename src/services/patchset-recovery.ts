import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OperationLedgerEntry } from "../contracts/operation-receipt.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { OperationLedgerService } from "./operation-ledger-service.js";
import type { PathSandbox } from "./path-sandbox.js";

export async function patchsetLedgerState(root: string, repoId: string, patchsetId: string): Promise<{
  applyEntry?: OperationLedgerEntry;
  rollbackEntry?: OperationLedgerEntry;
  warnings: string[];
}> {
  const ledger = await new OperationLedgerService(root).readAllForRepo(repoId);
  let applyEntry: OperationLedgerEntry | undefined;
  let rollbackEntry: OperationLedgerEntry | undefined;
  for (const event of ledger.events) {
    if (event.patchset_id !== patchsetId) continue;
    if (event.event_type === "write_applied") {
      applyEntry = event;
      rollbackEntry = undefined;
    }
    if (event.event_type === "patchset_rolled_back") rollbackEntry = event;
  }
  return { applyEntry, rollbackEntry, warnings: ledger.warnings };
}

export function assertNoStagedPatchsetPaths(
  statusFiles: Array<{ path: string; index: string }>,
  affectedPaths: string[]
): void {
  const affected = new Set(affectedPaths);
  const staged = statusFiles
    .filter((file) => affected.has(file.path) && file.index.trim().length > 0 && file.index !== "?")
    .map((file) => file.path);
  if (staged.length > 0) {
    throw new RepoReaderError("PATCHSET_ROLLBACK_STAGED_PATHS", "Patchset rollback refuses staged patchset paths.", {
      diagnostics: { actual_paths: staged }
    });
  }
}

export async function readExistingFile(root: string, path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(join(root, path));
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

export async function assertDeletableCreatedFile(sandbox: PathSandbox, path: string): Promise<void> {
  const resolved = await sandbox.resolve(path);
  if (!resolved.stat.isFile()) {
    throw new RepoReaderError("PATCHSET_ROLLBACK_UNSUPPORTED_TARGET", "Patchset-created rollback can delete regular files only.", {
      diagnostics: { failed_path: path }
    });
  }
}

type PathSnapshot = {
  path: string;
  existed: boolean;
  content?: Buffer;
};

export async function captureSnapshots(root: string, paths: string[]): Promise<PathSnapshot[]> {
  const snapshots: PathSnapshot[] = [];
  for (const path of paths) {
    try {
      snapshots.push({ path, existed: true, content: await readFile(join(root, path)) });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      snapshots.push({ path, existed: false });
    }
  }
  return snapshots;
}

export async function restoreSnapshots(root: string, snapshots: PathSnapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    const absolutePath = join(root, snapshot.path);
    if (snapshot.existed && snapshot.content) {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, snapshot.content);
    } else {
      await unlink(absolutePath).catch((error: unknown) => {
        if (!isNotFoundError(error)) throw error;
      });
    }
  }
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
