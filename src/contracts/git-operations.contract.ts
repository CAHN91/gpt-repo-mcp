import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

const ExpectedHeadSchema = z.string().regex(/^[a-f0-9]{40}$/).describe("Current 40-character HEAD SHA expected by the caller. The operation is rejected if HEAD changed since review.");
const GitPathsSchema = z.array(z.string().min(1)).min(1).describe("Explicit repo-relative POSIX paths to operate on. Broad pathspecs, absolute paths, traversal, shell-like paths, Git internals, and hard-risk secret paths are rejected.");

export const GitStageInputSchema = RepoInputSchema.extend({
  paths: GitPathsSchema,
  expected_head_sha: ExpectedHeadSchema,
  dry_run: z.boolean().optional().describe("Preview which explicit paths would be staged without changing the git index."),
  reason: z.string().min(1).optional().describe("Short human-readable reason for the staging request, useful for audit context.")
});

export const GitUnstageInputSchema = RepoInputSchema.extend({
  paths: GitPathsSchema,
  expected_head_sha: ExpectedHeadSchema,
  dry_run: z.boolean().optional().describe("Preview which explicit paths would be unstaged without changing the git index."),
  reason: z.string().min(1).optional().describe("Short human-readable reason for the unstaging request, useful for audit context.")
});

export const GitRestorePathsInputSchema = RepoInputSchema.extend({
  paths: GitPathsSchema,
  expected_head_sha: ExpectedHeadSchema,
  dry_run: z.boolean().optional().describe("Preview which explicit worktree paths would be restored without changing files or the git index."),
  reason: z.string().min(1).optional().describe("Short human-readable reason for the restore request, useful for audit context.")
});

export const GitCommitInputSchema = RepoInputSchema.extend({
  message: z.string().min(1).describe("Local git commit message only. Shell syntax, command chaining, and git flags are not accepted."),
  expected_head_sha: ExpectedHeadSchema,
  expected_staged_paths: GitPathsSchema.describe("Exact repo-relative staged path list expected by the caller. Commit is rejected unless the actual staged paths match exactly."),
  dry_run: z.boolean().optional().describe("Preview the local commit operation without creating a commit or changing HEAD."),
  reason: z.string().min(1).optional().describe("Short human-readable reason for the commit request, useful for audit context.")
});

export const GitStageCommitInputSchema = RepoInputSchema.extend({
  paths: GitPathsSchema.optional().describe("Explicit repo-relative paths for the normal review flow. Omit when review_pathset_id is supplied."),
  review_pathset_id: z.string().regex(/^integration-[A-Za-z0-9-]{1,160}$/).optional().describe("Opaque server-owned integration pathset created by repo_write_integration_review."),
  message: z.string().min(1).describe("Local git commit message only. Shell syntax, command chaining, and git flags are not accepted."),
  expected_head_sha: ExpectedHeadSchema,
  dry_run: z.boolean().optional().describe("Validate stage-and-commit inputs without changing the git index, worktree, or HEAD."),
  reason: z.string().min(1).optional().describe("Short human-readable reason for the reviewed stage-and-commit request, useful for audit context.")
}).strict().superRefine((value, context) => {
  if (Boolean(value.paths) === Boolean(value.review_pathset_id)) {
    context.addIssue({ code: "custom", path: ["paths"], message: "Provide exactly one of paths or review_pathset_id." });
  }
});

const OptionalGitPathsSchema = z.array(z.string().min(1)).optional();

export const GitRecoverInputSchema = RepoInputSchema.extend({
  expected_head_sha: ExpectedHeadSchema,
  unstage_paths: OptionalGitPathsSchema.describe("Explicit repo-relative paths to unstage from the git index before restore or cleanup."),
  restore_paths: OptionalGitPathsSchema.describe("Explicit repo-relative tracked worktree paths to restore with git restore -- <paths>."),
  cleanup_paths: OptionalGitPathsSchema.describe("Explicit repo-relative generated artifact paths to delete through cleanup policy."),
  discard_paths: OptionalGitPathsSchema.describe("Explicit repo-relative safe untracked files to delete after review."),
  dry_run: z.boolean().optional().describe("Validate the reviewed recovery workflow without changing the git index, worktree, or filesystem."),
  reason: z.string().min(1).optional().describe("Short human-readable reason for the reviewed recovery request, useful for audit context.")
});

const GitOperationSkippedSchema = z.object({
  path: z.string().describe("Repo-relative path that was not operated on."),
  reason: z.string().describe("Stable reason explaining why the path was skipped.")
});

const GitOperationDeletedSchema = z.object({
  path: z.string().describe("Repo-relative generated artifact path deleted, or previewed during dry-run."),
  type: z.enum(["file", "directory"]).describe("Kind of filesystem entry deleted, or previewed during dry-run.")
});

export const GitStageResultSchema = z.object({
  ok: z.literal(true).describe("True when staging completed or dry-run validation succeeded."),
  dry_run: z.boolean().describe("Whether the request was validation-only and did not change the git index."),
  head_sha: z.string().describe("HEAD SHA that was verified before staging."),
  staged_paths: z.array(z.string()).describe("Explicit repo-relative paths staged or that would be staged during dry-run."),
  skipped: z.array(GitOperationSkippedSchema).describe("Explicit paths that were not staged and the reason for each skip."),
  warnings: z.array(z.string()).describe("Non-fatal warnings produced by the staging service.")
});

