import { z } from "zod";
import { AgentRunnerNameSchema } from "../delegation/artifact-contracts.js";
import {
  DelegationScopeExtensionV3Schema,
  DelegationTaskV3ToolInputSchema
} from "./delegation-v3.contract.js";
import { GitReviewResultSchema } from "./git-review.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

const MAX_TASK_TEXT = 8_000;
const MAX_SHORT_TEXT = 500;
const MAX_PATH_PATTERN = 512;
const MAX_LIST_ITEMS = 1_000;

const BoundedTextSchema = z.string().min(1).max(MAX_TASK_TEXT).refine(
  (value) => !value.includes("\0"),
  "NUL characters are not allowed."
);
const ShortTextSchema = z.string().min(1).max(MAX_SHORT_TEXT).refine(
  (value) => !value.includes("\0"),
  "NUL characters are not allowed."
);

export const CodexRepoPatternSchema = z.string().min(1).max(MAX_PATH_PATTERN).superRefine((value, context) => {
  if (/[\0\r\n]/.test(value)) {
    context.addIssue({ code: "custom", message: "Repo-relative paths and globs cannot contain NUL or newlines." });
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "Repo-relative POSIX paths and globs are required." });
  }
  if (value === "." || value.startsWith("./") || value.split("/").includes("..")) {
    context.addIssue({ code: "custom", message: "Path traversal and dot-relative patterns are not allowed." });
  }
});

export const CodexRepoPathSchema = CodexRepoPatternSchema.refine(
  (value) => !value.includes("*"),
  "A concrete repo-relative path is required; wildcard asterisks are not allowed."
);

const RepoPathListSchema = z.array(CodexRepoPatternSchema).max(MAX_LIST_ITEMS).default([]);
const BoundedTextListSchema = z.array(ShortTextSchema).max(MAX_LIST_ITEMS).default([]);
export const CodexRunIdSchema = z.string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z-[a-z0-9][a-z0-9-]{0,79}$/)
  .describe("Stable repo-local Codex run id. Generated when omitted.");

const AcceptanceCriterionInputSchema = z.union([
  ShortTextSchema,
  z.object({
    id: z.string().regex(/^AC-[1-9][0-9]*$/).optional(),
    criterion: ShortTextSchema
  }).strict()
]);

export const CodexValidationRequestSchema = z.object({
  profile: z.enum(["test", "build", "lint", "typecheck", "smoke", "all"]),
  test_paths: z.array(CodexRepoPathSchema).max(100).default([])
}).strict().superRefine((value, context) => {
  if (value.test_paths.length > 0 && value.profile !== "test") {
    context.addIssue({ code: "custom", path: ["test_paths"], message: "test_paths require validation profile test." });
  }
});

export const CodexTaskRunnerSchema = z.object({
  mode: z.enum(["manual", "queued"]),
  requested_runner: AgentRunnerNameSchema.optional(),
  max_runtime_ms: z.number().int().positive().optional()
}).strict().superRefine((value, context) => {
  if (value.mode === "queued" && value.requested_runner === undefined) {
    context.addIssue({ code: "custom", path: ["requested_runner"], message: "queued mode requires an allowlisted requested_runner." });
  }
  if (value.mode === "manual" && value.requested_runner !== undefined) {
    context.addIssue({ code: "custom", path: ["requested_runner"], message: "manual mode cannot request or imply a queued runner." });
  }
  if (value.mode === "manual" && value.max_runtime_ms !== undefined) {
    context.addIssue({ code: "custom", path: ["max_runtime_ms"], message: "manual mode cannot request runner runtime." });
  }
});

