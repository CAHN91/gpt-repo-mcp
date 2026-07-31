import type {
  DelegationAuditV3Schema,
  DelegationProductBindingV3,
  DelegationResultV3,
  DelegationTaskV3
} from "../contracts/delegation-v3.contract.js";
import type { z } from "zod";

type ResultPaths = { resultJsonPath: string };
type DelegationAuditV3 = z.infer<typeof DelegationAuditV3Schema>;

export function renderDelegationPromptV3(input: {
  task: DelegationTaskV3;
  runId: string;
  paths: ResultPaths;
  productBinding: DelegationProductBindingV3;
  effectiveForbiddenPaths: readonly string[];
  audit: DelegationAuditV3;
}): string {
  const { task, runId, paths, productBinding, effectiveForbiddenPaths, audit } = input;
  return [
    "# Delegation Task v3",
    "",
    `Run ID: ${runId}`,
    `Task kind: ${task.task_kind}`,
    "",
    ...renderFrame(task, productBinding),
    renderLineage(task),
    "## Assignment",
    "",
    task.assignment,
    "",
    ...(task.relevant_context ? ["## Relevant Context", "", task.relevant_context, ""] : []),
    renderList("Hard Constraints", task.hard_constraints),
    renderList("Must Preserve", task.must_preserve),
    renderStartingPoints(task.starting_points),
    renderAuthorization(task.authorization_scope),
    renderList("Forbidden Paths", effectiveForbiddenPaths),
    renderList("Explicit Exclusions", task.explicit_exclusions),
    renderImplementationResponsibility(),
    ...( "product_alignment" in task
      ? [renderCriteria("Product Acceptance Criteria", task.product_alignment.product_acceptance_criteria)]
      : []),
    renderCriteria("Technical Acceptance Criteria", task.technical_acceptance_criteria),
    renderValidation(task),
    renderRunner(task),
    renderAudit(audit),
    renderCompletion(task, paths),
    "Do not stage, commit, push, deploy, or modify Git history.",
    "Do not edit `.chatgpt/**` except this run's authoritative `RESULT.json`.",
    ""
  ].filter((section) => section !== "").join("\n");
}

function renderFrame(task: DelegationTaskV3, binding: DelegationProductBindingV3): string[] {
  const common = [
    "## Product or Operational Frame",
    "",
    `- Beneficiary: ${task.outcome.beneficiary}`,
    `- Current problem: ${task.outcome.current_problem}`,
    `- Desired outcome: ${task.outcome.desired_outcome}`,
    `- Why now: ${task.outcome.why_now}`
  ];
  if (binding.kind === "selected" && "product_alignment" in task) {
    return [
      ...common,
      `- Product: ${binding.snapshot.product.name}`,
      `- Product purpose: ${binding.snapshot.product.purpose}`,
      `- Primary user: ${binding.snapshot.primary_user.role}`,
      `- User work context: ${binding.snapshot.primary_user.work_context}`,
      `- User problem: ${task.product_alignment.user_problem}`,
      `- Product goal: ${task.product_alignment.product_goal}`,
      "- Selected jobs to be done:",
      ...binding.snapshot.jobs_to_be_done.map(({ statement }) => `  - ${statement}`),
      "- The product must reduce:",
      ...binding.snapshot.must_reduce.map((value) => `  - ${value}`),
      "- The product must not become:",
      ...[...binding.snapshot.must_not_become, ...task.product_alignment.additional_must_not_become].map((value) => `  - ${value}`),
      "- Experience principles:",
      ...binding.snapshot.experience_principles.map((value) => `  - ${value}`),
      ""
    ];
  }
  if ("technical_context" in task) {
    return [...common, `- Enabling value: ${task.technical_context.enabling_value}`, ""];
  }
  if ("security_context" in task) {
    return [
      ...common,
      `- Protected contract: ${task.security_context.protected_contract}`,
      `- Failure risk: ${task.security_context.failure_risk}`,
      ""
    ];
  }
  return [...common, ""];
}

function renderLineage(task: DelegationTaskV3): string {
  if (!task.lineage) return "";
  const lineage = task.lineage;
  return [
    "## Lineage",
    "",
    `- kind: ${lineage.kind}`,
    `- parent_run_id: ${lineage.parent_run_id}`,
    `- root_run_id: ${lineage.root_run_id}`,
    `- child_index: ${lineage.child_index}/${lineage.max_children}`,
    `- reason: ${lineage.reason}`,
    ...(lineage.kind === "scope_amendment"
      ? [
          "- approved authorization additions:",
          ...lineage.authorization_additions.map((value) => `  - ${value}`),
          "- evidence source: parent RESULT.json"
        ]
      : []),
    "",
    "This child inherits the root product/outcome contract. Do not reinterpret, weaken, or replace inherited PACs, hard constraints, preservation rules, exclusions, forbidden paths, or review requirements.",
    lineage.kind === "corrective"
      ? "Stay within the inherited or narrower authorization boundary."
      : "Use only the listed evidence-bound additions beyond the parent authorization boundary.",
    ""
  ].join("\n");
}

function renderStartingPoints(values: readonly string[]): string {
  if (values.length === 0) return "";
  return [
    "## Starting Points",
    "",
    "These are advisory places to begin inspecting. They are not an exhaustive read or implementation list.",
    "",
    ...values.map((value) => `- ${value}`),
    ""
  ].join("\n");
}

