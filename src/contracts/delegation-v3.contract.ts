import { z } from "zod";
import { AgentRunnerNameSchema, AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";
import { ProductContextSnapshotSchema } from "./product-contract.contract.js";
import { ValidationProfileSchema } from "./validation.contract.js";

const MAX_TITLE = 160;
const MAX_ASSIGNMENT = 1_500;
const MAX_CONTEXT = 2_000;
const MAX_OUTCOME_TEXT = 1_500;
const MAX_SHORT_TEXT = 500;
const MAX_EVIDENCE_TEXT = 2_000;
const MAX_PATH_PATTERN = 512;
const MAX_STARTING_POINTS = 20;
const MAX_AUTHORIZATION_PATTERNS = 50;
const MAX_BOUNDARY_ITEMS = 30;
const MAX_PRODUCT_CRITERIA = 20;
const MAX_TECHNICAL_CRITERIA = 30;
const MAX_JOB_IDS = 20;
const MAX_RESULT_ITEMS = 1_000;

function boundedText(max: number) {
  return z.string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"), "NUL characters are not allowed.")
    .refine((value) => value.trim().length > 0, "Text must not be empty after trimming.");
}

const SingleLineTextSchema = boundedText(MAX_TITLE)
  .refine((value) => !/[\r\n]/.test(value), "A single-line value is required.");
const ShortTextSchema = boundedText(MAX_SHORT_TEXT);
const OutcomeTextSchema = boundedText(MAX_OUTCOME_TEXT);
const EvidenceTextSchema = z.string()
  .max(MAX_EVIDENCE_TEXT)
  .refine((value) => !value.includes("\0"), "NUL characters are not allowed.");

export const DelegationTaskKindV3Schema = z.enum([
  "product_slice",
  "product_correction",
  "technical_infrastructure",
  "security_or_migration"
]);

export const DelegationProductTaskKindV3Schema = z.enum(["product_slice", "product_correction"]);

export const DelegationRepoPatternV3Schema = z.string().min(1).max(MAX_PATH_PATTERN).superRefine((value, context) => {
  if (value !== value.trim()) {
    context.addIssue({ code: "custom", message: "Repo patterns cannot contain leading or trailing whitespace." });
  }
  if (/[\0\r\n]/.test(value)) {
    context.addIssue({ code: "custom", message: "Repo patterns cannot contain NUL or newlines." });
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "Repo-relative POSIX paths and globs are required." });
  }
  if (value === "." || value.startsWith("./") || value.split("/").includes("..")) {
    context.addIssue({ code: "custom", message: "Path traversal and dot-relative patterns are not allowed." });
  }
});

export const DelegationRepoPathV3Schema = DelegationRepoPatternV3Schema.refine(
  (value) => !value.includes("*"),
  "A concrete repo-relative path is required; wildcard asterisks are not allowed."
);

const ProductCriterionIdSchema = z.string().regex(/^PAC-[1-9][0-9]*$/);
const TechnicalCriterionIdSchema = z.string().regex(/^TAC-[1-9][0-9]*$/);

function criterionInputSchema(idSchema: z.ZodString) {
  return z.union([
    ShortTextSchema,
    z.object({
      id: idSchema.optional(),
      criterion: ShortTextSchema
    }).strict()
  ]);
}

export const ProductAcceptanceCriterionInputV3Schema = criterionInputSchema(ProductCriterionIdSchema);
export const TechnicalAcceptanceCriterionInputV3Schema = criterionInputSchema(TechnicalCriterionIdSchema);

export const ProductAcceptanceCriterionV3Schema = z.object({
  id: ProductCriterionIdSchema,
  criterion: ShortTextSchema
}).strict();

export const TechnicalAcceptanceCriterionV3Schema = z.object({
  id: TechnicalCriterionIdSchema,
  criterion: ShortTextSchema
}).strict();

export const DelegationOutcomeV3Schema = z.object({
  beneficiary: boundedText(MAX_SHORT_TEXT),
  current_problem: OutcomeTextSchema,
  desired_outcome: OutcomeTextSchema,
  why_now: boundedText(1_000)
}).strict();