export const CodexTaskInputSchema = RepoInputSchema.extend({
  title: z.string().min(1).max(160).refine((value) => !/[\0\r\n]/.test(value), "Title must be a single safe line.")
    .describe("Short human-readable task title used in the prompt and generated run id."),
  objective: BoundedTextSchema.describe("Concrete implementation objective for Codex."),
  context_summary: BoundedTextSchema.optional().describe("Short context summary ChatGPT wants Codex to know before editing."),
  inspect_first: RepoPathListSchema.describe("Safe repo-relative files or globs Codex should inspect before editing."),
  allowed_paths: RepoPathListSchema.describe("Safe repo-relative files or globs Codex may edit."),
  forbidden_paths: RepoPathListSchema.describe("Additional safe repo-relative files or globs Codex must not edit. Defaults are always retained."),
  implementation_scope: z.object({
    include: BoundedTextListSchema,
    exclude: BoundedTextListSchema
  }).strict().optional().describe("Explicit bounded implementation boundaries."),
  acceptance_criteria: z.array(AcceptanceCriterionInputSchema).max(MAX_LIST_ITEMS).default([])
    .describe("Criteria Codex should satisfy. Strings receive stable AC-N ids; explicit {id, criterion} values are also accepted."),
  validation: CodexValidationRequestSchema.optional()
    .describe("Safe structured verification request. Only allowlisted repo validation profiles and separate test paths are accepted."),
  runner: CodexTaskRunnerSchema.default({ mode: "manual" })
    .describe("Durable handoff mode only. queued requires an allowlisted runner name; max_runtime_ms may only lower the repository hard limit; this tool never starts a runner."),
  parent_run_id: CodexRunIdSchema.optional()
    .describe("Optional completed Codex run to use as the bounded parent of a corrective child; at most two children are allowed."),
  verification_commands: z.array(z.string().min(1).max(1_000).refine((value) => !value.includes("\0"), "NUL characters are not allowed."))
    .max(20).default([])
    .describe("Legacy bounded compatibility only. MCP never executes these command strings; prefer validation."),
  run_id: CodexRunIdSchema.optional()
});

export const CodexTaskWriteInputSchema = CodexTaskInputSchema.extend({
  dry_run: z.boolean().optional().describe("For repo_write_codex_task only: render and validate without writing files."),
  include_prompt: z.boolean().optional().describe("Include prompt_markdown in write output. Defaults to false for compact responses."),
  reason: z.string().min(1).max(500).refine((value) => !value.includes("\0"), "NUL characters are not allowed.").optional()
    .describe("Short audit reason for writing the task locally.")
});

export const CodexTaskResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  run_id: CodexRunIdSchema,
  prompt_path: z.string(),
  result_path: z.string(),
  result_json_path: z.string(),
  manifest_path: z.string(),
  prompt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_byte_count: z.number().int().nonnegative(),
  prompt_markdown: z.string(),
  codex_user_prompt: z.string(),
  next_steps: z.array(z.string()),
  warnings: z.array(z.string())
});

export const CodexTaskWriteResultSchema = CodexTaskResultSchema.omit({ prompt_markdown: true }).extend({
  prompt_markdown: z.string().optional(),
  dry_run: z.boolean(),
  written_paths: z.array(z.string()),
  next_tool_payloads: z.object({
    repo_agent_runs: z.object({
      repo_id: z.string().min(1),
      run_id: CodexRunIdSchema
    }).strict()
  }).strict().optional()
});

export const CodexReviewInputSchema = RepoInputSchema.extend({
  run_id: CodexRunIdSchema.describe("Codex run id under .chatgpt/codex-runs."),
  max_files: z.number().int().positive().optional().describe("Maximum git diff files to summarize.")
});

export const CodexResultAcceptanceSchema = z.object({
  id: z.string().regex(/^(?:AC|PAC|TAC)-[1-9][0-9]*$/),
  status: z.enum(["passed", "failed", "unverified"]),
  evidence: z.string().max(2_000).default("")
}).strict();

export const CodexStructuredResultSchema = z.object({
  schema_version: z.literal(2),
  repo_id: z.string().min(1).max(200),
  run_id: CodexRunIdSchema,
  status: z.enum(["completed", "blocked"]),
  summary: ShortTextSchema,
  changed_files: z.array(CodexRepoPathSchema).max(MAX_LIST_ITEMS),
  commands_run: z.array(ShortTextSchema).max(MAX_LIST_ITEMS),
  tests: z.array(ShortTextSchema).max(MAX_LIST_ITEMS),
  acceptance_criteria: z.array(CodexResultAcceptanceSchema).max(MAX_LIST_ITEMS),
  blockers: z.array(ShortTextSchema).max(MAX_LIST_ITEMS),
  followups: z.array(ShortTextSchema).max(MAX_LIST_ITEMS)
}).strict();

