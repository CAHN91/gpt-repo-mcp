import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { OperationLedgerEntry } from "../contracts/operation-receipt.contract.js";
import { PatchsetApplyInputSchema, PatchsetApplyResultSchema, PatchsetPrepareResultSchema, PatchsetReviewInputSchema, PatchsetReviewResultSchema, PatchsetRollbackInputSchema, PatchsetRollbackResultSchema, type PatchsetApplyInput, type PatchsetApplyResult, type PatchsetHunkDiagnostic, type PatchsetManifest, type PatchsetPrepareInput, type PatchsetPrepareResult, type PatchsetReviewInput, type PatchsetReviewResult, type PatchsetRollbackInput, type PatchsetRollbackResult } from "../contracts/patchset.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { FileWriter } from "./file-writer.js";
import { GitOperationsService } from "./git-operations-service.js";
import { GitReviewService } from "./git-review-service.js";
import { GitService } from "./git-service.js";
import { OperationReceiptService } from "./operation-receipt-service.js";
import { OperationsPolicy } from "./operations-policy.js";
import { PatchsetManifestStore, patchsetAffectedPaths } from "./patchset-manifest-store.js";
import { PathSandbox } from "./path-sandbox.js";
import { WritePolicy } from "./write-policy.js";
import {
  changedPathsForResults,
  hunkDiagnosticsForResults,
  rollbackHintForResults,
  type PatchsetApplyFileResult
} from "./patchset-apply-results.js";
import {
  assertDeletableCreatedFile,
  assertNoStagedPatchsetPaths,
  captureSnapshots,
  patchsetLedgerState,
  readExistingFile,
  restoreSnapshots,
  sha256Buffer
} from "./patchset-recovery.js";