export const DelegationProductAlignmentInputV3Schema = z.object({
  primary_user_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  job_ids: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).min(1).max(MAX_JOB_IDS),
  user_problem: OutcomeTextSchema,
  product_goal: OutcomeTextSchema,
  additional_must_not_become: z.array(ShortTextSchema).max(MAX_BOUNDARY_ITEMS).default([]),
  product_acceptance_criteria: z.array(ProductAcceptanceCriterionInputV3Schema).min(1).max(MAX_PRODUCT_CRITERIA)
}).strict();

export const DelegationProductAlignmentV3Schema = DelegationProductAlignmentInputV3Schema.omit({
  product_acceptance_criteria: true
}).extend({
  product_acceptance_criteria: z.array(ProductAcceptanceCriterionV3Schema).min(1).max(MAX_PRODUCT_CRITERIA)
}).strict();

export const DelegationTechnicalContextV3Schema = z.object({
  enabling_value: OutcomeTextSchema
}).strict();

export const DelegationSecurityContextV3Schema = z.object({
  protected_contract: OutcomeTextSchema,
  failure_risk: OutcomeTextSchema
}).strict();

export const DelegationValidationRequestV3Schema = z.object({
  profile: ValidationProfileSchema,
  test_paths: z.array(DelegationRepoPathV3Schema).max(100).default([])
}).strict().superRefine((value, context) => {
  if (value.test_paths.length > 0 && value.profile !== "test") {
    context.addIssue({ code: "custom", path: ["test_paths"], message: "test_paths require validation profile test." });
  }
});

export const DelegationRunnerV3Schema = z.object({
  mode: z.enum(["manual", "queued"]),
  requested_runner: AgentRunnerNameSchema.optional(),
  max_runtime_ms: z.number().int().positive().optional()
}).strict().superRefine((value, context) => {
  if (value.mode === "queued" && value.requested_runner === undefined) {
    context.addIssue({ code: "custom", path: ["requested_runner"], message: "queued mode requires requested_runner." });
  }
  if (value.mode === "manual" && value.requested_runner !== undefined) {
    context.addIssue({ code: "custom", path: ["requested_runner"], message: "manual mode cannot request a runner." });
  }
  if (value.mode === "manual" && value.max_runtime_ms !== undefined) {
    context.addIssue({ code: "custom", path: ["max_runtime_ms"], message: "manual mode cannot request runner runtime." });
  }
});

export const DelegationScopeExtensionV3Schema = z.object({
  path_or_area: DelegationRepoPatternV3Schema,
  reason: ShortTextSchema,
  required_outcome: OutcomeTextSchema
}).strict();

export const DelegationLineageInputV3Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("corrective"),
    parent_run_id: AgentRunnerRunIdSchema,
    reason: OutcomeTextSchema
  }).strict(),
  z.object({
    kind: z.literal("scope_amendment"),
    parent_run_id: AgentRunnerRunIdSchema,
    reason: OutcomeTextSchema,
    authorization_additions: z.array(DelegationRepoPatternV3Schema).min(1).max(MAX_BOUNDARY_ITEMS)
  }).strict()
]).superRefine((value, context) => {
  if (value.kind === "scope_amendment") {
    assertUniqueStrings(value.authorization_additions, context, ["authorization_additions"]);
  }
});

const DelegationLineageBindingV3Shape = {
  parent_run_id: AgentRunnerRunIdSchema,
  root_run_id: AgentRunnerRunIdSchema,
  child_index: z.number().int().min(1).max(2),
  max_children: z.literal(2),
  reason: OutcomeTextSchema,
  parent_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  root_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/)
};