export const CodexParsedResultSchema = z.object({
  status: z.enum(["completed", "blocked", "unknown"]),
  summary: z.string(),
  changed_files: z.array(z.string()),
  commands_run: z.array(z.string()),
  tests: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  acceptance_results: z.array(CodexResultAcceptanceSchema).optional(),
  product_acceptance_results: z.array(CodexResultAcceptanceSchema).optional(),
  technical_acceptance_results: z.array(CodexResultAcceptanceSchema).optional(),
  connected_changes: z.array(z.object({ path: z.string(), reason: z.string() }).strict()).optional(),
  scope_extension_required: z.array(z.object({
    path_or_area: z.string(),
    reason: z.string(),
    required_outcome: z.string()
  }).strict()).optional(),
  blockers: z.array(z.string()),
  followups: z.array(z.string()),
  source: z.enum(["RESULT.json", "RESULT.md"]),
  raw_text: z.string()
});

export const CodexReviewIntegritySchema = z.object({
  manifest_version: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  manifest_found: z.boolean(),
  manifest_bound: z.boolean(),
  policy_matches: z.boolean().optional(),
  head_matches_baseline: z.boolean().optional(),
  prompt_found: z.boolean(),
  prompt_hash_matches: z.boolean().optional(),
  prompt_byte_count_matches: z.boolean().optional(),
  prompt_content_matches: z.boolean().optional(),
  baseline_matches: z.boolean().optional()
,
  task_binding_matches: z.boolean().optional(),
  product_binding_matches: z.boolean().optional(),
  authorization_matches: z.boolean().optional()
});

export const CodexAcceptanceEvidenceSchema = z.object({
  binding_available: z.boolean(),
  expected_ids: z.array(z.string()),
  reported_ids: z.array(z.string()),
  passed_ids: z.array(z.string()),
  failed_ids: z.array(z.string()),
  unverified_ids: z.array(z.string()),
  unknown_ids: z.array(z.string()),
  duplicate_ids: z.array(z.string()),
  missing_ids: z.array(z.string()),
  complete: z.boolean(),
  all_passed: z.boolean()
});

export const CodexProductAcceptanceEvidenceSchema = CodexAcceptanceEvidenceSchema.omit({ all_passed: true }).extend({
  agent_all_passed: z.boolean()
}).strict();

export const CodexReviewCheckStatusSchema = z.enum([
  "passed",
  "failed",
  "incomplete",
  "unavailable",
  "not_applicable"
]);

export const CodexTechnicalReadinessSchema = z.object({
  status: z.enum(["passed", "failed", "incomplete", "unavailable"]),
  deterministic: z.literal(true),
  checks: z.object({
    integrity: CodexReviewCheckStatusSchema,
    baseline: CodexReviewCheckStatusSchema,
    authorization: CodexReviewCheckStatusSchema,
    result_contract: CodexReviewCheckStatusSchema,
    result_status: CodexReviewCheckStatusSchema,
    scope: CodexReviewCheckStatusSchema,
    change_attribution: CodexReviewCheckStatusSchema,
    connected_changes: CodexReviewCheckStatusSchema,
    technical_acceptance: CodexReviewCheckStatusSchema,
    validation: CodexReviewCheckStatusSchema
  }).strict(),
  blocking_reasons: z.array(z.string().min(1).max(160)).max(50),
  incomplete_reasons: z.array(z.string().min(1).max(160)).max(50)
}).strict();

export const CodexProductReviewSchema = z.object({
  requirement: z.enum(["required", "not_applicable", "unavailable"]),
  status: z.enum(["pending", "not_applicable", "unavailable"]),
  source: z.enum(["manifest", "legacy_unavailable"])
}).strict().superRefine((value, context) => {
  const valid = (value.requirement === "required" && value.status === "pending" && value.source === "manifest")
    || (value.requirement === "not_applicable" && value.status === "not_applicable" && value.source === "manifest")
    || (value.requirement === "unavailable" && value.status === "unavailable" && value.source === "legacy_unavailable");
  if (!valid) context.addIssue({ code: "custom", message: "Product review requirement, status, and source must describe one coherent state." });
});

const ProductEvidenceAcceptanceSchema = z.object({
  id: z.string().regex(/^PAC-[1-9][0-9]*$/),
  criterion: ShortTextSchema,
  agent_status: z.enum(["passed", "failed", "unverified", "missing"]),
  agent_evidence: z.string().max(2_000)
}).strict();

