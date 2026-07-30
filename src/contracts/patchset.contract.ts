import { z } from "zod";
import { GitReviewResultSchema } from "./git-review.contract.js";
import { OperationReceiptRefSchema, OperationReceiptRollbackHintSchema } from "./operation-receipt.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/).describe("Lowercase SHA-256 hex digest.");
const GitHeadShaSchema = z.string().regex(/^[a-f0-9]{40}$/).describe("Lowercase 40-character git commit SHA.");
const PatchsetIdSchema = z.string().regex(/^patchset-[A-Za-z0-9._-]+$/).describe("Stable repo-local patchset id.");

export const PatchsetFileOperationSchema = z.enum(["create", "modify", "delete", "rename", "edit"]).describe("Supported structured patchset file operation.");

const PatchsetWriteFileInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative POSIX target path for this patchset file."),
  operation: z.enum(["create", "modify"]),
  content: z.string().describe("Complete UTF-8 file content to write for create or full-file modify."),
  expected_old_sha256: Sha256Schema.optional().describe("Optional stale-state guard requiring existing file SHA-256 to match before apply."),
  expected_missing: z.boolean().optional().describe("Optional stale-state guard requiring the target path to be missing before apply.")
});

const PatchsetDeleteFileInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative POSIX target path to delete."),
  operation: z.literal("delete"),
  expected_old_sha256: Sha256Schema.optional().describe("Optional stale-state guard requiring existing file SHA-256 to match before apply.")
});

const PatchsetRenameFileInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative POSIX source path to rename."),
  operation: z.literal("rename"),
  new_path: z.string().min(1).describe("Repo-relative POSIX destination path for the rename."),
  expected_old_sha256: Sha256Schema.optional().describe("Optional stale-state guard requiring source file SHA-256 to match before apply.")
});

const PatchsetEditHunkInputSchema = z.object({
  find: z.string().min(1).describe("Exact text hunk anchor. The text must appear exactly once at this hunk's turn."),
  replace: z.string().describe("Replacement text for this hunk.")
});

const PatchsetEditFileInputSchema = z.object({
  path: z.string().min(1).describe("Repo-relative POSIX target path to edit with structured hunks."),
  operation: z.literal("edit"),
  hunks: z.array(PatchsetEditHunkInputSchema).min(1).max(25).describe("Ordered exact-match replacement hunks to apply in memory before writing once."),
  expected_old_sha256: Sha256Schema.optional().describe("Optional stale-state guard requiring existing file SHA-256 to match before apply.")
});

export const PatchsetFileInputSchema = z.discriminatedUnion("operation", [
  PatchsetWriteFileInputSchema,
  PatchsetDeleteFileInputSchema,
  PatchsetRenameFileInputSchema,
  PatchsetEditFileInputSchema
]).describe("One structured patchset file operation.");

export const PatchsetManifestFileSchema = PatchsetFileInputSchema.and(z.object({
  old_sha256: Sha256Schema.optional().describe("SHA-256 of the original file content when captured during prepare."),
  new_sha256: Sha256Schema.describe("SHA-256 of the proposed resulting file content.")
    .optional()
    .describe("SHA-256 of the proposed resulting file content for write, edit, and rename operations."),
  hunk_count: z.number().int().nonnegative().optional().describe("Number of structured hunks for edit operations.")
})).describe("Normalized patchset manifest file entry.");

export const PatchsetManifestSchema = z.object({
  patchset_schema_version: z.literal(1).describe("Patchset manifest schema version."),
  patchset_id: PatchsetIdSchema,
  repo_id: z.string().describe("Repository id this patchset belongs to."),
  created_at: z.string().datetime().describe("UTC timestamp when the patchset manifest was prepared."),
  intent: z.string().min(1).describe("Short content-free intent for the patchset."),
  base_head_sha: GitHeadShaSchema.optional().describe("Git HEAD SHA the patchset was prepared from when available."),
  work_session_id: z.string().optional().describe("Optional future work-session id linked to this patchset."),
  files: z.array(PatchsetManifestFileSchema).min(1).max(25).describe("Normalized create, full-file modify, delete, rename, and edit entries."),
  counts: z.object({
    files: z.number().int().nonnegative().describe("Number of files in the patchset."),
    creates: z.number().int().nonnegative().describe("Number of create operations."),
    modifies: z.number().int().nonnegative().describe("Number of full-file modify operations."),
    deletes: z.number().int().nonnegative().describe("Number of delete operations."),
    renames: z.number().int().nonnegative().describe("Number of rename operations."),
    edits: z.number().int().nonnegative().describe("Number of structured edit operations.")
  }).describe("Patchset operation counts.")
});

