import { z } from "zod";
import {
  DelegationRepoPathV3Schema,
  DelegationRepoPatternV3Schema,
  DelegationReviewRequirementV3Schema
} from "./delegation-v3.contract.js";
import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const HeadShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const DelegationReviewGateSchema = z.object({
  schema_version: z.literal(1),
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  manifest_path: DelegationRepoPathV3Schema,
  review_path: DelegationRepoPathV3Schema,
  manifest_sha256: Sha256Schema,
  prompt_sha256: Sha256Schema,
  baseline_sha256: Sha256Schema,
  baseline_head_sha: HeadShaSchema,
  initial_changed_paths: z.array(DelegationRepoPathV3Schema).max(10_000),
  authorization_scope: z.array(DelegationRepoPatternV3Schema).min(1).max(50),
  review_requirement: DelegationReviewRequirementV3Schema,
  governance_mode: z.enum(["advisory", "enforce"]),
  created_at: z.string().datetime(),
  gate_sha256: Sha256Schema
}).strict().superRefine((value, context) => {
  if (new Set(value.initial_changed_paths).size !== value.initial_changed_paths.length) {
    context.addIssue({ code: "custom", path: ["initial_changed_paths"], message: "Gate baseline paths must be unique." });
  }
  if (new Set(value.authorization_scope).size !== value.authorization_scope.length) {
    context.addIssue({ code: "custom", path: ["authorization_scope"], message: "Gate authorization patterns must be unique." });
  }
});

export const DelegationGateRunDecisionSchema = z.object({
  run_id: AgentRunnerRunIdSchema,
  governance_mode: z.enum(["advisory", "enforce"]),
  applicable_paths: z.array(DelegationRepoPathV3Schema).min(1).max(1_000),
  status: z.enum(["passed", "open", "failed", "stale", "tampered", "missing_gate", "invalid_gate"]),
  review_status: z.enum(["valid", "missing", "stale", "tampered", "unavailable"]),
  product_verdict: z.enum(["passed", "failed", "not_applicable"]).optional(),
  reasons: z.array(z.string().min(1).max(160)).max(20)
}).strict();

export const DelegationGateDecisionSchema = z.object({
  status: z.enum(["not_applicable", "passed", "advisory", "blocked"]),
  requested_paths: z.array(DelegationRepoPathV3Schema).max(1_000),
  applicable_runs: z.array(DelegationGateRunDecisionSchema).max(1_000),
  blocking_reasons: z.array(z.string().min(1).max(160)).max(100),
  warnings: z.array(z.string().min(1).max(160)).max(100),
  truncated: z.boolean()
}).strict();

export type DelegationReviewGate = z.infer<typeof DelegationReviewGateSchema>;
export type DelegationGateRunDecision = z.infer<typeof DelegationGateRunDecisionSchema>;
export type DelegationGateDecision = z.infer<typeof DelegationGateDecisionSchema>;