export const DelegationLineageV3Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("corrective"),
    ...DelegationLineageBindingV3Shape
  }).strict(),
  z.object({
    kind: z.literal("scope_amendment"),
    ...DelegationLineageBindingV3Shape,
    authorization_additions: z.array(DelegationRepoPatternV3Schema).min(1).max(MAX_BOUNDARY_ITEMS),
    evidence: z.object({
      source: z.literal("parent_result"),
      parent_result_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      scope_extension_required: z.array(DelegationScopeExtensionV3Schema).min(1).max(MAX_BOUNDARY_ITEMS)
    }).strict()
  }).strict()
]).superRefine((value, context) => {
  if (value.kind === "scope_amendment") {
    assertUniqueStrings(value.authorization_additions, context, ["authorization_additions"]);
    assertUniqueStrings(value.evidence.scope_extension_required.map(({ path_or_area }) => path_or_area), context, ["evidence", "scope_extension_required"]);
  }
});

export const DelegationLineageSummaryV3Schema = z.object({
  kind: z.enum(["corrective", "scope_amendment"]),
  parent_run_id: AgentRunnerRunIdSchema,
  root_run_id: AgentRunnerRunIdSchema,
  child_index: z.number().int().min(1).max(2),
  max_children: z.literal(2)
}).strict();

const CommonTaskInputShape = {
  repo_id: z.string().min(1).max(200),
  title: SingleLineTextSchema,
  assignment: boundedText(MAX_ASSIGNMENT),
  outcome: DelegationOutcomeV3Schema,
  relevant_context: boundedText(MAX_CONTEXT).optional(),
  starting_points: z.array(DelegationRepoPatternV3Schema).max(MAX_STARTING_POINTS).default([]),
  authorization_scope: z.array(DelegationRepoPatternV3Schema).min(1).max(MAX_AUTHORIZATION_PATTERNS),
  forbidden_paths: z.array(DelegationRepoPatternV3Schema).max(MAX_AUTHORIZATION_PATTERNS).default([]),
  hard_constraints: z.array(ShortTextSchema).max(MAX_BOUNDARY_ITEMS).default([]),
  must_preserve: z.array(ShortTextSchema).max(MAX_BOUNDARY_ITEMS).default([]),
  explicit_exclusions: z.array(ShortTextSchema).max(MAX_BOUNDARY_ITEMS).default([]),
  technical_acceptance_criteria: z.array(TechnicalAcceptanceCriterionInputV3Schema).min(1).max(MAX_TECHNICAL_CRITERIA),
  validation: DelegationValidationRequestV3Schema.optional(),
  runner: DelegationRunnerV3Schema.default({ mode: "manual" }),
  lineage: DelegationLineageInputV3Schema.optional(),
  run_id: AgentRunnerRunIdSchema.optional()
};

const CommonTaskShape = {
  ...CommonTaskInputShape,
  technical_acceptance_criteria: z.array(TechnicalAcceptanceCriterionV3Schema).min(1).max(MAX_TECHNICAL_CRITERIA),
  lineage: DelegationLineageV3Schema.optional()
};

const ProductTaskInputV3Schema = z.object({
  ...CommonTaskInputShape,
  task_kind: DelegationProductTaskKindV3Schema,
  product_alignment: DelegationProductAlignmentInputV3Schema
}).strict();

const TechnicalTaskInputV3Schema = z.object({
  ...CommonTaskInputShape,
  task_kind: z.literal("technical_infrastructure"),
  technical_context: DelegationTechnicalContextV3Schema
}).strict();

const SecurityTaskInputV3Schema = z.object({
  ...CommonTaskInputShape,
  task_kind: z.literal("security_or_migration"),
  security_context: DelegationSecurityContextV3Schema
}).strict();

export const DelegationTaskV3InputSchema = z.discriminatedUnion("task_kind", [
  ProductTaskInputV3Schema,
  TechnicalTaskInputV3Schema,
  SecurityTaskInputV3Schema
]).superRefine(assertTaskCollectionsUnique);

