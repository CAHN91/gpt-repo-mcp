import { z } from "zod";
import {
  CodexProductReviewSchema,
  CodexReviewAttestedEvidenceSchema,
  CodexReviewStateAvailableSchema,
  CodexRunIdSchema,
  CodexTechnicalReadinessSchema
} from "./codex-task.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

const SafeReviewTextSchema = z.string().min(1).max(2_000).refine(
  (value) => !value.includes("\0"),
  "NUL characters are not allowed."
);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const CodexProductVerdictSchema = z.enum(["passed", "failed", "not_applicable"]);

export const CodexReviewEvidenceSchema = CodexReviewAttestedEvidenceSchema;

export const CodexReviewWriteInputSchema = RepoInputSchema.extend({
  run_id: CodexRunIdSchema,
  expected_review_state_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  product_verdict: CodexProductVerdictSchema,
  rationale: SafeReviewTextSchema,
  evidence: z.array(CodexReviewEvidenceSchema).max(20).default([]),
  dry_run: z.boolean().optional(),
  reason: z.string().min(1).max(500).refine((value) => !value.includes("\0"), "NUL characters are not allowed.").optional()
}).strict().superRefine((value, context) => {
  const ids = value.evidence.map(({ criterion_id }) => criterion_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Product review evidence cannot repeat PAC ids." });
  }
  if (value.product_verdict === "not_applicable" && value.evidence.length > 0) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "not_applicable product review cannot include PAC verdict evidence." });
  }
});

export const CodexReviewAttestationSchema = z.object({
  schema_version: z.literal(1),
  repo_id: z.string().min(1).max(200),
  run_id: CodexRunIdSchema,
  reviewer: z.literal("chatgpt"),
  review_requirement: z.enum(["product_required", "technical_only"]),
  product_verdict: CodexProductVerdictSchema,
  rationale: SafeReviewTextSchema,
  evidence: z.array(CodexReviewEvidenceSchema).max(20),
  reviewed_at: z.string().datetime(),
  binding: CodexReviewStateAvailableSchema,
  technical_readiness: CodexTechnicalReadinessSchema,
  product_review: CodexProductReviewSchema,
  review_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().superRefine((value, context) => {
  if (value.technical_readiness.status !== "passed") {
    context.addIssue({ code: "custom", path: ["technical_readiness", "status"], message: "Durable review attestation requires passed technical readiness." });
  }
  if (value.review_requirement === "product_required") {
    if (value.product_review.requirement !== "required" || value.product_verdict === "not_applicable") {
      context.addIssue({ code: "custom", path: ["product_verdict"], message: "Product-required runs require passed or failed product verdict." });
    }
  } else {
    if (value.product_review.requirement !== "not_applicable" || value.product_verdict !== "not_applicable" || value.evidence.length > 0) {
      context.addIssue({ code: "custom", path: ["product_verdict"], message: "Technical-only runs require not_applicable verdict with no PAC evidence." });
    }
  }
});

export const CodexReviewAttestationV2Schema = z.object({
  schema_version: z.literal(2),
  review_gate_sha256: Sha256Schema,
  repo_id: z.string().min(1).max(200),
  run_id: CodexRunIdSchema,
  reviewer: z.literal("chatgpt"),
  review_requirement: z.enum(["product_required", "technical_only"]),
  product_verdict: CodexProductVerdictSchema,
  rationale: SafeReviewTextSchema,
  evidence: z.array(CodexReviewEvidenceSchema).max(20),
  reviewed_at: z.string().datetime(),
  binding: CodexReviewStateAvailableSchema,
  technical_readiness: CodexTechnicalReadinessSchema,
  product_review: CodexProductReviewSchema,
  review_sha256: Sha256Schema
}).strict().superRefine(assertAttestationSemantics);

export const CodexReviewAttestationAnySchema = z.discriminatedUnion("schema_version", [
  CodexReviewAttestationSchema,
  CodexReviewAttestationV2Schema
]);

export const CodexReviewWriteResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string().min(1).max(200),
  run_id: CodexRunIdSchema,
  review_path: z.string(),
  review_gate_path: z.string(),
  dry_run: z.boolean(),
  written_paths: z.array(z.string()),
  review_requirement: z.enum(["product_required", "technical_only"]),
  product_verdict: CodexProductVerdictSchema,
  technical_readiness_status: z.literal("passed"),
  review_state_sha256: Sha256Schema,
  review_gate_sha256: Sha256Schema,
  review_sha256: Sha256Schema,
  reviewed_at: z.string().datetime(),
  warnings: z.array(z.string()),
  next_steps: z.array(z.string())
}).strict();

export type CodexReviewWriteInput = z.input<typeof CodexReviewWriteInputSchema>;
export type CodexReviewAttestation = z.infer<typeof CodexReviewAttestationSchema>;
export type CodexReviewAttestationV2 = z.infer<typeof CodexReviewAttestationV2Schema>;
export type CodexReviewAttestationAny = z.infer<typeof CodexReviewAttestationAnySchema>;
export type CodexReviewWriteResult = z.infer<typeof CodexReviewWriteResultSchema>;

function assertAttestationSemantics(
  value: {
    technical_readiness: z.infer<typeof CodexTechnicalReadinessSchema>;
    review_requirement: "product_required" | "technical_only";
    product_review: z.infer<typeof CodexProductReviewSchema>;
    product_verdict: z.infer<typeof CodexProductVerdictSchema>;
    evidence: z.infer<typeof CodexReviewEvidenceSchema>[];
  },
  context: z.RefinementCtx
): void {
  if (value.technical_readiness.status !== "passed") {
    context.addIssue({ code: "custom", path: ["technical_readiness", "status"], message: "Durable review attestation requires passed technical readiness." });
  }
  if (value.review_requirement === "product_required") {
    if (value.product_review.requirement !== "required" || value.product_verdict === "not_applicable") {
      context.addIssue({ code: "custom", path: ["product_verdict"], message: "Product-required runs require passed or failed product verdict." });
    }
  } else if (
    value.product_review.requirement !== "not_applicable"
    || value.product_verdict !== "not_applicable"
    || value.evidence.length > 0
  ) {
    context.addIssue({ code: "custom", path: ["product_verdict"], message: "Technical-only runs require not_applicable verdict with no PAC evidence." });
  }
}