export const GitUnstageResultSchema = z.object({
  ok: z.literal(true).describe("True when unstaging completed or dry-run validation succeeded."),
  dry_run: z.boolean().describe("Whether the request was validation-only and did not change the git index."),
  head_sha: z.string().describe("HEAD SHA that was verified before unstaging."),
  unstaged_paths: z.array(z.string()).describe("Explicit repo-relative paths unstaged or that would be unstaged during dry-run."),
  skipped: z.array(GitOperationSkippedSchema).describe("Explicit paths that were not unstaged and the reason for each skip."),
  warnings: z.array(z.string()).describe("Non-fatal warnings produced by the unstaging service.")
});

export const GitRestorePathsResultSchema = z.object({
  ok: z.literal(true).describe("True when restore completed or dry-run validation succeeded."),
  dry_run: z.boolean().describe("Whether the request was validation-only and did not change worktree files."),
  head_sha: z.string().describe("HEAD SHA that was verified before restoring worktree paths."),
  restored_paths: z.array(z.string()).describe("Explicit repo-relative worktree paths restored or that would be restored during dry-run."),
  skipped: z.array(GitOperationSkippedSchema).describe("Explicit paths that were not restored and the reason for each skip."),
  warnings: z.array(z.string()).describe("Non-fatal warnings produced by the restore service.")
});

export const GitCommitResultSchema = z.object({
  ok: z.literal(true).describe("True when commit completed or dry-run validation succeeded."),
  dry_run: z.boolean().describe("Whether the request was validation-only and did not create a commit."),
  head_before: z.string().describe("HEAD SHA verified before the commit operation."),
  head_after: z.string().optional().describe("New HEAD SHA after a successful local commit."),
  commit_sha: z.string().optional().describe("SHA of the local commit that was created."),
  committed_paths: z.array(z.string()).describe("Exact repo-relative staged paths committed or that would be committed during dry-run."),
  warnings: z.array(z.string()).describe("Non-fatal warnings produced by the commit service.")
});

export const GitStageCommitResultSchema = z.object({
  ok: z.literal(true).describe("True when the reviewed stage-and-commit workflow completed or dry-run validation succeeded."),
  dry_run: z.boolean().describe("Whether the request was validation-only and did not change the git index or create a commit."),
  head_before: z.string().describe("HEAD SHA verified before staging and commit."),
  head_after: z.string().optional().describe("New HEAD SHA after a successful local commit."),
  commit_sha: z.string().optional().describe("SHA of the local commit that was created."),
  review_pathset_id: z.string().optional().describe("Opaque reviewed integration pathset used for this operation, when applicable."),
  staged_paths: z.array(z.string()).describe("Explicit repo-relative paths staged or that would be staged."),
  committed_paths: z.array(z.string()).describe("Exact repo-relative paths committed or that would be committed."),
  remaining_changes: z.number().int().nonnegative().optional().describe("Best-effort count of remaining changed paths after commit."),
  clean_after: z.boolean().optional().describe("Best-effort indication of whether the repository was clean after commit."),
  warnings: z.array(z.string()).describe("Non-fatal warnings produced by the stage-and-commit workflow.")
});

export const GitRecoverResultSchema = z.object({
  ok: z.literal(true).describe("True when the reviewed recovery workflow completed or dry-run validation succeeded."),
  dry_run: z.boolean().describe("Whether the request was validation-only and did not mutate the index, worktree, or filesystem."),
  head_sha: z.string().describe("HEAD SHA verified before recovery."),
  unstaged_paths: z.array(z.string()).describe("Explicit repo-relative paths unstaged, or that would be unstaged during dry-run."),
  restored_paths: z.array(z.string()).describe("Explicit repo-relative tracked paths restored, or that would be restored during dry-run."),
  deleted: z.array(GitOperationDeletedSchema).describe("Explicit generated artifact paths deleted, or previewed during dry-run."),
  discarded: z.array(GitOperationDeletedSchema).describe("Explicit safe untracked files discarded, or previewed during dry-run."),
  skipped: z.array(GitOperationSkippedSchema).describe("Explicit paths that were not recovered and the reason for each skip."),
  remaining_changes: z.number().int().nonnegative().optional().describe("Best-effort count of remaining changed paths after recovery."),
  clean_after: z.boolean().optional().describe("Best-effort indication of whether the repository was clean after recovery."),
  warnings: z.array(z.string()).describe("Non-fatal warnings produced by the recovery workflow.")
});

export type GitStageInput = z.infer<typeof GitStageInputSchema>;
export type GitUnstageInput = z.infer<typeof GitUnstageInputSchema>;
export type GitRestorePathsInput = z.infer<typeof GitRestorePathsInputSchema>;
export type GitCommitInput = z.infer<typeof GitCommitInputSchema>;
export type GitStageCommitInput = z.infer<typeof GitStageCommitInputSchema>;
export type GitRecoverInput = z.infer<typeof GitRecoverInputSchema>;
export type GitStageResult = z.infer<typeof GitStageResultSchema>;
export type GitUnstageResult = z.infer<typeof GitUnstageResultSchema>;
export type GitRestorePathsResult = z.infer<typeof GitRestorePathsResultSchema>;
export type GitCommitResult = z.infer<typeof GitCommitResultSchema>;
export type GitStageCommitResult = z.infer<typeof GitStageCommitResultSchema>;
export type GitRecoverResult = z.infer<typeof GitRecoverResultSchema>;
