import { z } from "zod";
import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";
import { RepoInputSchema } from "./repo.contract.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const HeadSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const IntegrationReviewIdSchema = z.string().regex(/^integration-[A-Za-z0-9-]{1,160}$/);

export const IntegrationReviewWriteInputSchema = RepoInputSchema.extend({
  run_ids: z.array(AgentRunnerRunIdSchema).min(2).max(20),
  validation_id: z.string().regex(/^validation-[A-Za-z0-9-]{1,160}$/),
  expected_head_sha: HeadSchema,
  commit_message: z.string().min(1).max(500),
  dry_run: z.boolean().optional(),
  reason: z.string().min(1).max(500).optional()
}).strict().superRefine((value, context) => {
  if (new Set(value.run_ids).size !== value.run_ids.length) {
    context.addIssue({ code: "custom", path: ["run_ids"], message: "Integration review run ids must be unique." });
  }
});

const IntegrationRunBindingSchema = z.object({
  run_id: AgentRunnerRunIdSchema,
  review_sha256: Sha256Schema,
  product_verdict: z.enum(["passed", "not_applicable"]),
  paths: z.array(z.string().min(1)).min(1).max(2_000)
}).strict();

export const IntegrationReviewArtifactSchema = z.object({
  schema_version: z.literal(1),
  integration_id: IntegrationReviewIdSchema,
  repo_id: z.string().min(1).max(200),
  head_sha: HeadSchema,
  run_bindings: z.array(IntegrationRunBindingSchema).min(2).max(20),
  reviewed_paths: z.array(z.string().min(1)).min(1).max(2_000),
  pathset_fingerprint: Sha256Schema,
  validation: z.object({
    validation_id: z.string().min(1),
    profile: z.literal("all"),
    artifact_sha256: Sha256Schema
  }).strict(),
  semantic_review: z.object({ status: z.literal("ready"), blocking_finding_ids: z.array(z.string()).max(100) }).strict(),
  commit_message: z.string().min(1).max(500),
  created_at: z.string().datetime(),
  artifact_sha256: Sha256Schema
}).strict();

export const IntegrationReviewWriteResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string().min(1),
  integration_id: IntegrationReviewIdSchema,
  integration_path: z.string(),
  review_pathset_id: IntegrationReviewIdSchema,
  dry_run: z.boolean(),
  written_paths: z.array(z.string()),
  head_sha: HeadSchema,
  run_ids: z.array(AgentRunnerRunIdSchema),
  reviewed_paths: z.array(z.string()),
  path_count: z.number().int().positive(),
  pathset_fingerprint: Sha256Schema,
  validation_id: z.string(),
  warnings: z.array(z.string()),
  next_tool_payloads: z.object({
    repo_write_stage_commit: z.object({
      repo_id: z.string(),
      review_pathset_id: IntegrationReviewIdSchema,
      message: z.string(),
      expected_head_sha: HeadSchema,
      dry_run: z.boolean()
    }).strict()
  }).strict()
}).strict();

export type IntegrationReviewWriteInput = z.input<typeof IntegrationReviewWriteInputSchema>;
export type IntegrationReviewArtifact = z.infer<typeof IntegrationReviewArtifactSchema>;
export type IntegrationReviewWriteResult = z.infer<typeof IntegrationReviewWriteResultSchema>;