const execFileAsync = promisify(execFile);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class PatchsetService {
  private readonly writer: FileWriter;
  private readonly manifestStore: PatchsetManifestStore;

  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    writePolicy: WritePolicy,
    private readonly operationsPolicy: OperationsPolicy = new OperationsPolicy()
  ) {
    this.writer = new FileWriter(root, sandbox, writePolicy);
    this.manifestStore = new PatchsetManifestStore(root, writePolicy);
  }

  async prepare(input: PatchsetPrepareInput): Promise<PatchsetPrepareResult> {
    const prepared = await this.manifestStore.prepare(input);

    return PatchsetPrepareResultSchema.parse({
      ok: true,
      patchset_id: prepared.patchset_id,
      manifest_path: prepared.manifest_path,
      manifest: prepared.manifest,
      affected_paths: prepared.affected_paths,
      warnings: [],
      next_tool_payloads: {
        repo_apply_patchset: {
          repo_id: prepared.args.repo_id,
          patchset_id: prepared.patchset_id,
          ...(prepared.args.base_head_sha ? { expected_head_sha: prepared.args.base_head_sha } : {})
        }
      }
    });
  }

  async readManifest(patchsetId: string): Promise<{ manifest: PatchsetManifest; manifest_path: string }> {
    return this.manifestStore.read(patchsetId);
  }

  async review(input: PatchsetReviewInput): Promise<PatchsetReviewResult> {
    const args = PatchsetReviewInputSchema.parse(input);
    const { manifest, manifest_path } = await this.readManifest(args.patchset_id);
    if (manifest.repo_id !== args.repo_id) {
      throw new RepoReaderError("VALIDATION_ERROR", "Patchset repo_id does not match request.");
    }
    const ledger = await patchsetLedgerState(this.root, args.repo_id, args.patchset_id);
    const applied = Boolean(ledger.applyEntry && !ledger.rollbackEntry);
    const rolledBack = Boolean(ledger.rollbackEntry);
    const gitReview = await new GitReviewService(this.root, this.operationsPolicy).review({
      repo_id: args.repo_id,
      detail: "compact",
      ...(args.max_files ? { max_files: args.max_files } : {})
    });
    return PatchsetReviewResultSchema.parse({
      ok: true,
      patchset_id: args.patchset_id,
      manifest_path,
      manifest,
      applied,
      rolled_back: rolledBack,
      git_review: gitReview,
      warnings: ledger.warnings
    });
  }

  async rollback(input: PatchsetRollbackInput): Promise<PatchsetRollbackResult> {
    const args = PatchsetRollbackInputSchema.parse(input);
    const { manifest } = await this.readManifest(args.patchset_id);
    if (manifest.repo_id !== args.repo_id) {
      throw new RepoReaderError("VALIDATION_ERROR", "Patchset repo_id does not match request.");
    }

    const affected = patchsetAffectedPaths(manifest.files);
    this.operationsPolicy.assertRestoreAllowed(affected);
    const ledger = await patchsetLedgerState(this.root, args.repo_id, args.patchset_id);
    if (!ledger.applyEntry) {
      throw new RepoReaderError("PATCHSET_NOT_APPLIED", "Patchset has no apply ledger event.");
    }
    if (ledger.applyEntry.commit_sha) {
      throw new RepoReaderError("PATCHSET_ALREADY_COMMITTED", "Patchset rollback is only available before commit linkage.");
    }
    if (ledger.rollbackEntry) {
      throw new RepoReaderError("PATCHSET_ALREADY_ROLLED_BACK", "Patchset already has a rollback ledger event.");
    }

    const status = await new GitService(this.root).status();
    if (status.head_sha !== args.expected_head_sha) {
      throw new RepoReaderError("GIT_HEAD_MISMATCH", "Current HEAD does not match expected_head_sha.", {
        diagnostics: { head_sha: status.head_sha, expected_head_sha: args.expected_head_sha }
      });
    }
    assertNoStagedPatchsetPaths(status.files, affected);

    const plan = await this.planRollback(manifest, ledger.applyEntry, status.files);
    const dryRun = args.dry_run ?? false;
    if (!dryRun) {
      if (plan.restored_paths.length > 0) {
        await new GitOperationsService(this.root, this.operationsPolicy).restorePaths({
          paths: plan.restored_paths,
          expected_head_sha: args.expected_head_sha
        });
      }
      for (const path of plan.deleted_paths) {
        await unlink(join(this.root, path));
      }
    }

    const changedPaths = [...plan.restored_paths, ...plan.deleted_paths];
    const receipt = !dryRun && changedPaths.length > 0
      ? await new OperationReceiptService(this.root).writeLastWrite({
          tool: "repo_rollback_patchset",
          repo_id: args.repo_id,
          ...(manifest.base_head_sha ? { head_sha_before: manifest.base_head_sha, head_sha_after: manifest.base_head_sha } : {}),
          touched_paths: affected,
          changed_paths: changedPaths,
          created_paths: [],
          modified_paths: plan.restored_paths,
          counts: {
            requested: affected.length,
            changed: changedPaths.length,
            created: 0,
            unchanged: plan.skipped.length
          },
          summary: `Rolled back patchset ${args.patchset_id} across ${changedPaths.length} ${changedPaths.length === 1 ? "path" : "paths"}.`,
          patchset_id: args.patchset_id,
          files: [
            ...plan.restored_paths.map((path) => ({
              path,
              changed: true,
              created: false,
              old_sha256: plan.before_sha256[path],
              ...(plan.after_sha256[path] ? { new_sha256: plan.after_sha256[path] } : {})
            })),
            ...plan.deleted_paths.map((path) => ({
              path,
              changed: true,
              created: false,
              old_sha256: plan.before_sha256[path]
            }))
          ],
          ledger_event_type: "patchset_rolled_back"
        })
      : { warnings: [] };

    return PatchsetRollbackResultSchema.parse({
      ok: true,
      dry_run: dryRun,
      patchset_id: args.patchset_id,
      ...("operation_receipt" in receipt && receipt.operation_receipt ? { operation_id: receipt.operation_receipt.operation_id } : {}),
      restored_paths: plan.restored_paths,
      deleted_paths: plan.deleted_paths,
      skipped: plan.skipped,
      counts: {
        restored: plan.restored_paths.length,
        deleted: plan.deleted_paths.length,
        skipped: plan.skipped.length
      },
      ...("operation_receipt" in receipt && receipt.operation_receipt ? { operation_receipt: receipt.operation_receipt } : {}),
      warnings: receipt.warnings,
      next_tool_payloads: {
        repo_review_patchset: { repo_id: args.repo_id, patchset_id: args.patchset_id }
      }
    });
  }

  async apply(input: PatchsetApplyInput): Promise<PatchsetApplyResult> {
    const args = PatchsetApplyInputSchema.parse(input);
    const { manifest } = await this.readManifest(args.patchset_id);
    if (manifest.repo_id !== args.repo_id) {
      throw new RepoReaderError("VALIDATION_ERROR", "Patchset repo_id does not match request.");
    }
    if (args.expected_head_sha && manifest.base_head_sha && args.expected_head_sha !== manifest.base_head_sha) {
      throw new RepoReaderError("GIT_HEAD_MISMATCH", "Patchset expected_head_sha does not match manifest base_head_sha.", {
        diagnostics: { expected_head_sha: args.expected_head_sha, head_sha: manifest.base_head_sha }
      });
    }
    const rollbackHead = args.expected_head_sha ?? manifest.base_head_sha;
    if (rollbackHead) {
      const status = await new GitService(this.root).status();
      if (status.head_sha !== rollbackHead) {
        throw new RepoReaderError("GIT_HEAD_MISMATCH", "Current HEAD does not match the patchset expected Git HEAD.", {
          diagnostics: { expected_head_sha: rollbackHead, head_sha: status.head_sha }
        });
      }
    }

    for (const file of manifest.files) {
      await this.validateApplyFile(file);
    }

    const dryRun = args.dry_run ?? false;
    if (dryRun) {
      const planned = await Promise.all(manifest.files.map((file) => this.applyFile(file, true)));
      return PatchsetApplyResultSchema.parse({
        ok: true,
        dry_run: true,
        patchset_id: args.patchset_id,
        changed_paths: changedPathsForResults(planned),
        created_paths: planned.filter((file) => file.operation === "create" && file.changed).map((file) => file.path),
        modified_paths: planned.filter((file) => (file.operation === "modify" || file.operation === "edit") && file.changed).map((file) => file.path),
        deleted_paths: planned.filter((file) => file.operation === "delete" && file.changed).map((file) => file.path),
        renamed_paths: planned.filter((file) => file.operation === "rename" && file.changed && file.new_path).map((file) => ({ from: file.path, to: file.new_path! })),
        hunk_diagnostics: hunkDiagnosticsForResults(planned),
        counts: {
          files: manifest.files.length,
          changed: planned.filter((file) => file.changed).length,
          created: planned.filter((file) => file.operation === "create" && file.changed).length,
          modified: planned.filter((file) => (file.operation === "modify" || file.operation === "edit") && file.changed).length,
          deleted: planned.filter((file) => file.operation === "delete" && file.changed).length,
          renamed: planned.filter((file) => file.operation === "rename" && file.changed).length,
          edited: planned.filter((file) => file.operation === "edit" && file.changed).length
        },
        warnings: [],
        next_tool_payloads: {
          repo_review_patchset: { repo_id: args.repo_id, patchset_id: args.patchset_id }
        }
      });
    }

    const snapshots = await captureSnapshots(this.root, patchsetAffectedPaths(manifest.files));
    const results: PatchsetApplyFileResult[] = [];
    try {
      for (const file of manifest.files) {
        results.push(await this.applyFile(file, false));
      }
    } catch (error) {
      await restoreSnapshots(this.root, snapshots);
      throw error;
    }

    const changedResults = results.filter((result) => result.changed);
    const createdPaths = changedResults.filter((result) => result.operation === "create").map((result) => result.path);
    const modifiedPaths = changedResults.filter((result) => result.operation === "modify" || result.operation === "edit").map((result) => result.path);
    const deletedPaths = changedResults.filter((result) => result.operation === "delete").map((result) => result.path);
    const renamedPaths = changedResults
      .filter((result) => result.operation === "rename" && result.new_path)
      .map((result) => ({ from: result.path, to: result.new_path! }));
    const changedPaths = changedPathsForResults(changedResults);
    const hunkDiagnostics = hunkDiagnosticsForResults(results);
    const requestedRollbackHint = rollbackHintForResults(changedResults, Boolean(rollbackHead));
    const pendingRollbackHint = rollbackHintForResults(
      changedResults,
      false,
      "First-class rollback is not advertised until the patchset apply ledger entry is recorded."
    );
    const receipt = await new OperationReceiptService(this.root).writeLastWrite({
      tool: "repo_apply_patchset",
      repo_id: args.repo_id,
      ...(rollbackHead ? { head_sha_before: rollbackHead, head_sha_after: rollbackHead } : {}),
      touched_paths: results.map((result) => result.path),
      changed_paths: changedPaths,
      created_paths: createdPaths,
      modified_paths: modifiedPaths,
      counts: {
        requested: manifest.files.length,
        changed: changedResults.length,
        created: createdPaths.length,
        unchanged: results.length - changedResults.length
      },
      summary: `Applied patchset ${args.patchset_id} across ${changedPaths.length} ${changedPaths.length === 1 ? "file" : "files"}.`,
      patchset_id: args.patchset_id,
      files: results.map((result) => ({
        path: result.path,
        ...(result.new_path ? { new_path: result.new_path } : {}),
        action: result.operation === "modify" || result.operation === "create" ? "write" : result.operation,
        changed: result.changed,
        created: result.operation === "create",
        ...(result.old_sha256 ? { old_sha256: result.old_sha256 } : {}),
        ...(result.new_sha256 ? { new_sha256: result.new_sha256 } : {})
      })),
      rollback_hint: requestedRollbackHint,
      rollback_hint_before_ledger: pendingRollbackHint
    });
    const rollbackRecorded = Boolean(receipt.operation_receipt?.ledger_path);
    const rollbackHint = rollbackHintForResults(
      changedResults,
      Boolean(rollbackHead && rollbackRecorded),
      rollbackHead
        ? "First-class rollback is unavailable because the patchset apply ledger entry could not be recorded; review the patchset and current Git state before recovery."
        : undefined
    );

    return PatchsetApplyResultSchema.parse({
      ok: true,
      dry_run: false,
      patchset_id: args.patchset_id,
      ...(receipt.operation_receipt ? { operation_id: receipt.operation_receipt.operation_id } : {}),
      changed_paths: changedPaths,
      created_paths: createdPaths,
      modified_paths: modifiedPaths,
      deleted_paths: deletedPaths,
      renamed_paths: renamedPaths,
      hunk_diagnostics: hunkDiagnostics,
      counts: {
        files: manifest.files.length,
        changed: changedResults.length,
        created: createdPaths.length,
        modified: modifiedPaths.length,
        deleted: deletedPaths.length,
        renamed: renamedPaths.length,
        edited: changedResults.filter((result) => result.operation === "edit").length
      },
      rollback_hint: rollbackHint,
      ...(receipt.operation_receipt ? { operation_receipt: receipt.operation_receipt } : {}),
      warnings: receipt.warnings,
      next_tool_payloads: {
        repo_review_patchset: { repo_id: args.repo_id, patchset_id: args.patchset_id },
        ...(changedResults.length > 0 && rollbackHead && rollbackRecorded
          ? {
              repo_rollback_patchset: {
                repo_id: args.repo_id,
                patchset_id: args.patchset_id,
                expected_head_sha: rollbackHead
              }
            }
          : {})
      }
    });
  }

  private async validateApplyFile(file: PatchsetManifest["files"][number]): Promise<void> {
    if (file.operation === "create" || file.operation === "modify") {
      await this.writer.write({
        path: file.path,
        action: "write",
        content: file.content,
        create_dirs: file.operation === "create",
        expected_old_sha256: file.expected_old_sha256,
        expected_missing: file.expected_missing,
        dry_run: true
      });
      return;
    }
    if (file.operation === "delete") {
      await this.validateExistingRegularFile(file.path, file.expected_old_sha256);
      await assertTrackedPath(this.root, file.path);
      return;
    }
    if (file.operation === "rename") {
      await this.validateExistingRegularFile(file.path, file.expected_old_sha256);
      await assertTrackedPath(this.root, file.path);
      await this.validateMissingPath(file.new_path);
      return;
    }
    if (file.operation === "edit") {
      await this.validateEditFile(file);
    }
  }

  private async applyFile(file: PatchsetManifest["files"][number], dryRun: boolean): Promise<PatchsetApplyFileResult> {
    if (file.operation === "create" || file.operation === "modify") {
      const result = await this.writer.write({
        path: file.path,
        action: "write",
        content: file.content,
        create_dirs: file.operation === "create",
        expected_old_sha256: file.expected_old_sha256,
        expected_missing: file.expected_missing,
        dry_run: dryRun
      });
      return {
        operation: file.operation,
        path: result.path,
        changed: result.changed,
        old_sha256: result.old_sha256,
        new_sha256: result.new_sha256
      };
    }

    if (file.operation === "edit") {
      const validation = await this.validateEditFile(file);
      const result = await this.writer.writeGroupedEdit({
        path: file.path,
        edits: file.hunks.map((hunk) => ({ type: "replace", find: hunk.find, replace: hunk.replace })),
        expected_old_sha256: file.expected_old_sha256,
        dry_run: dryRun
      });
      return {
        operation: "edit",
        path: result.path,
        changed: result.changed,
        old_sha256: result.old_sha256,
        new_sha256: result.new_sha256,
        hunk_diagnostics: validation
      };
    }

    if (file.operation === "delete") {
      const existing = await this.validateExistingRegularFile(file.path, file.expected_old_sha256);
      if (!dryRun) {
        await unlink(existing.absolutePath);
      }
      return {
        operation: "delete",
        path: file.path,
        changed: true,
        old_sha256: existing.sha256
      };
    }

    if (file.operation === "rename") {
      const existing = await this.validateExistingRegularFile(file.path, file.expected_old_sha256);
      await this.validateMissingPath(file.new_path);
      if (!dryRun) {
        await mkdir(dirname(join(this.root, file.new_path)), { recursive: true });
        await rename(existing.absolutePath, join(this.root, file.new_path));
      }
      return {
        operation: "rename",
        path: file.path,
        new_path: file.new_path,
        changed: true,
        old_sha256: existing.sha256,
        new_sha256: existing.sha256
      };
    }

    throw new RepoReaderError("VALIDATION_ERROR", `Unsupported patchset operation: ${String((file as { operation?: unknown }).operation)}`);
  }

  private async validateEditFile(file: Extract<PatchsetManifest["files"][number], { operation: "edit" }>): Promise<PatchsetHunkDiagnostic[]> {
    const existing = await this.validateExistingRegularFile(file.path, file.expected_old_sha256);
    let currentText: string;
    try {
      currentText = textDecoder.decode(existing.content);
    } catch {
      throw new RepoReaderError("BINARY_FILE_REJECTED", `File is not valid UTF-8: ${file.path}`, {
        diagnostics: { failed_path: file.path }
      });
    }

    const diagnostics: PatchsetHunkDiagnostic[] = [];
    for (let index = 0; index < file.hunks.length; index += 1) {
      const hunk = file.hunks[index]!;
      const occurrences = countOccurrences(currentText, hunk.find);
      if (occurrences !== 1) {
        const status = occurrences === 0 ? "not_found" : "not_unique";
        diagnostics.push({ path: file.path, hunk_index: index, status, occurrences });
        throw new RepoReaderError("PATCHSET_HUNK_VALIDATION_FAILED", `Structured patchset hunk ${index} failed for ${file.path}.`, {
          diagnostics: {
            failed_path: file.path,
            hunk_index: index,
            hunks: diagnostics
          }
        });
      }
      diagnostics.push({ path: file.path, hunk_index: index, status: "matched", occurrences });
      currentText = currentText.replace(hunk.find, hunk.replace);
    }
    return diagnostics;
  }

  private async validateExistingRegularFile(path: string, expectedSha?: string): Promise<{ absolutePath: string; content: Buffer; sha256: string }> {
    const resolved = await this.sandbox.resolve(path);
    if (!resolved.stat.isFile()) {
      throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", "Patchset operation supports regular files only.", {
        diagnostics: { failed_path: path }
      });
    }
    const content = await readFile(resolved.absolutePath);
    const currentSha = sha256Buffer(content);
    if (expectedSha && expectedSha !== currentSha) {
      throw new RepoReaderError("WRITE_STALE_EXPECTED_SHA", `Current file SHA does not match expected_old_sha256: ${path}`, {
        diagnostics: {
          failed_path: path,
          expected_old_sha256: expectedSha,
          current_sha256: currentSha
        }
      });
    }
    return { absolutePath: resolved.absolutePath, content, sha256: currentSha };
  }

  private async validateMissingPath(path: string): Promise<void> {
    try {
      const resolved = await this.sandbox.resolve(path);
      const content = resolved.stat.isFile() ? await readFile(resolved.absolutePath) : undefined;
      throw new RepoReaderError("WRITE_TARGET_EXISTS", `Path already exists: ${path}`, {
        diagnostics: {
          failed_path: path,
          ...(content ? { current_sha256: sha256Buffer(content) } : {})
        }
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        await this.validateDestinationParent(path);
        return;
      }
      throw error;
    }
  }

  private async validateDestinationParent(path: string): Promise<void> {
    const parent = dirname(path);
    if (parent === ".") {
      return;
    }
    try {
      const resolved = await this.sandbox.resolve(parent);
      if (!resolved.stat.isDirectory()) {
        throw new RepoReaderError("WRITE_PARENT_MISSING", `Parent is not a directory: ${parent}`, {
          diagnostics: { failed_path: parent }
        });
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }

  private async planRollback(
    manifest: PatchsetManifest,
    applyEntry: OperationLedgerEntry,
    statusFiles: Array<{ path: string; index: string; worktree: string }>
  ): Promise<{
    restored_paths: string[];
    deleted_paths: string[];
    skipped: Array<{ path: string; reason: string }>;
    before_sha256: Record<string, string>;
    after_sha256: Record<string, string>;
  }> {
    const restored_paths: string[] = [];
    const deleted_paths: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const before_sha256: Record<string, string> = {};
    const after_sha256: Record<string, string> = {};

    for (const file of manifest.files) {
      const appliedFile = applyEntry.files?.find((candidate) => candidate.path === file.path);
      if (!appliedFile?.changed) {
        skipped.push({ path: file.path, reason: "UNCHANGED_BY_APPLY" });
        continue;
      }

      const expectedSha = appliedFile.new_sha256 ?? file.new_sha256;
      if (file.operation === "create") {
        const content = await readExistingFile(this.root, file.path);
        if (!content) {
          skipped.push({ path: file.path, reason: "CREATED_PATH_ALREADY_MISSING" });
          continue;
        }
        const currentSha = sha256Buffer(content);
        before_sha256[file.path] = currentSha;
        if (currentSha !== expectedSha) {
          throw new RepoReaderError("PATCHSET_ROLLBACK_DRIFT", "Patchset-created path changed after apply.", {
            diagnostics: { failed_path: file.path }
          });
        }
        const status = statusFiles.find((candidate) => candidate.path === file.path);
        if (!status || status.index !== "?" || status.worktree !== "?") {
          throw new RepoReaderError("PATCHSET_ROLLBACK_DRIFT", "Patchset-created path is no longer an untracked file.", {
            diagnostics: { failed_path: file.path }
          });
        }
        await assertDeletableCreatedFile(this.sandbox, file.path);
        deleted_paths.push(file.path);
        continue;
      }

      if (file.operation === "delete") {
        const content = await readExistingFile(this.root, file.path);
        if (content) {
          throw new RepoReaderError("PATCHSET_ROLLBACK_DRIFT", "Patchset-deleted path exists before rollback.", {
            diagnostics: { failed_path: file.path }
          });
        }
        restored_paths.push(file.path);
        if (appliedFile.old_sha256) {
          after_sha256[file.path] = appliedFile.old_sha256;
        }
        continue;
      }

      if (file.operation === "rename") {
        const oldContent = await readExistingFile(this.root, file.path);
        if (oldContent) {
          throw new RepoReaderError("PATCHSET_ROLLBACK_DRIFT", "Patchset-renamed source path exists before rollback.", {
            diagnostics: { failed_path: file.path }
          });
        }
        const newContent = await readExistingFile(this.root, file.new_path);
        if (!newContent) {
          throw new RepoReaderError("PATCHSET_ROLLBACK_DRIFT", "Patchset-renamed destination path is missing.", {
            diagnostics: { failed_path: file.new_path }
          });
        }
        const currentSha = sha256Buffer(newContent);
        before_sha256[file.new_path] = currentSha;
        const expectedRenameSha = appliedFile.new_sha256 ?? file.new_sha256;
        if (expectedRenameSha && currentSha !== expectedRenameSha) {
          throw new RepoReaderError("PATCHSET_ROLLBACK_DRIFT", "Patchset-renamed destination changed after apply.", {
            diagnostics: { failed_path: file.new_path }
          });
        }
        const status = statusFiles.find((candidate) => candidate.path === file.new_path);
        if (!status || status.index !== "?" || status.worktree !== "?") {
          throw new RepoReaderError("PATCHSET_ROLLBACK_DRIFT", "Patchset-renamed destination is no longer an untracked file.", {
            diagnostics: { failed_path: file.new_path }
          });
        }
        await assertDeletableCreatedFile(this.sandbox, file.new_path);
        deleted_paths.push(file.new_path);
        restored_paths.push(file.path);
        if (appliedFile.old_sha256) {
          after_sha256[file.path] = appliedFile.old_sha256;
        }
        continue;
      }

      const content = await readExistingFile(this.root, file.path);
      if (!content) {
        throw new RepoReaderError("PATCHSET_ROLLBACK_DRIFT", "Patchset-modified path is missing.", {
          diagnostics: { failed_path: file.path }
        });
      }
      const currentSha = sha256Buffer(content);
      before_sha256[file.path] = currentSha;
      if (currentSha !== expectedSha) {
        throw new RepoReaderError("PATCHSET_ROLLBACK_DRIFT", "Patchset-modified path changed after apply.", {
          diagnostics: { failed_path: file.path }
        });
      }
      restored_paths.push(file.path);
      if (appliedFile.old_sha256) {
        after_sha256[file.path] = appliedFile.old_sha256;
      }
    }

    return { restored_paths, deleted_paths, skipped, before_sha256, after_sha256 };
  }
}

function countOccurrences(text: string, find: string): number {
  let count = 0;
  let index = text.indexOf(find);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(find, index + find.length);
  }
  return count;
}

async function assertTrackedPath(root: string, path: string): Promise<void> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", "--", path], {
      cwd: root,
      maxBuffer: 128 * 1024,
      env: { PATH: process.env.PATH ?? "" }
    });
  } catch {
    throw new RepoReaderError("VALIDATION_ERROR", "Patchset delete and rename operations require a tracked source path.", {
      diagnostics: { failed_path: path }
    });
  }
}
