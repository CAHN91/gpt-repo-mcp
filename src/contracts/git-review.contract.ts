import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";
import { DelegationGateDecisionSchema } from "./delegation-gate.contract.js";

export const ReviewDetailSchema = z.enum(["compact", "full"]);

export const GitReviewInputSchema = RepoInputSchema.extend({
  mode: z.enum(["review", "commit_plan"]).optional().describe("Optional review mode. Use review for normal change review and commit_plan when preparing exact stage and commit payloads."),
  detail: ReviewDetailSchema.optional().describe("Response detail. Compact is the default and returns canonical actual composite payloads; full also returns granular and dry-run payloads."),
  paths: z.array(z.string().min(1)).optional().describe("Optional exact repo-relative changed paths to scope review recommendations and generated payloads to the current task."),
  max_files: z.number().int().positive().optional().describe("Maximum number of diff summary files to include before marking the summary truncated.")
});

const ChangedPathSchema = z.object({
  path: z.string(),
  original_path: z.string().optional(),
  index: z.string(),
  worktree: z.string(),
  status: z.enum(["modified", "added", "deleted", "renamed", "untracked", "unknown"]),
  staged: z.boolean(),
  unstaged: z.boolean()
});

const DiffSummarySchema = z.object({
  file_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  files: z.array(z.object({
    path: z.string(),
    status: z.string().optional(),
    hunk_count: z.number().int().nonnegative(),
    summary: z.string()
  }))
});

const StagePayloadSchema = z.object({
  repo_id: z.string(),
  paths: z.array(z.string()),
  expected_head_sha: z.string(),
  dry_run: z.boolean()
});

const CleanupPayloadSchema = z.object({
  repo_id: z.string(),
  paths: z.array(z.string()),
  dry_run: z.boolean()
});

const RecoverPayloadSchema = z.object({
  repo_id: z.string(),
  expected_head_sha: z.string(),
  unstage_paths: z.array(z.string()).optional(),
  restore_paths: z.array(z.string()).optional(),
  cleanup_paths: z.array(z.string()).optional(),
  discard_paths: z.array(z.string()).optional(),
  dry_run: z.boolean()
});

const StageCommitPayloadSchema = z.object({
  repo_id: z.string(),
  paths: z.array(z.string()),
  message: z.string(),
  expected_head_sha: z.string(),
  dry_run: z.boolean()
});

const CommitPayloadSchema = z.object({
  repo_id: z.string(),
  message: z.string(),
  expected_head_sha: z.string(),
  expected_staged_paths: z.array(z.string()),
  dry_run: z.boolean()
});

export const GitReviewNextToolPayloadsSchema = z.object({
  repo_write_stage_commit: StageCommitPayloadSchema.extend({ dry_run: z.literal(false) }).optional(),
  repo_write_commit: CommitPayloadSchema.extend({ dry_run: z.literal(false) }).optional(),
  repo_write_recover: RecoverPayloadSchema.extend({ dry_run: z.literal(false) }).optional(),
  repo_git_restore_paths_dry_run: StagePayloadSchema.extend({ dry_run: z.literal(true) }).optional(),
  repo_git_restore_paths_actual: StagePayloadSchema.extend({ dry_run: z.literal(false) }).optional(),
  repo_cleanup_paths_dry_run: CleanupPayloadSchema.extend({ dry_run: z.literal(true) }).optional(),
  repo_cleanup_paths_actual: CleanupPayloadSchema.extend({ dry_run: z.literal(false) }).optional(),
  repo_write_unstage_dry_run: StagePayloadSchema.extend({ dry_run: z.literal(true) }).optional(),
  repo_write_unstage_actual: StagePayloadSchema.extend({ dry_run: z.literal(false) }).optional(),
  repo_write_stage_dry_run: StagePayloadSchema.extend({ dry_run: z.literal(true) }).optional(),
  repo_write_stage_actual: StagePayloadSchema.extend({ dry_run: z.literal(false) }).optional(),
  repo_write_stage_commit_dry_run: StageCommitPayloadSchema.extend({ dry_run: z.literal(true) }).optional(),
  repo_write_stage_commit_actual: StageCommitPayloadSchema.extend({ dry_run: z.literal(false) }).optional(),
  repo_write_recover_dry_run: RecoverPayloadSchema.extend({ dry_run: z.literal(true) }).optional(),
  repo_write_recover_actual: RecoverPayloadSchema.extend({ dry_run: z.literal(false) }).optional(),
  repo_write_commit_dry_run: CommitPayloadSchema.extend({ dry_run: z.literal(true) }).optional()
});

export const GitReviewResultSchema = z.object({
  ok: z.literal(true),
  detail: ReviewDetailSchema,
  branch: z.string(),
  head_sha: z.string(),
  clean: z.boolean(),
  changed_paths: z.array(ChangedPathSchema),
  diff_summary: DiffSummarySchema,
  recommendation: z.object({
    ready_to_stage: z.boolean(),
    recommended_stage_paths: z.array(z.string()),
    excluded_paths: z.array(z.object({ path: z.string(), reason: z.string() })),
    suggested_commit_message: z.string(),
    risk_level: z.enum(["low", "medium", "high"]),
    warnings: z.array(z.string()),
    recovery_guidance: z.array(z.string()).optional()
  }),
  delegation_gate: DelegationGateDecisionSchema,
  ship_readiness: z.object({
    validation: z.object({
      status: z.enum(["missing", "passed", "failed", "stale"]),
      validation_id: z.string().optional(),
      validation_status: z.enum(["passed", "failed", "skipped"]).optional(),
      profile: z.string().optional(),
      focused: z.boolean().optional(),
      test_paths: z.array(z.string()).optional(),
      head_sha: z.string().optional(),
      worktree_fingerprint: z.string().optional(),
      artifact_path: z.string().optional()
    })
  }),
  next_tool_payloads: GitReviewNextToolPayloadsSchema
});

export type ReviewDetail = z.infer<typeof ReviewDetailSchema>;
export type GitReviewInput = z.infer<typeof GitReviewInputSchema>;
export type GitReviewResult = z.infer<typeof GitReviewResultSchema>;