const DelegationTaskV3ToolShape = {
  repo_id: CommonTaskInputShape.repo_id.describe("Stable approved repository id."),
  title: CommonTaskInputShape.title.describe("Short task title used for the run id and durable artifacts."),
  task_kind: DelegationTaskKindV3Schema.describe("Delegation kind; determines required product, technical, or security context."),
  assignment: CommonTaskInputShape.assignment.describe("Bounded assignment describing what outcome to create, not a file-by-file implementation plan."),
  outcome: DelegationOutcomeV3Schema.describe("Required beneficiary, current problem, desired outcome, and why-now frame."),
  product_alignment: DelegationProductAlignmentInputV3Schema.optional().describe("Required only for product_slice and product_correction; references repository product user/jobs and defines PACs."),
  technical_context: DelegationTechnicalContextV3Schema.optional().describe("Required only for technical_infrastructure; states the operational enabling value."),
  security_context: DelegationSecurityContextV3Schema.optional().describe("Required only for security_or_migration; states the protected contract and failure risk."),
  relevant_context: CommonTaskInputShape.relevant_context.describe("Optional bounded context that affects the outcome without prescribing the complete implementation."),
  starting_points: CommonTaskInputShape.starting_points.describe("Advisory repo-relative files or globs that are useful places to start inspecting; not exhaustive."),
  authorization_scope: CommonTaskInputShape.authorization_scope.describe("Repo-relative files or globs where implementation changes are authorized; this is permission, not an implementation prediction."),
  forbidden_paths: CommonTaskInputShape.forbidden_paths.describe("Additional repo-relative paths or globs that must not be edited; server defaults remain additive."),
  hard_constraints: CommonTaskInputShape.hard_constraints.describe("Non-negotiable security, integrity, compatibility, migration, or domain constraints."),
  must_preserve: CommonTaskInputShape.must_preserve.describe("Existing behavior, evidence, compatibility, or user value that the implementation must preserve."),
  explicit_exclusions: CommonTaskInputShape.explicit_exclusions.describe("Outcomes or changes explicitly outside this task."),
  technical_acceptance_criteria: CommonTaskInputShape.technical_acceptance_criteria.describe("Technical acceptance criteria; strings receive deterministic TAC ids."),
  validation: CommonTaskInputShape.validation.describe("Optional structured allowlisted repository validation request."),
  runner: CommonTaskInputShape.runner.describe("Durable handoff mode. Manual writes artifacts for external execution; queued writes validated handoff metadata for a separately configured allowlisted runner. Writing the task never starts the runner itself."),
  lineage: CommonTaskInputShape.lineage.describe("Optional corrective or evidence-bound scope-amendment relationship to a terminal Delegation v3 parent. Root product/outcome contracts are inherited and cannot be weakened."),
  run_id: CommonTaskInputShape.run_id.describe("Optional stable repo-local run id; generated when omitted.")
};

export const DelegationTaskV3ToolInputSchema = z.object(DelegationTaskV3ToolShape)
  .strict()
  .superRefine(assertDelegationToolTask);

export const DelegationTaskV3WriteToolInputSchema = z.object({
  ...DelegationTaskV3ToolShape,
  dry_run: z.boolean().optional().describe("Render and validate the v3 task without writing PROMPT.md or run.json."),
  reason: z.string().min(1).max(500).refine((value) => !value.includes("\0"), "NUL characters are not allowed.").optional()
    .describe("Short audit reason for writing the task locally.")
}).strict().superRefine(assertDelegationToolTask);

const ProductTaskV3Schema = z.object({
  ...CommonTaskShape,
  task_kind: DelegationProductTaskKindV3Schema,
  product_alignment: DelegationProductAlignmentV3Schema
}).strict();

const TechnicalTaskV3Schema = z.object({
  ...CommonTaskShape,
  task_kind: z.literal("technical_infrastructure"),
  technical_context: DelegationTechnicalContextV3Schema
}).strict();

const SecurityTaskV3Schema = z.object({
  ...CommonTaskShape,
  task_kind: z.literal("security_or_migration"),
  security_context: DelegationSecurityContextV3Schema
}).strict();

export const DelegationTaskV3Schema = z.discriminatedUnion("task_kind", [
  ProductTaskV3Schema,
  TechnicalTaskV3Schema,
  SecurityTaskV3Schema
]).superRefine(assertTaskCollectionsUnique);

export const DelegationReviewRequirementV3Schema = z.enum(["product_required", "technical_only"]);

export const DelegationProductBindingV3Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_required") }).strict(),
  z.object({
    kind: z.literal("selected"),
    source_path: DelegationRepoPathV3Schema,
    contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    snapshot: ProductContextSnapshotSchema
  }).strict()
]);

