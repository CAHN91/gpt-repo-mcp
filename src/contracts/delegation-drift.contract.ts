import { z } from "zod";
import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";

export const DelegationDriftTrendSchema = z.enum([
  "insufficient_data",
  "stable",
  "increasing",
  "decreasing"
]);

export const DelegationDriftMetricSchema = z.object({
  sample_count: z.number().int().nonnegative(),
  first: z.number().int().nonnegative().optional(),
  latest: z.number().int().nonnegative().optional(),
  minimum: z.number().int().nonnegative().optional(),
  maximum: z.number().int().nonnegative().optional(),
  average: z.number().int().nonnegative().optional(),
  trend: DelegationDriftTrendSchema
}).strict();

export const DelegationCheckpointSchema = z.object({
  status: z.enum(["unavailable", "no_history", "current", "due"]),
  governance_mode: z.enum(["unavailable", "advisory", "enforce"]),
  threshold_root_runs: z.number().int().min(1).max(100).optional(),
  root_runs_since_last_product_checkpoint: z.number().int().nonnegative(),
  latest_product_checkpoint_run_id: AgentRunnerRunIdSchema.optional(),
  latest_product_checkpoint_at: z.string().datetime().optional()
}).strict();

export const DelegationDriftRepeatedAreaSchema = z.object({
  area: z.string().min(1).max(200),
  run_count: z.number().int().positive()
}).strict();

export const DelegationDriftSummarySchema = z.object({
  status: z.enum(["no_history", "observed"]),
  observed_v3_run_count: z.number().int().nonnegative(),
  root_run_count: z.number().int().nonnegative(),
  product_root_run_count: z.number().int().nonnegative(),
  technical_root_run_count: z.number().int().nonnegative(),
  child_run_count: z.number().int().nonnegative(),
  corrective_child_count: z.number().int().nonnegative(),
  scope_amendment_child_count: z.number().int().nonnegative(),
  scope_extension_run_count: z.number().int().nonnegative(),
  failed_product_review_count: z.number().int().nonnegative(),
  maximum_corrective_children_per_root: z.number().int().nonnegative(),
  prompt_bytes: DelegationDriftMetricSchema,
  starting_point_count: DelegationDriftMetricSchema,
  authorization_pattern_count: DelegationDriftMetricSchema,
  repeated_areas: z.array(DelegationDriftRepeatedAreaSchema).max(10),
  checkpoint: DelegationCheckpointSchema,
  signals: z.array(z.string().min(1).max(160)).max(20),
  warnings: z.array(z.string().min(1).max(500)).max(50)
}).strict();

export type DelegationCheckpoint = z.infer<typeof DelegationCheckpointSchema>;
export type DelegationDriftSummary = z.infer<typeof DelegationDriftSummarySchema>;
