import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const OperationReceiptRefSchema = z.object({
  operation_id: z.string().describe("Stable identifier for the saved local write receipt."),
  path: z.literal(".chatgpt/operations/last-write.json").describe("Repo-relative receipt file path."),
  ledger_path: z.literal(".chatgpt/operations/ledger.jsonl").optional().describe("Repo-relative append-only operation ledger path when ledger append succeeded.")
});

const ReceiptCountsSchema = z.object({
  requested: z.number().int().nonnegative().describe("Number of requested write changes in the operation."),
  changed: z.number().int().nonnegative().describe("Number of requested writes that changed file content."),
  created: z.number().int().nonnegative().describe("Number of paths created by the write operation."),
  unchanged: z.number().int().nonnegative().describe("Number of requested writes that were no-ops.")
});

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/).describe("Lowercase SHA-256 hex digest.");
const GitHeadShaSchema = z.string().regex(/^[a-f0-9]{40}$/).describe("Lowercase 40-character git commit SHA.");
const RepoRelativePathSchema = z.string().refine(isRepoRelativePathLiteral, {
  message: "Expected a safe repo-relative POSIX path."
});

export const OperationReceiptFileSchema = z.object({
  path: RepoRelativePathSchema.describe("Repo-relative path touched by the operation."),
  new_path: RepoRelativePathSchema.optional().describe("Repo-relative destination path for rename operations."),
  action: z.enum(["write", "replace", "append", "prepend", "insert_before", "insert_after", "edit", "delete", "rename"]).optional().describe("Write action used for this file when known."),
  changed: z.boolean().describe("Whether this file changed content."),
  created: z.boolean().describe("Whether this file was created by the operation."),
  old_sha256: Sha256Schema.optional().describe("SHA-256 before the operation when available."),
  new_sha256: Sha256Schema.optional().describe("SHA-256 after the operation when available.")
});

export const OperationReceiptRollbackPathHintSchema = z.object({
  path: RepoRelativePathSchema.describe("Repo-relative path the hint applies to."),
  strategy: z.enum(["restore_tracked", "cleanup_created", "manual_review"]).describe("Content-free recovery strategy hint for this path."),
  reason: z.string().describe("Short safe explanation for the path-level hint.")
});

export const OperationReceiptRollbackHintSchema = z.object({
  executable: z.boolean().describe("Whether the initiating tool returned a complete first-class rollback payload for this operation."),
  reason: z.string().describe("Short safe explanation of rollback status."),
  paths: z.array(OperationReceiptRollbackPathHintSchema).describe("Per-path content-free rollback hints.")
});

export const OperationReceiptSchema = z.object({
  schema_version: z.literal(1).describe("Receipt schema version."),
  operation_id: z.string().describe("Stable identifier for this local write operation receipt."),
  tool: z.enum(["repo_write_file", "repo_write_changes", "repo_apply_patchset", "repo_rollback_patchset"]).describe("Write tool that produced the receipt."),
  repo_id: z.string().describe("Repository id used by the write tool."),
  timestamp: z.string().datetime().describe("UTC timestamp when the receipt was written."),
  head_sha_before: GitHeadShaSchema.optional().describe("Best-effort git HEAD SHA observed before the write."),
  head_sha_after: GitHeadShaSchema.optional().describe("Best-effort git HEAD SHA observed after the write."),
  touched_paths: z.array(z.string()).describe("Repo-relative paths touched by the write operation."),
  changed_paths: z.array(z.string()).describe("Repo-relative paths whose content changed."),
  created_paths: z.array(z.string()).describe("Repo-relative paths created by the write operation."),
  modified_paths: z.array(z.string()).describe("Repo-relative existing paths modified by the write operation."),
  counts: ReceiptCountsSchema.describe("Safe aggregate write operation counts."),
  summary: z.string().describe("Safe content-free summary of the write operation."),
  files: z.array(OperationReceiptFileSchema).optional().describe("Content-free per-file metadata for the operation."),
  rollback_hint: OperationReceiptRollbackHintSchema.optional().describe("Content-free rollback hints for the operation."),
  patchset_id: z.string().optional().describe("Future patchset id linked to this operation when available."),
  work_session_id: z.string().optional().describe("Future work-session id linked to this operation when available."),
  commit_sha: GitHeadShaSchema.optional().describe("Future commit SHA linked to this operation when available."),
  committed_at: z.string().datetime().optional().describe("Future commit timestamp linked to this operation when available."),
  validation_ids: z.array(z.string()).optional().describe("Future validation result ids linked to this operation.")
});

export const OperationLedgerEntrySchema = OperationReceiptSchema.extend({
  ledger_schema_version: z.literal(1).describe("Ledger entry schema version."),
  ledger_entry_id: z.string().describe("Stable identifier for this append-only ledger entry."),
  event_type: z.enum(["write_applied", "patchset_rolled_back"]).describe("Append-only ledger event type."),
  patchset_id: z.string().optional().describe("Future patchset id linked to this event when available."),
  work_session_id: z.string().optional().describe("Future work-session id linked to this event when available."),
  commit_sha: GitHeadShaSchema.optional().describe("Future commit SHA linked to this event when available."),
  committed_at: z.string().datetime().optional().describe("Future commit timestamp linked to this event when available."),
  validation_ids: z.array(z.string()).default([]).describe("Future validation result ids linked to this event."),
  ledger_path: z.literal(".chatgpt/operations/ledger.jsonl").describe("Repo-relative ledger path.")
});

export const LastWriteInputSchema = RepoInputSchema;

export const LastWriteResultSchema = z.object({
  ok: z.literal(true).describe("True when the read-only last-write lookup completed."),
  found: z.boolean().describe("Whether a valid last-write receipt was found."),
  receipt: OperationReceiptSchema.optional().describe("Latest safe write receipt when present."),
  next_tool_payloads: z.object({
    repo_git_review: RepoInputSchema.optional().describe("Suggested read-only review payload for the receipt repository.")
  }).describe("Read-only next tool payloads derived from the receipt."),
  warnings: z.array(z.string()).describe("Stable non-fatal warnings from last-write lookup.")
});

export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;
export type OperationLedgerEntry = z.infer<typeof OperationLedgerEntrySchema>;
export type OperationReceiptRef = z.infer<typeof OperationReceiptRefSchema>;
export type LastWriteInput = z.infer<typeof LastWriteInputSchema>;
export type LastWriteResult = z.infer<typeof LastWriteResultSchema>;

function isRepoRelativePathLiteral(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