export const DelegationAuditV3Schema = z.object({
  verdict: z.enum(["passed", "passed_with_warnings", "blocked"]),
  mode: z.enum(["advisory", "enforce"]),
  product_grounding: z.enum(["complete", "not_required", "missing", "invalid"]),
  closed_world_risk: z.enum(["low", "medium", "high"]),
  overspecification_risk: z.enum(["low", "medium", "high"]),
  signals: z.array(ShortTextSchema).max(50),
  warnings: z.array(z.string().min(1).max(160)).max(50)
}).strict();

export const DelegationPathStateV3Schema = z.object({
  path: DelegationRepoPathV3Schema,
  exists: z.boolean(),
  kind: z.enum(["file", "symlink", "missing", "other"]),
  head_blob_sha256: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const DelegationBaselineV3Schema = z.object({
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  worktree_fingerprint: z.string().min(1).max(128),
  initial_changed_paths: z.array(DelegationRepoPathV3Schema).max(10_000),
  initial_path_states: z.array(DelegationPathStateV3Schema).max(10_000).optional()
}).strict();

export const DelegationRunManifestV3Schema = z.object({
  schema_version: z.literal(3),
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  title: SingleLineTextSchema,
  task_kind: DelegationTaskKindV3Schema,
  task: DelegationTaskV3Schema,
  prompt_path: DelegationRepoPathV3Schema,
  result_json_path: DelegationRepoPathV3Schema,
  manifest_path: DelegationRepoPathV3Schema,
  product_binding: DelegationProductBindingV3Schema,
  review_requirement: DelegationReviewRequirementV3Schema,
  delegation_audit: DelegationAuditV3Schema,
  authorization: z.object({
    starting_points: z.array(DelegationRepoPatternV3Schema).max(MAX_STARTING_POINTS),
    caller_scope: z.array(DelegationRepoPatternV3Schema).min(1).max(MAX_AUTHORIZATION_PATTERNS),
    effective_scope: z.array(DelegationRepoPatternV3Schema).min(1).max(MAX_AUTHORIZATION_PATTERNS),
    caller_forbidden_paths: z.array(DelegationRepoPatternV3Schema).max(MAX_AUTHORIZATION_PATTERNS),
    effective_forbidden_paths: z.array(DelegationRepoPatternV3Schema).max(200)
  }).strict(),
  baseline: DelegationBaselineV3Schema,
  baseline_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  task_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_byte_count: z.number().int().nonnegative(),
  created_at: z.string().datetime()
}).strict().superRefine((value, context) => {
  if (value.task.repo_id !== value.repo_id || value.task.run_id !== value.run_id || value.task.title !== value.title || value.task.task_kind !== value.task_kind) {
    context.addIssue({ code: "custom", path: ["task"], message: "Manifest identity must match the normalized task." });
  }
  if (!sameArray(value.task.starting_points, value.authorization.starting_points)) {
    context.addIssue({ code: "custom", path: ["authorization", "starting_points"], message: "Manifest starting points must match the normalized task." });
  }
  if (!sameArray(value.task.authorization_scope, value.authorization.caller_scope)) {
    context.addIssue({ code: "custom", path: ["authorization", "caller_scope"], message: "Manifest caller scope must match the normalized task." });
  }
  if (!sameArray(value.task.forbidden_paths, value.authorization.caller_forbidden_paths)) {
    context.addIssue({ code: "custom", path: ["authorization", "caller_forbidden_paths"], message: "Manifest forbidden paths must match the normalized task." });
  }
  const productTask = value.task_kind === "product_slice" || value.task_kind === "product_correction";
  if (productTask && (value.review_requirement !== "product_required" || value.product_binding.kind !== "selected")) {
    context.addIssue({ code: "custom", path: ["product_binding"], message: "Product tasks require selected product binding and product review." });
  }
  if (!productTask && (value.review_requirement !== "technical_only" || value.product_binding.kind !== "not_required")) {
    context.addIssue({ code: "custom", path: ["product_binding"], message: "Technical tasks require technical-only review and no selected product binding." });
  }
  if (productTask && value.delegation_audit.product_grounding !== "complete") {
    context.addIssue({ code: "custom", path: ["delegation_audit", "product_grounding"], message: "Product task manifests require complete product grounding." });
  }
  if (!productTask && value.delegation_audit.product_grounding !== "not_required") {
    context.addIssue({ code: "custom", path: ["delegation_audit", "product_grounding"], message: "Technical task manifests require not_required product grounding." });
  }
  if (value.authorization.caller_forbidden_paths.some((pattern) => !value.authorization.effective_forbidden_paths.includes(pattern))) {
    context.addIssue({ code: "custom", path: ["authorization", "effective_forbidden_paths"], message: "Effective forbidden paths must retain every caller-forbidden pattern." });
  }
  if (productTask && value.product_binding.kind === "selected" && "product_alignment" in value.task) {
    if (value.product_binding.snapshot.primary_user.id !== value.task.product_alignment.primary_user_id) {
      context.addIssue({ code: "custom", path: ["product_binding", "snapshot", "primary_user"], message: "Product snapshot user does not match task alignment." });
    }
    if (!sameSet(value.product_binding.snapshot.jobs_to_be_done.map(({ id }) => id), value.task.product_alignment.job_ids)) {
      context.addIssue({ code: "custom", path: ["product_binding", "snapshot", "jobs_to_be_done"], message: "Product snapshot jobs do not match task alignment." });
    }
  }
});

export const DelegationCriterionResultStatusV3Schema = z.enum(["passed", "failed", "unverified"]);

export const ProductAcceptanceResultV3Schema = z.object({
  id: ProductCriterionIdSchema,
  status: DelegationCriterionResultStatusV3Schema,
  evidence: EvidenceTextSchema
}).strict();

export const TechnicalAcceptanceResultV3Schema = z.object({
  id: TechnicalCriterionIdSchema,
  status: DelegationCriterionResultStatusV3Schema,
  evidence: EvidenceTextSchema
}).strict();

export const DelegationConnectedChangeCategoryV3Schema = z.enum([
  "primary_implementation",
  "generated_contracts",
  "tests",
  "migration",
  "documentation",
  "other"
]);

export const DelegationConnectedChangeV3Schema = z.union([
  z.object({
    path: DelegationRepoPathV3Schema,
    reason: ShortTextSchema
  }).strict(),
  z.object({
    paths: z.array(DelegationRepoPathV3Schema).min(1).max(MAX_RESULT_ITEMS),
    category: DelegationConnectedChangeCategoryV3Schema,
    reason: ShortTextSchema
  }).strict()
]);

export const DelegationResultV3Schema = z.object({
  schema_version: z.literal(3),
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  status: z.enum(["completed", "blocked"]),
  summary: boundedText(MAX_OUTCOME_TEXT),
  changed_files: z.array(DelegationRepoPathV3Schema).max(MAX_RESULT_ITEMS),
  connected_changes: z.array(DelegationConnectedChangeV3Schema).max(MAX_RESULT_ITEMS),
  commands_run: z.array(ShortTextSchema).max(MAX_RESULT_ITEMS),
  tests: z.array(ShortTextSchema).max(MAX_RESULT_ITEMS),
  product_acceptance_criteria: z.array(ProductAcceptanceResultV3Schema).max(MAX_PRODUCT_CRITERIA),
  technical_acceptance_criteria: z.array(TechnicalAcceptanceResultV3Schema).max(MAX_TECHNICAL_CRITERIA),
  scope_extension_required: z.array(z.object({
    path_or_area: DelegationRepoPatternV3Schema,
    reason: ShortTextSchema,
    required_outcome: OutcomeTextSchema
  }).strict()).max(MAX_BOUNDARY_ITEMS),
  blockers: z.array(ShortTextSchema).max(MAX_RESULT_ITEMS),
  followups: z.array(ShortTextSchema).max(MAX_RESULT_ITEMS)
}).strict().superRefine((value, context) => {
  assertUniqueStrings(value.changed_files, context, ["changed_files"]);
  const connectedPaths = value.connected_changes.flatMap((entry) => "path" in entry ? [entry.path] : entry.paths);
  assertUniqueStrings(connectedPaths, context, ["connected_changes"]);
  assertUniqueStrings(value.product_acceptance_criteria.map(({ id }) => id), context, ["product_acceptance_criteria"]);
  assertUniqueStrings(value.technical_acceptance_criteria.map(({ id }) => id), context, ["technical_acceptance_criteria"]);
  assertUniqueStrings(value.scope_extension_required.map(({ path_or_area }) => path_or_area), context, ["scope_extension_required"]);
  const changed = new Set(value.changed_files);
  if (connectedPaths.some((path) => !changed.has(path))) {
    context.addIssue({ code: "custom", path: ["connected_changes"], message: "Connected changes must refer to reported changed_files." });
  }
  if (connectedPaths.length !== value.changed_files.length || value.changed_files.some((path) => !connectedPaths.includes(path))) {
    context.addIssue({ code: "custom", path: ["connected_changes"], message: "Connected-change entries must cover every changed file exactly once." });
  }
  if (value.status === "completed" && (value.blockers.length > 0 || value.scope_extension_required.length > 0)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Completed results cannot contain blockers or scope-extension requirements." });
  }
  if (value.status === "blocked" && value.blockers.length === 0 && value.scope_extension_required.length === 0) {
    context.addIssue({ code: "custom", path: ["status"], message: "Blocked results require a blocker or scope-extension requirement." });
  }
});

const DelegationPreparedResultV3Shape = {
  ok: z.literal(true),
  schema_version: z.literal(3),
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  task_kind: DelegationTaskKindV3Schema,
  prompt_path: DelegationRepoPathV3Schema,
  result_json_path: DelegationRepoPathV3Schema,
  manifest_path: DelegationRepoPathV3Schema,
  review_requirement: DelegationReviewRequirementV3Schema,
  review_gate_path: DelegationRepoPathV3Schema,
  product_contract_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  delegation_audit: DelegationAuditV3Schema,
  lineage: DelegationLineageSummaryV3Schema.optional(),
  warnings: z.array(z.string())
};

export const DelegationPreparedResultV3Schema = z.object(DelegationPreparedResultV3Shape)
  .strict()
  .superRefine(assertDelegationOutputAlignment);

export const DelegationWriteResultV3Schema = z.object({
  ...DelegationPreparedResultV3Shape,
  dry_run: z.boolean(),
  written_paths: z.array(DelegationRepoPathV3Schema),
  next_tool_payloads: z.object({
    repo_agent_runs: z.object({
      repo_id: z.string().min(1).max(200),
      run_id: AgentRunnerRunIdSchema
    }).strict()
  }).strict().optional()
}).strict().superRefine(assertDelegationOutputAlignment);

function assertDelegationToolTask(value: unknown, context: z.RefinementCtx): void {
  const taskValue = typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "dry_run" && key !== "reason"))
    : value;
  const parsed = DelegationTaskV3InputSchema.safeParse(taskValue);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({
      code: "custom",
      path: issue.path,
      message: issue.message
    });
  }
}