const ProductEvidenceDiffSignalSchema = z.object({
  path: CodexRepoPathSchema,
  status: z.string().max(100).optional(),
  hunk_count: z.number().int().nonnegative(),
  summary: z.string().max(500)
}).strict();

export const CodexProductEvidencePackSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    product: z.object({
      name: z.string().min(1).max(160),
      purpose: BoundedTextSchema
    }).strict(),
    primary_user: z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      role: ShortTextSchema,
      work_context: BoundedTextSchema
    }).strict(),
    jobs_to_be_done: z.array(z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      statement: BoundedTextSchema
    }).strict()).max(20),
    declared_outcome: z.object({
      beneficiary: ShortTextSchema,
      current_problem: BoundedTextSchema,
      desired_outcome: BoundedTextSchema,
      why_now: BoundedTextSchema
    }).strict(),
    product_goal: BoundedTextSchema,
    must_reduce: z.array(ShortTextSchema).max(30),
    must_not_become: z.array(ShortTextSchema).max(60),
    experience_principles: z.array(ShortTextSchema).max(30),
    product_acceptance_criteria: z.array(ProductEvidenceAcceptanceSchema).max(20),
    changed_paths: z.array(CodexRepoPathSchema).max(MAX_LIST_ITEMS),
    connected_changes: z.array(z.object({
      path: CodexRepoPathSchema,
      reason: ShortTextSchema
    }).strict()).max(MAX_LIST_ITEMS),
    diff_signals: z.array(ProductEvidenceDiffSignalSchema).max(50),
    lineage: z.object({
      kind: z.enum(["root", "corrective", "scope_amendment"]),
      root_run_id: CodexRunIdSchema,
      parent_run_id: CodexRunIdSchema.nullable(),
      child_index: z.number().int().min(1).max(2).nullable()
    }).strict(),
    scope_extension_required: z.array(DelegationScopeExtensionV3Schema).max(30),
    truncated: z.boolean()
  }).strict(),
  z.object({
    status: z.literal("not_applicable"),
    reason: z.literal("technical_task")
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["legacy_run", "missing_product_binding", "integrity_failed"])
  }).strict()
]);

export const CodexReviewStateAvailableSchema = z.object({
  status: z.literal("available"),
  state_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  result_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  worktree_fingerprint: z.string().min(1).max(128),
  binding_version: z.literal(2).optional(),
  pathset_fingerprint: z.string().min(1).max(128).optional(),
  changed_paths: z.array(CodexRepoPathSchema).max(MAX_LIST_ITEMS),
  technical_readiness_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  product_review_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  product_evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  scope_evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  technical_acceptance_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  product_acceptance_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const CodexReviewStateUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.enum(["legacy_run", "missing_result", "missing_git_state", "missing_root"])
}).strict();

export const CodexReviewStateSchema = z.discriminatedUnion("status", [
  CodexReviewStateAvailableSchema,
  CodexReviewStateUnavailableSchema
]);

export const CodexReviewAttestedEvidenceSchema = z.object({
  criterion_id: z.string().regex(/^PAC-[1-9][0-9]*$/),
  verdict: z.enum(["passed", "failed"]),
  evidence: z.string().min(1).max(2_000).refine((value) => !value.includes("\0"), "NUL characters are not allowed.")
}).strict();

export const CodexReviewAttestationStatusSchema = z.object({
  status: z.enum(["missing", "valid", "stale", "tampered", "unavailable"]),
  review_path: z.string(),
  verdict: z.enum(["passed", "failed", "not_applicable"]).optional(),
  reviewed_at: z.string().datetime().optional(),
  review_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  rationale: z.string().min(1).max(2_000).optional(),
  evidence: z.array(CodexReviewAttestedEvidenceSchema).max(20).optional(),
  reasons: z.array(z.string().min(1).max(160)).max(20)
}).strict();

