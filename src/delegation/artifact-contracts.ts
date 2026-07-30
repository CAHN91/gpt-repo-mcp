import { z } from "zod";

export const AGENT_RUNNER_RUNS_DIR = ".chatgpt/codex-runs";
export const DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS = 900_000;

export const AgentRunnerRunIdSchema = z.string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z-[a-z0-9][a-z0-9-]{0,79}$/);

export const AgentRunnerNameSchema = z.enum([
  "opencode_sdk",
  "opencode_server",
  "codex_sdk",
  "codex_app_server"
]);

export const AgentRunnerMetadataSchema = z.object({
  mode: z.enum(["manual", "queued"]).default("manual"),
  requested_runner: AgentRunnerNameSchema.optional(),
  auto_start: z.boolean().optional(),
  max_runtime_ms: z.number().int().positive().optional(),
  validation_profile: z.string().min(1).optional(),
  commit_after_green: z.boolean().optional()
}).strict();

const AgentRunnerLifecycleStatusSchema = z.enum([
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

const AgentRunnerValidationStateSchema = z.object({
  status: z.enum(["missing", "skipped", "passed", "failed"]),
  profile: z.string().min(1).nullable().default(null),
  artifact_path: z.string().min(1).nullable().default(null)
}).strict();

const AgentRunnerCommitStateSchema = z.object({
  attempted: z.boolean(),
  allowed: z.boolean(),
  status: z.enum(["skipped", "committed", "failed"]),
  commit_sha: z.string().nullable().default(null)
}).strict();

const CodexReviewPayloadSchema = z.object({
  repo_id: z.string().min(1),
  run_id: AgentRunnerRunIdSchema
}).strict();

const LegacyShipReviewPayloadSchema = z.object({
  repo_id: z.string().min(1),
  paths: z.array(z.string()).max(100)
}).strict();

export const LegacyAgentRunnerStatusV1Schema = z.object({
  schema_version: z.literal(1).default(1),
  repo_id: z.string().min(1),
  run_id: AgentRunnerRunIdSchema,
  runner: AgentRunnerNameSchema,
  status: AgentRunnerLifecycleStatusSchema,
  revision: z.number().int().nonnegative().default(0),
  started_at: z.string().max(64).datetime().nullable().default(null),
  updated_at: z.string().max(64).datetime(),
  completed_at: z.string().max(64).datetime().nullable().default(null),
  prompt_path: z.string().min(1),
  result_path: z.string().min(1),
  result_found: z.boolean(),
  head_before: z.string().nullable().default(null),
  head_after: z.string().nullable().default(null),
  worktree_fingerprint_before: z.string().nullable().default(null),
  worktree_fingerprint_after: z.string().nullable().default(null),
  changed_paths: z.array(z.string()).default([]),
  validation: AgentRunnerValidationStateSchema,
  commit: AgentRunnerCommitStateSchema,
  review: z.object({
    repo_codex_review: CodexReviewPayloadSchema,
    repo_ship_review: LegacyShipReviewPayloadSchema,
    instructions: z.array(z.string().min(1).max(500)).max(4)
  }).strict().optional(),
  warnings: z.array(z.string()).default([])
}).strict();

export const AgentRunnerStatusSchema = z.object({
  schema_version: z.literal(2).default(2),
  manifest_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  review_requirement: z.enum(["product_required", "technical_only", "legacy_unavailable"]),
  repo_id: z.string().min(1),
  run_id: AgentRunnerRunIdSchema,
  runner: AgentRunnerNameSchema,
  status: AgentRunnerLifecycleStatusSchema,
  revision: z.number().int().nonnegative().default(0),
  started_at: z.string().max(64).datetime().nullable().default(null),
  updated_at: z.string().max(64).datetime(),
  completed_at: z.string().max(64).datetime().nullable().default(null),
  prompt_path: z.string().min(1),
  legacy_result_path: z.string().min(1).optional(),
  result_json_path: z.string().min(1),
  result_found: z.boolean(),
  head_before: z.string().nullable().default(null),
  head_after: z.string().nullable().default(null),
  worktree_fingerprint_before: z.string().nullable().default(null),
  worktree_fingerprint_after: z.string().nullable().default(null),
  changed_paths: z.array(z.string()).default([]),
  validation: AgentRunnerValidationStateSchema,
  commit: AgentRunnerCommitStateSchema,
  review: z.object({
    repo_codex_review: CodexReviewPayloadSchema,
    legacy_repo_ship_review: LegacyShipReviewPayloadSchema.optional(),
    instructions: z.array(z.string().min(1).max(500)).max(4)
  }).strict().optional(),
  warnings: z.array(z.string()).default([])
}).strict().superRefine((value, context) => {
  if (value.manifest_version === 3) {
    if (value.legacy_result_path !== undefined) {
      context.addIssue({ code: "custom", path: ["legacy_result_path"], message: "Delegation v3 runner status cannot expose a legacy markdown result path." });
    }
    if (value.review_requirement === "legacy_unavailable") {
      context.addIssue({ code: "custom", path: ["review_requirement"], message: "Delegation v3 runner status requires an explicit product or technical review requirement." });
    }
  } else if (value.review_requirement !== "legacy_unavailable") {
    context.addIssue({ code: "custom", path: ["review_requirement"], message: "Historical runner status cannot claim a Delegation v3 review requirement." });
  }
});

export const AgentRunnerSupervisorStateSchema = z.object({
  schema_version: z.literal(1).default(1),
  repo_id: z.string().min(1).max(200),
  runner: AgentRunnerNameSchema,
  status: z.enum(["starting", "ready", "running", "degraded", "stopped"]),
  revision: z.number().int().nonnegative().default(0),
  heartbeat_at: z.string().max(64).datetime(),
  updated_at: z.string().max(64).datetime(),
  last_scan_at: z.string().max(64).datetime().nullable().default(null),
  last_claimed_run_id: AgentRunnerRunIdSchema.nullable().default(null),
  active_run_id: AgentRunnerRunIdSchema.nullable().default(null),
  stale_after_ms: z.number().int().positive(),
  warnings: z.array(z.string().min(1).max(500)).max(20).default([])
}).strict();

export const AgentRunnerEventTypeSchema = z.enum([
  "queued",
  "claimed",
  "started",
  "thread_started",
  "thread_resumed",
  "input_requested",
  "input_received",
  "heartbeat",
  "adapter_event",
  "result_detected",
  "validation_started",
  "validation_completed",
  "policy_blocked",
  "commit_started",
  "commit_completed",
  "completed",
  "failed",
  "timed_out",
  "canceled"
]);

const BoundedIsoTimestampSchema = z.string().max(64).datetime();
const BoundedInteractionTextSchema = z.string().min(1).max(2_000).refine(
  (value) => !value.includes("\0"),
  "NUL characters are not allowed."
);

export const AgentQuestionIdSchema = z.string().regex(/^q-[a-z0-9][a-z0-9-]{0,63}$/);

export const AgentTurnQuestionSchema = z.object({
  question_id: AgentQuestionIdSchema,
  prompt: BoundedInteractionTextSchema,
  options: z.array(z.string().min(1).max(500)).max(8).optional()
}).strict();

export const AgentTurnAnswerSchema = z.object({
  question_id: AgentQuestionIdSchema,
  answer: BoundedInteractionTextSchema
}).strict();

export const AgentTurnOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("completed"), summary: z.string().min(1).max(2_000) }).strict(),
  z.object({ outcome: z.literal("blocked"), summary: z.string().min(1).max(2_000) }).strict(),
  z.object({
    outcome: z.literal("needs_input"),
    summary: z.string().min(1).max(2_000).optional(),
    questions: z.array(AgentTurnQuestionSchema).min(1).max(3)
  }).strict()
]).superRefine((value, context) => {
  if (value.outcome !== "needs_input") return;
  const ids = value.questions.map(({ question_id }) => question_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["questions"], message: "Each question_id must be unique within a turn." });
  }
});