function assertDelegationOutputAlignment(
  value: {
    task_kind: z.infer<typeof DelegationTaskKindV3Schema>;
    review_requirement: z.infer<typeof DelegationReviewRequirementV3Schema>;
    product_contract_sha256?: string;
    delegation_audit: z.infer<typeof DelegationAuditV3Schema>;
  },
  context: z.RefinementCtx
): void {
  const productTask = value.task_kind === "product_slice" || value.task_kind === "product_correction";
  if (productTask && value.review_requirement !== "product_required") {
    context.addIssue({ code: "custom", path: ["review_requirement"], message: "Product task outputs require product review." });
  }
  if (productTask && value.product_contract_sha256 === undefined) {
    context.addIssue({ code: "custom", path: ["product_contract_sha256"], message: "Product task outputs require the bound product-contract hash." });
  }
  if (productTask && value.delegation_audit.product_grounding !== "complete") {
    context.addIssue({ code: "custom", path: ["delegation_audit", "product_grounding"], message: "Product task outputs require complete product grounding." });
  }
  if (!productTask && value.review_requirement !== "technical_only") {
    context.addIssue({ code: "custom", path: ["review_requirement"], message: "Technical task outputs require technical-only review." });
  }
  if (!productTask && value.product_contract_sha256 !== undefined) {
    context.addIssue({ code: "custom", path: ["product_contract_sha256"], message: "Technical task outputs cannot claim a selected product-contract binding." });
  }
  if (!productTask && value.delegation_audit.product_grounding !== "not_required") {
    context.addIssue({ code: "custom", path: ["delegation_audit", "product_grounding"], message: "Technical task outputs require not_required product grounding." });
  }
}