export const CodexReviewScopeSchema = z.object({
  newly_observed_paths: z.array(z.string()),
  pre_existing_paths: z.array(z.string()),
  attributed_paths: z.array(z.string()).default([]),
  dirty_baseline_attributed_paths: z.array(z.string()).default([]),
  unattributed_paths: z.array(z.string()).default([]),
  out_of_scope_paths: z.array(z.string()),
  forbidden_paths: z.array(z.string()),
  claimed_but_not_observed: z.array(z.string()),
  observed_but_unreported: z.array(z.string()),
  attribution_ambiguous_paths: z.array(z.string())
});

const CodexReviewNextToolPayloadsSchema = GitReviewResultSchema.shape.next_tool_payloads.extend({
  repo_write_codex_task: DelegationTaskV3ToolInputSchema.optional(),
  repo_ship_review: z.object({
    repo_id: z.string().min(1),
    run_id: CodexRunIdSchema,
    paths: z.array(CodexRepoPathSchema).max(MAX_LIST_ITEMS)
  }).strict().optional()
});

export const CodexReviewResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  run_id: CodexRunIdSchema,
  legacy_result_path: z.string().optional(),
  result_json_path: z.string(),
  result_source: z.enum(["RESULT.json", "RESULT.md"]).optional(),
  result_found: z.boolean(),
  integrity: CodexReviewIntegritySchema,
  scope_evidence: CodexReviewScopeSchema,
  acceptance_evidence: CodexAcceptanceEvidenceSchema,
  technical_acceptance_evidence: CodexAcceptanceEvidenceSchema,
  product_acceptance_evidence: CodexProductAcceptanceEvidenceSchema,
  technical_readiness: CodexTechnicalReadinessSchema,
  product_review: CodexProductReviewSchema,
  product_evidence: CodexProductEvidencePackSchema,
  review_state: CodexReviewStateSchema,
  review_attestation: CodexReviewAttestationStatusSchema,
  review_loop: z.object({
    status: z.enum(["not_applicable", "eligible", "limit_reached", "blocked"]),
    parent_run_id: CodexRunIdSchema.nullable(),
    root_run_id: CodexRunIdSchema.nullable(),
    children_created: z.number().int().nonnegative(),
    max_children: z.literal(2),
    next_child_index: z.number().int().min(1).max(2).nullable(),
    next_parent_run_id: CodexRunIdSchema.nullable().optional(),
    next_child_kind: z.enum(["corrective", "scope_amendment"]).nullable().optional(),
    allowed_paths: z.array(CodexRepoPatternSchema).max(MAX_LIST_ITEMS),
    authorization_scope: z.array(CodexRepoPatternSchema).max(MAX_LIST_ITEMS).optional(),
    scope_extension_required: z.array(DelegationScopeExtensionV3Schema).max(MAX_LIST_ITEMS).optional(),
    instructions: z.array(ShortTextSchema).max(6)
  }).optional(),
  codex_result: CodexParsedResultSchema.optional(),
  git_review: GitReviewResultSchema.optional(),
  next_tool_payloads: CodexReviewNextToolPayloadsSchema.optional(),
  next_steps: z.array(z.string()),
  warnings: z.array(z.string())
});

export type CodexTechnicalReadiness = z.infer<typeof CodexTechnicalReadinessSchema>;
export type CodexProductReview = z.infer<typeof CodexProductReviewSchema>;
export type CodexProductEvidencePack = z.infer<typeof CodexProductEvidencePackSchema>;
export type CodexReviewState = z.infer<typeof CodexReviewStateSchema>;
export type CodexReviewAttestationStatus = z.infer<typeof CodexReviewAttestationStatusSchema>;

export type CodexTask = z.output<typeof CodexTaskInputSchema>;
export type CodexTaskInput = z.input<typeof CodexTaskInputSchema>;
export type CodexTaskWrite = z.output<typeof CodexTaskWriteInputSchema>;
export type CodexTaskWriteInput = z.input<typeof CodexTaskWriteInputSchema>;
export type CodexTaskResult = z.infer<typeof CodexTaskResultSchema>;
export type CodexTaskWriteResult = z.infer<typeof CodexTaskWriteResultSchema>;
export type CodexReviewInput = z.infer<typeof CodexReviewInputSchema>;
export type CodexParsedResult = z.infer<typeof CodexParsedResultSchema>;
export type CodexStructuredResult = z.infer<typeof CodexStructuredResultSchema>;
export type CodexReviewResult = z.infer<typeof CodexReviewResultSchema>;