export const AgentRunnerSessionSchema = z.object({
  schema_version: z.literal(1),
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  provider: AgentRunnerNameSchema,
  thread_id: z.string().min(1).max(1_024).refine((value) => !/[\0\r\n]/.test(value)),
  turn_index: z.number().int().min(0).max(32),
  max_runtime_ms: z.number().int().positive().optional(),
  active_runtime_ms: z.number().int().nonnegative().default(0),
  last_consumed_reply_turn_index: z.number().int().min(1).max(32).nullable(),
  created_at: BoundedIsoTimestampSchema,
  updated_at: BoundedIsoTimestampSchema
}).strict();

export const AgentRunnerAttemptSchema = z.object({
  schema_version: z.literal(1),
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  provider: AgentRunnerNameSchema,
  operation: z.enum(["start", "resume"]),
  turn_index: z.number().int().min(0).max(32),
  state: z.enum(["in_flight", "settled"]),
  started_at: BoundedIsoTimestampSchema,
  updated_at: BoundedIsoTimestampSchema
}).strict();

export const AgentInteractionQuestionSchema = z.object({
  schema_version: z.literal(1),
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  turn_index: z.number().int().min(1).max(32),
  questions: z.array(AgentTurnQuestionSchema).min(1).max(3),
  created_at: BoundedIsoTimestampSchema
}).strict();

