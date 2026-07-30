import { z } from "zod";
import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";
import { DelegationGateDecisionSchema } from "./delegation-gate.contract.js";
import { FailureDiagnoseResultSchema } from "./failure-diagnose.contract.js";
import { GitReviewResultSchema, ReviewDetailSchema } from "./git-review.contract.js";
import { SemanticReviewInputSchema, SemanticReviewResultSchema } from "./semantic-review.contract.js";

export const ShipReviewInputSchema = SemanticReviewInputSchema;

export const ShipReviewToolInputSchema = SemanticReviewInputSchema.extend({
  run_id: AgentRunnerRunIdSchema.optional().describe("Optional Delegation v3 run identity. When supplied, the applicable gate set must include this run."),
  detail: ReviewDetailSchema.optional().describe("Response detail. Compact is the default; full retains duplicated gate guidance and granular Git payloads for expert diagnosis.")
}).strict();

export const ShipReviewReasonSchema = z.enum([
  "SEMANTIC_REVIEW_REQUIRED",
  "VALIDATION_FAILED",
  "VALIDATION_MISSING",
  "VALIDATION_STALE",
  "VALIDATION_FOCUSED",
  "GIT_REVIEW_HIGH_RISK",
  "GIT_CANONICAL_SHIP_PAYLOAD_UNAVAILABLE",
  "DELEGATION_REVIEW_GATE_BLOCKED",
  "DELEGATION_REVIEW_GATE_MISSING",
  "DELEGATION_REVIEW_GATE_INVALID",
  "DELEGATION_REVIEW_ATTESTATION_MISSING",
  "DELEGATION_REVIEW_GATE_BINDING_MISSING",
  "DELEGATION_REVIEW_STATE_CHANGED",
  "DELEGATION_PRODUCT_REVIEW_FAILED",
  "DELEGATION_TECHNICAL_REVIEW_INVALID",
  "DELEGATION_GATE_DISCOVERY_TRUNCATED",
  "DELEGATION_GATE_RUN_MISMATCH"
]);

const ActualStageCommitSchema = z.object({
  repo_id: z.string(),
  paths: z.array(z.string()),
  message: z.string(),
  expected_head_sha: z.string(),
  dry_run: z.literal(false)
});

const ActualCommitSchema = z.object({
  repo_id: z.string(),
  message: z.string(),
  expected_head_sha: z.string(),
  expected_staged_paths: z.array(z.string()),
  dry_run: z.literal(false)
});

export const ShipReviewResultSchema = z.object({
  ok: z.literal(true),
  detail: ReviewDetailSchema,
  repo_id: z.string(),
  run_id: AgentRunnerRunIdSchema.optional(),
  git_review: GitReviewResultSchema,
  delegation_gate: DelegationGateDecisionSchema.optional(),
  semantic_review: SemanticReviewResultSchema,
  failure_diagnosis: FailureDiagnoseResultSchema.optional(),
  ship_readiness: z.object({
    status: z.enum(["ready", "review_required"]),
    reasons: z.array(ShipReviewReasonSchema),
    validation_status: z.enum(["missing", "passed", "failed", "stale"]),
    blocking_finding_ids: z.array(z.string()),
    diagnosis_included: z.boolean()
  }),
  next_tool_payloads: z.object({
    repo_validate: z.object({ repo_id: z.string(), profile: z.literal("all") }).optional(),
    repo_write_stage_commit: ActualStageCommitSchema.optional(),
    repo_write_commit: ActualCommitSchema.optional(),
    repo_write_commit_dry_run: ActualCommitSchema.omit({ dry_run: true }).extend({ dry_run: z.literal(true) }).optional()
  }),
  review_loop: z.object({
    max_corrective_children: z.literal(2),
    scope_policy: z.literal("preserve_or_narrow"),
    instructions: z.array(z.string().min(1).max(500)).max(4)
  }).optional(),
  truncated: z.boolean(),
  warnings: z.array(z.string())
});

export type ShipReviewInput = z.infer<typeof ShipReviewInputSchema>;
export type ShipReviewToolInput = z.infer<typeof ShipReviewToolInputSchema>;
export type ShipReviewResult = z.infer<typeof ShipReviewResultSchema>;
export type ShipReviewReason = z.infer<typeof ShipReviewReasonSchema>;