export const PatchsetPrepareInputSchema = RepoInputSchema.extend({
  intent: z.string().min(1).describe("Short content-free intent for the patchset."),
  base_head_sha: GitHeadShaSchema.optional().describe("Optional Git HEAD SHA the patchset was prepared from."),
  work_session_id: z.string().optional().describe("Optional future work-session id linked to this patchset."),
  files: z.array(PatchsetFileInputSchema).min(1).max(25).describe("Create/full-file modify/delete/rename/edit entries to normalize into a patchset manifest.")
});

export const PatchsetHunkDiagnosticSchema = z.object({
  path: z.string().describe("Repo-relative path containing the hunk."),
  hunk_index: z.number().int().nonnegative().describe("Zero-based hunk index within the file entry."),
  status: z.enum(["matched", "not_found", "not_unique"]).describe("Validation status for this hunk."),
  occurrences: z.number().int().nonnegative().describe("Number of exact anchor occurrences found at this hunk's turn.")
});

export const PatchsetPrepareResultSchema = z.object({
  ok: z.literal(true).describe("True when the patchset manifest was prepared."),
  patchset_id: PatchsetIdSchema,
  manifest_path: z.string().describe("Repo-relative path to the local patchset manifest."),
  manifest: PatchsetManifestSchema.describe("Normalized patchset manifest."),
  affected_paths: z.array(z.string()).describe("Repo-relative paths affected by this patchset."),
  warnings: z.array(z.string()).describe("Non-fatal warnings from patchset preparation."),
  next_tool_payloads: z.object({
    repo_apply_patchset: z.object({
      repo_id: z.string(),
      patchset_id: PatchsetIdSchema,
      expected_head_sha: GitHeadShaSchema.optional()
    }).optional().describe("Suggested apply payload for this patchset.")
  }).describe("Suggested next tool payloads.")
});

export const PatchsetApplyInputSchema = RepoInputSchema.extend({
  patchset_id: PatchsetIdSchema,
  expected_head_sha: GitHeadShaSchema.optional().describe("Optional stale-state guard requiring Git HEAD to match before applying."),
  dry_run: z.boolean().optional().describe("Validate the patchset without writing target files.")
});

export const PatchsetApplyResultSchema = z.object({
  ok: z.literal(true).describe("True when patchset apply validation or mutation completed."),
  dry_run: z.boolean().describe("Whether the apply request only validated the patchset."),
  patchset_id: PatchsetIdSchema,
  operation_id: z.string().optional().describe("Operation id recorded for an actual changed apply."),
  changed_paths: z.array(z.string()).describe("Repo-relative paths changed by the patchset."),
  created_paths: z.array(z.string()).describe("Repo-relative paths created by the patchset."),
  modified_paths: z.array(z.string()).describe("Repo-relative existing paths modified by the patchset."),
  deleted_paths: z.array(z.string()).describe("Repo-relative paths deleted by the patchset."),
  renamed_paths: z.array(z.object({
    from: z.string().describe("Repo-relative source path renamed by the patchset."),
    to: z.string().describe("Repo-relative destination path renamed by the patchset.")
  })).describe("Repo-relative rename operations applied by the patchset."),
  hunk_diagnostics: z.array(PatchsetHunkDiagnosticSchema).describe("Per-hunk validation evidence for structured edit operations."),
  counts: z.object({
    files: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    renamed: z.number().int().nonnegative(),
    edited: z.number().int().nonnegative()
  }).describe("Patchset apply counts."),
  rollback_hint: OperationReceiptRollbackHintSchema.optional().describe("Content-free patchset rollback availability and per-path recovery evidence."),
  operation_receipt: OperationReceiptRefSchema.optional().describe("Local operation receipt metadata when actual changed apply saved a receipt."),
  warnings: z.array(z.string()).describe("Non-fatal warnings from patchset apply."),
  next_tool_payloads: z.object({
    repo_review_patchset: z.object({
      repo_id: z.string(),
      patchset_id: PatchsetIdSchema
    }).optional().describe("Suggested review payload for this patchset."),
    repo_rollback_patchset: z.object({
      repo_id: z.string(),
      patchset_id: PatchsetIdSchema,
      expected_head_sha: GitHeadShaSchema
    }).optional().describe("First-class rollback payload for an actual HEAD-bound apply.")
  }).describe("Suggested next tool payloads.")
});