function renderAuthorization(values: readonly string[]): string {
  return [
    "## Authorization Boundary",
    "",
    "These paths define where changes are authorized. They do not predict which files must change.",
    "",
    ...values.map((value) => `- ${value}`),
    ""
  ].join("\n");
}

function renderImplementationResponsibility(): string {
  return [
    "## Implementation Responsibility",
    "",
    "Inspect the repository and determine the coherent set of changes required to achieve the stated outcome.",
    "The named starting points, areas, and criteria are not an exhaustive implementation plan.",
    "Complete logically connected work inside the authorization boundary when it is necessary for a correct and coherent solution.",
    "Do not expand authorization silently. If required work lies outside the boundary, stop and report a structured scope-extension request identifying the area, reason, and required outcome.",
    "Do not make unrelated changes merely because they are inside the authorization boundary.",
    ""
  ].join("\n");
}

function renderCriteria(title: string, values: readonly { id: string; criterion: string }[]): string {
  return [
    `## ${title}`,
    "",
    ...values.map(({ id, criterion }) => `- ${id}: ${criterion}`),
    ""
  ].join("\n");
}

function renderValidation(task: DelegationTaskV3): string {
  if (!task.validation) return "";
  return [
    "## Structured Validation",
    "",
    `- profile: ${task.validation.profile}`,
    ...task.validation.test_paths.map((path) => `- test_path: ${path}`),
    "",
    "Use the repository's safe validation workflow. Do not construct or execute an arbitrary shell command.",
    ""
  ].join("\n");
}

function renderRunner(task: DelegationTaskV3): string {
  return [
    "## Runner Handoff",
    "",
    `- mode: ${task.runner.mode}`,
    ...(task.runner.requested_runner ? [`- requested_runner: ${task.runner.requested_runner}`] : []),
    ...(task.runner.max_runtime_ms ? [`- max_runtime_ms: ${task.runner.max_runtime_ms}`] : []),
    "",
    "This is durable handoff metadata. Writing the task does not itself start, resume, stage, commit, or push.",
    ""
  ].join("\n");
}

function renderAudit(audit: DelegationAuditV3): string {
  if (audit.warnings.length === 0 && audit.signals.length === 0) return "";
  return [
    "## Delegation Audit",
    "",
    `- verdict: ${audit.verdict}`,
    `- mode: ${audit.mode}`,
    `- product_grounding: ${audit.product_grounding}`,
    `- closed_world_risk: ${audit.closed_world_risk}`,
    `- overspecification_risk: ${audit.overspecification_risk}`,
    ...audit.signals.map((value) => `- signal: ${value}`),
    ...audit.warnings.map((value) => `- warning: ${value}`),
    "",
    "Audit warnings are review signals, not permission to ignore the declared outcome or hard contracts.",
    ""
  ].join("\n");
}

function renderCompletion(task: DelegationTaskV3, paths: ResultPaths): string {
  const result: DelegationResultV3 = {
    schema_version: 3,
    repo_id: task.repo_id,
    run_id: task.run_id!,
    status: "completed",
    summary: "one-line practical outcome in plain language",
    changed_files: ["repo/relative/path"],
    connected_changes: [{ path: "repo/relative/path", reason: "why this connected change was required" }],
    commands_run: ["bounded command description"],
    tests: ["test outcome"],
    product_acceptance_criteria: "product_alignment" in task
      ? task.product_alignment.product_acceptance_criteria.map(({ id }) => ({ id, status: "passed", evidence: "concrete product evidence proving this criterion" }))
      : [],
    technical_acceptance_criteria: task.technical_acceptance_criteria.map(({ id }) => ({ id, status: "passed", evidence: "concrete technical evidence proving this criterion" })),
    scope_extension_required: [],
    blockers: [],
    followups: []
  };
  return [
    "## Completion Contract",
    "",
    `Before the final chat response, write strict JSON to \`${paths.resultJsonPath}\`.`,
    "Set status to completed or blocked. Do not add unknown fields.",
    "Criterion status values are closed and case-sensitive: use only `passed`, `failed`, or `unverified`. Never write `verified`.",
    "A completed result must report every PAC and TAC id exactly once, use `passed` for every criterion with concrete evidence, and contain no blockers or scope-extension requests.",
    "For blocked work, use `passed` for criteria already proven, `failed` for criteria disproven, and `unverified` for criteria not yet proven.",
    "A blocked result must include a blocker or a structured scope_extension_required entry.",
    "Use this exact completed-result shape:",
    "",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
    "",
    "Do not create alternate result artifacts; RESULT.json is the only result artifact for this task.",
    "After RESULT.json is valid, provide a separate user-facing completion response in the agent chat.",
    "Follow the active AGENTS.md communication and language rules.",
    "Explain what was completed, what became better in practice, whether the user must act, and any meaningful remaining limitation.",
    "Do not copy the technical RESULT.json evidence into the chat response. Do not list changed files, commands, PAC/TAC evidence, schemas, artifacts, or internal implementation terms unless the user explicitly asks or needs them to make a decision.",
    ""
  ].join("\n");
}

function renderList(title: string, values: readonly string[]): string {
  return values.length === 0 ? "" : [`## ${title}`, "", ...values.map((value) => `- ${value}`), ""].join("\n");
}
