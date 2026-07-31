import { z } from "zod";
import {
  AgentRunnerEventSchema,
  AgentRunnerMetadataSchema,
  AgentRunnerRunIdSchema,
  AgentRunnerStatusSchema
} from "../delegation/artifact-contracts.js";
import { RepoInputSchema } from "./repo.contract.js";
import { DelegationDriftSummarySchema } from "./delegation-drift.contract.js";

export const AgentRunEffectiveStatusSchema = z.enum([
  "manual",
  "queued",
  "pending",
  "claimed",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "blocked_policy",
  "blocked_verification",
  "timed_out",
  "canceled",
  "committed"
]);

const CursorSchema = z.string().min(1).max(2_048);

export const AgentRunsInputSchema = RepoInputSchema.extend({
  run_id: AgentRunnerRunIdSchema.optional()
    .describe("Optional exact run id. Omit for a newest-first paginated list."),
  statuses: z.array(AgentRunEffectiveStatusSchema).min(1).max(12).optional()
    .describe("List-only effective lifecycle status filters."),
  page_size: z.number().int().min(1).max(50).optional()
    .describe("List-only page size, capped at 50."),
  cursor: CursorSchema.optional()
    .describe("Opaque list cursor returned by a previous call with the same repository and filters."),
  events_after: CursorSchema.optional()
    .describe("Detail-only opaque event cursor returned by a previous call for the same run."),
  max_events: z.number().int().min(1).max(100).optional()
    .describe("Detail-only maximum number of validated events, capped at 100."),
  wait_after_revision: z.number().int().nonnegative().optional()
    .describe("Wait until the selected run is newer or the opaque list-state revision has changed."),
  wait_timeout_ms: z.number().int().min(0).max(30_000).optional()
    .describe("Maximum bounded wait for a newer revision, capped at 30 seconds.")
}).strict().superRefine((value, context) => {
  if (value.run_id) {
    for (const field of ["statuses", "page_size", "cursor"] as const) {
      if (value[field] !== undefined) {
        context.addIssue({ code: "custom", path: [field], message: `${field} is available only when run_id is omitted.` });
      }
    }
    return;
  }
  for (const field of ["events_after", "max_events"] as const) {
    if (value[field] !== undefined) {
      context.addIssue({ code: "custom", path: [field], message: `${field} requires run_id detail mode.` });
    }
  }
  if (value.wait_timeout_ms !== undefined && value.wait_after_revision === undefined) {
    context.addIssue({ code: "custom", path: ["wait_timeout_ms"], message: "wait_timeout_ms requires wait_after_revision." });
  }
});

const ResultPresenceSchema = z.object({
  legacy_result_md: z.boolean().optional(),
  result_json: z.boolean(),
  reviewable: z.boolean()
}).strict();

const AgentRunRuntimeSchema = z.object({
  requested_max_runtime_ms: z.number().int().positive().nullable(),
  effective_max_runtime_ms: z.number().int().positive(),
  active_runtime_ms: z.number().int().nonnegative(),
  remaining_runtime_ms: z.number().int().nonnegative()
}).strict();

const AgentRunnerSupervisorPublicStateSchema = z.object({
  readiness: z.enum(["ready", "starting", "degraded", "stopped", "unknown"]),
  liveness: z.enum(["alive", "stale", "unknown"]),
  status: z.enum(["starting", "ready", "running", "degraded", "stopped"]).optional(),
  revision: z.number().int().nonnegative(),
  heartbeat_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  last_scan_at: z.string().nullable(),
  last_claimed_run_id: AgentRunnerRunIdSchema.nullable(),
  active_run_id: AgentRunnerRunIdSchema.nullable(),
  stale_after_ms: z.number().int().positive().nullable(),
  warnings: z.array(z.string().max(500))
}).strict();

export const AgentRunSummarySchema = z.object({
  run_id: AgentRunnerRunIdSchema,
  revision: z.number().int().nonnegative().optional(),
  title: z.string().max(160).optional(),
  manifest_version: z.number().int().positive(),
  runner: AgentRunnerMetadataSchema,
  effective_status: AgentRunEffectiveStatusSchema,
  prompt_path: z.string(),
  legacy_result_path: z.string().optional(),
  result_json_path: z.string(),
  status_path: z.string(),
  events_path: z.string(),
  runtime: AgentRunRuntimeSchema.optional(),
  result_presence: ResultPresenceSchema,
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  warnings: z.array(z.string())
}).strict();

export const AgentRunDetailSchema = AgentRunSummarySchema.extend({
  status: AgentRunnerStatusSchema.optional(),
  events: z.array(AgentRunnerEventSchema),
  event_page: z.object({
    returned_count: z.number().int().nonnegative(),
    skipped_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    next_cursor: z.string().optional()
  }).strict(),
  interaction: z.object({
    status: z.literal("awaiting_input"),
    turn_index: z.number().int().min(1).max(32),
    questions: z.array(z.object({
      question_id: z.string(),
      prompt: z.string().max(2_000),
      options: z.array(z.string().max(500)).optional()
    }).strict()).min(1).max(3),
    question_sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict().optional()
}).strict();

export const CodexReviewToolPayloadSchema = z.object({
  repo_id: z.string().min(1),
  run_id: AgentRunnerRunIdSchema
}).strict();

export const AgentRunsResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  mode: z.enum(["list", "detail"]),
  runs: z.array(AgentRunSummarySchema).optional(),
  run: AgentRunDetailSchema.optional(),
  drift_summary: DelegationDriftSummarySchema.optional()
    .describe("Repository-wide bounded Delegation v3 drift evidence returned only in list mode; advisory and independent of pagination/status filters."),
  matched_count: z.number().int().nonnegative(),
  returned_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  revision: z.number().int().nonnegative().optional(),
  supervisor: AgentRunnerSupervisorPublicStateSchema.optional(),
  next_cursor: z.string().optional(),
  next_tool_payloads: z.object({
    repo_codex_review: CodexReviewToolPayloadSchema.optional(),
    repo_ship_review: z.object({
      repo_id: z.string().min(1),
      paths: z.array(z.string()).max(100)
    }).strict().optional(),
    repo_write_agent_reply: z.object({
      repo_id: z.string().min(1),
      run_id: AgentRunnerRunIdSchema,
      turn_index: z.number().int().min(1).max(32),
      expected_question_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      question_ids: z.array(z.string()).min(1).max(3)
    }).strict().optional()
  }).strict(),
  warnings: z.array(z.string())
}).strict();

export type AgentRunEffectiveStatus = z.infer<typeof AgentRunEffectiveStatusSchema>;
export type AgentRunsInput = z.infer<typeof AgentRunsInputSchema>;
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;
export type AgentRunDetail = z.infer<typeof AgentRunDetailSchema>;
export type AgentRunsResult = z.infer<typeof AgentRunsResultSchema>;