export type DelegationTaskKindV3 = z.infer<typeof DelegationTaskKindV3Schema>;
export type DelegationTaskV3Input = z.input<typeof DelegationTaskV3InputSchema>;
export type DelegationTaskV3ToolInput = z.input<typeof DelegationTaskV3ToolInputSchema>;
export type DelegationTaskV3ToolOutput = z.output<typeof DelegationTaskV3ToolInputSchema>;
export type DelegationTaskV3WriteToolInput = z.input<typeof DelegationTaskV3WriteToolInputSchema>;
export type DelegationLineageInputV3 = z.infer<typeof DelegationLineageInputV3Schema>;
export type DelegationLineageV3 = z.infer<typeof DelegationLineageV3Schema>;
export type DelegationTaskV3 = z.infer<typeof DelegationTaskV3Schema>;
export type DelegationRunManifestV3 = z.infer<typeof DelegationRunManifestV3Schema>;
export type DelegationResultV3 = z.infer<typeof DelegationResultV3Schema>;
export type DelegationProductBindingV3 = z.infer<typeof DelegationProductBindingV3Schema>;
export type DelegationReviewRequirementV3 = z.infer<typeof DelegationReviewRequirementV3Schema>;

function assertTaskCollectionsUnique(value: z.infer<typeof ProductTaskInputV3Schema> | z.infer<typeof TechnicalTaskInputV3Schema> | z.infer<typeof SecurityTaskInputV3Schema> | z.infer<typeof ProductTaskV3Schema> | z.infer<typeof TechnicalTaskV3Schema> | z.infer<typeof SecurityTaskV3Schema>, context: z.RefinementCtx): void {
  assertUniqueStrings(value.starting_points, context, ["starting_points"]);
  assertUniqueStrings(value.authorization_scope, context, ["authorization_scope"]);
  assertUniqueStrings(value.forbidden_paths, context, ["forbidden_paths"]);
  assertUniqueStrings(value.hard_constraints, context, ["hard_constraints"]);
  assertUniqueStrings(value.must_preserve, context, ["must_preserve"]);
  assertUniqueStrings(value.explicit_exclusions, context, ["explicit_exclusions"]);
  if ("lineage" in value && value.lineage?.kind === "scope_amendment") {
    assertUniqueStrings(value.lineage.authorization_additions, context, ["lineage", "authorization_additions"]);
  }
  const technicalIds = value.technical_acceptance_criteria.flatMap((entry) => typeof entry === "string" || !entry.id ? [] : [entry.id]);
  assertUniqueStrings(technicalIds, context, ["technical_acceptance_criteria"]);
  if ("product_alignment" in value) {
    assertUniqueStrings(value.product_alignment.job_ids, context, ["product_alignment", "job_ids"]);
    assertUniqueStrings(value.product_alignment.additional_must_not_become, context, ["product_alignment", "additional_must_not_become"]);
    const productIds = value.product_alignment.product_acceptance_criteria.flatMap((entry) => typeof entry === "string" || !entry.id ? [] : [entry.id]);
    assertUniqueStrings(productIds, context, ["product_alignment", "product_acceptance_criteria"]);
  }
}

function assertUniqueStrings(values: readonly string[], context: z.RefinementCtx, path: PropertyKey[]): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: "Duplicate values are not allowed." });
  }
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