export const AgentInteractionReplySchema = z.object({
  schema_version: z.literal(1),
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  turn_index: z.number().int().min(1).max(32),
  question_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  answers: z.array(AgentTurnAnswerSchema).min(1).max(3),
  created_at: BoundedIsoTimestampSchema
}).strict();

export const AgentRunnerEventSchema = z.object({
  schema_version: z.literal(1).default(1),
  repo_id: z.string().min(1),
  run_id: AgentRunnerRunIdSchema,
  event_type: AgentRunnerEventTypeSchema,
  timestamp: z.string().max(64).datetime(),
  summary: z.string().max(2000).optional()
}).strict();

export const AgentRunnerLockSchema = z.object({
  schema_version: z.literal(1).default(1),
  repo_id: z.string().min(1).max(128),
  run_id: AgentRunnerRunIdSchema,
  owner_id: z.string().min(1).max(128),
  lease_token: z.string().uuid(),
  pid: z.number().int().positive().nullable().default(null),
  hostname: z.string().min(1).max(255).nullable().default(null),
  acquired_at: z.string().max(64).datetime(),
  updated_at: z.string().max(64).datetime()
}).strict();

export type AgentRunnerName = z.infer<typeof AgentRunnerNameSchema>;
export type AgentRunnerMetadata = z.infer<typeof AgentRunnerMetadataSchema>;
export type LegacyAgentRunnerStatusV1 = z.infer<typeof LegacyAgentRunnerStatusV1Schema>;
export type AgentRunnerStatus = z.infer<typeof AgentRunnerStatusSchema>;
export type AgentRunnerSupervisorState = z.infer<typeof AgentRunnerSupervisorStateSchema>;
export type AgentRunnerStatusInput = z.input<typeof AgentRunnerStatusSchema>;
export type AgentRunnerEvent = z.infer<typeof AgentRunnerEventSchema>;
export type AgentRunnerEventInput = z.input<typeof AgentRunnerEventSchema>;
export type AgentRunnerEventType = z.infer<typeof AgentRunnerEventTypeSchema>;
export type AgentRunnerLock = z.infer<typeof AgentRunnerLockSchema>;
export type AgentTurnOutcome = z.infer<typeof AgentTurnOutcomeSchema>;
export type AgentTurnQuestion = z.infer<typeof AgentTurnQuestionSchema>;
export type AgentTurnAnswer = z.infer<typeof AgentTurnAnswerSchema>;
export type AgentRunnerSession = z.infer<typeof AgentRunnerSessionSchema>;
export type AgentRunnerAttempt = z.infer<typeof AgentRunnerAttemptSchema>;
export type AgentInteractionQuestion = z.infer<typeof AgentInteractionQuestionSchema>;
export type AgentInteractionReply = z.infer<typeof AgentInteractionReplySchema>;