export const PatchsetReviewInputSchema = RepoInputSchema.extend({
  patchset_id: PatchsetIdSchema,
  max_files: z.number().int().positive().optional().describe("Maximum diff summary files to include.")
});

export const PatchsetRollbackInputSchema = RepoInputSchema.extend({
  patchset_id: PatchsetIdSchema,
  expected_head_sha: GitHeadShaSchema.describe("Current Git HEAD SHA expected before rollback."),
  dry_run: z.boolean().optional().describe("Validate rollback without changing the git index, worktree, or filesystem.")
});

const PatchsetRollbackSkippedSchema = z.object({
  path: z.string().describe("Repo-relative patchset path that did not need rollback."),
  reason: z.string().describe("Stable reason explaining why this path was skipped.")
});

export const PatchsetRollbackResultSchema = z.object({
  ok: z.literal(true).describe("True when patchset rollback validation or mutation completed."),
  dry_run: z.boolean().describe("Whether the request only validated rollback without mutating files."),
  patchset_id: PatchsetIdSchema,
  operation_id: z.string().optional().describe("Operation id recorded for an actual changed rollback."),
  restored_paths: z.array(z.string()).describe("Repo-relative tracked modified paths restored from Git."),
  deleted_paths: z.array(z.string()).describe("Repo-relative untracked patchset-created files deleted."),
  skipped: z.array(PatchsetRollbackSkippedSchema).describe("Patchset paths that did not require mutation."),
  counts: z.object({
    restored: z.number().int().nonnegative().describe("Number of tracked paths restored."),
    deleted: z.number().int().nonnegative().describe("Number of created paths deleted."),
    skipped: z.number().int().nonnegative().describe("Number of patchset paths skipped.")
  }).describe("Patchset rollback counts."),
  operation_receipt: OperationReceiptRefSchema.optional().describe("Local operation receipt metadata when actual rollback saved a receipt."),
  warnings: z.array(z.string()).describe("Non-fatal warnings from patchset rollback."),
  next_tool_payloads: z.object({
    repo_review_patchset: z.object({
      repo_id: z.string(),
      patchset_id: PatchsetIdSchema
    }).optional().describe("Suggested review payload after rollback.")
  }).describe("Suggested next tool payloads.")
});

export const PatchsetReviewResultSchema = z.object({
  ok: z.literal(true).describe("True when patchset review completed."),
  patchset_id: PatchsetIdSchema,
  manifest_path: z.string().describe("Repo-relative path to the local patchset manifest."),
  manifest: PatchsetManifestSchema.describe("Normalized patchset manifest."),
  applied: z.boolean().describe("Whether this patchset has an apply ledger event."),
  rolled_back: z.boolean().describe("Whether this patchset has a later rollback ledger event."),
  git_review: GitReviewResultSchema.optional().describe("Current read-only git review summary after patchset apply."),
  warnings: z.array(z.string()).describe("Non-fatal warnings from patchset review.")
});

export type PatchsetFileInput = z.infer<typeof PatchsetFileInputSchema>;
export type PatchsetHunkDiagnostic = z.infer<typeof PatchsetHunkDiagnosticSchema>;
export type PatchsetManifest = z.infer<typeof PatchsetManifestSchema>;
export type PatchsetPrepareInput = z.infer<typeof PatchsetPrepareInputSchema>;
export type PatchsetPrepareResult = z.infer<typeof PatchsetPrepareResultSchema>;
export type PatchsetApplyInput = z.infer<typeof PatchsetApplyInputSchema>;
export type PatchsetApplyResult = z.infer<typeof PatchsetApplyResultSchema>;
export type PatchsetReviewInput = z.infer<typeof PatchsetReviewInputSchema>;
export type PatchsetReviewResult = z.infer<typeof PatchsetReviewResultSchema>;
export type PatchsetRollbackInput = z.infer<typeof PatchsetRollbackInputSchema>;
export type PatchsetRollbackResult = z.infer<typeof PatchsetRollbackResultSchema>;
