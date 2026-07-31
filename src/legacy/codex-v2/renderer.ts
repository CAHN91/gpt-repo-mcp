import type { CodexTask, CodexTaskResult, CodexTaskWrite } from "../../contracts/codex-task.contract.js";
import {
  baselineSha256,
  effectiveForbiddenPatterns,
  numberedAcceptanceCriteria,
  renderForbiddenPolicySection,
  type CodexBaseline
} from "../../services/codex-task-policy.js";
import type { CodexCorrectiveLineage } from "../../services/codex-lineage-service.js";

type ResultPaths = { resultPath: string; resultJsonPath: string };

export function renderCodexPrompt(
  input: CodexTask,
  runId: string,
  paths: ResultPaths,
  options: { includeRunner?: boolean; lineage?: CodexCorrectiveLineage } = {}
): string {
  const acceptance = numberedAcceptanceCriteria(input.acceptance_criteria);
  return [
    "# Codex Task v2", "", `Run ID: ${runId}`, "",
    "## Objective", input.objective, "",
    ...(input.context_summary ? ["## Context Summary", input.context_summary, ""] : []),
    renderList("Inspect First", input.inspect_first),
    renderList("Allowed Paths", input.allowed_paths),
    renderForbiddenPolicySection(input.forbidden_paths),
    renderScope(input),
    ...(options.lineage ? renderLineage(options.lineage) : []),
    renderAcceptance(acceptance),
    ...(options.includeRunner === false ? [] : [renderRunner(input)]),
    renderValidation(input),
    renderLegacyVerification(input.verification_commands),
    "## Completion Contract", "",
    `Before your final chat response, write strict JSON to \`${paths.resultJsonPath}\`.`,
    "Set status to completed or blocked. Do not add unknown fields.",
    "Acceptance status values are closed and case-sensitive: use only `passed`, `failed`, or `unverified`. Never write `verified`.",
    "A completed result must use `passed` for every acceptance criterion with concrete evidence.",
    "Use this exact completed-result shape:", "", "```json",
    JSON.stringify({
      schema_version: 2,
      repo_id: input.repo_id,
      run_id: runId,
      status: "completed",
      summary: "one-line practical outcome in plain language",
      changed_files: ["repo/relative/path"],
      commands_run: ["command description"],
      tests: ["test outcome"],
      acceptance_criteria: acceptance.map(({ id }) => ({ id, status: "passed", evidence: "concrete evidence proving this criterion" })),
      blockers: [],
      followups: []
    }, null, 2),
    "```", "",
    `You may also write a human-readable summary to \`${paths.resultPath}\`, but RESULT.json is authoritative.`,
    "After RESULT.json is valid, provide a separate user-facing completion response in the Codex chat.",
    "Follow the active AGENTS.md communication and language rules. Explain the practical outcome and do not copy technical result evidence unless the user explicitly asks or needs it for a decision.", "",
    "Do not stage, commit, push, or edit unrelated files.",
    "Do not edit `.chatgpt/**` except this run's `RESULT.json` and optional `RESULT.md`.",
    ""
  ].filter((section) => section !== "").join("\n");
}

export function renderCodexManifest(input: CodexTaskWrite, prepared: CodexTaskResult, baseline: CodexBaseline): string {
  return renderCodexManifestWithLineage(input, prepared, baseline);
}

export function renderCodexManifestWithLineage(
  input: CodexTaskWrite,
  prepared: CodexTaskResult,
  baseline: CodexBaseline,
  lineage?: CodexCorrectiveLineage
): string {
  return `${JSON.stringify({
    schema_version: 2,
    repo_id: prepared.repo_id,
    run_id: prepared.run_id,
    title: input.title,
    objective: input.objective,
    ...(input.context_summary ? { context_summary: input.context_summary } : {}),
    prompt_path: prepared.prompt_path,
    result_path: prepared.result_path,
    result_json_path: prepared.result_json_path,
    manifest_path: prepared.manifest_path,
    inspect_first: input.inspect_first,
    allowed_paths: input.allowed_paths,
    caller_forbidden_paths: input.forbidden_paths,
    effective_forbidden_paths: effectiveForbiddenPatterns(input.forbidden_paths),
    ...(input.implementation_scope ? { implementation_scope: input.implementation_scope } : {}),
    acceptance_criteria: numberedAcceptanceCriteria(input.acceptance_criteria),
    ...(lineage ? { lineage } : {}),
    runner: input.runner,
    ...(input.validation ? { validation: input.validation } : {}),
    verification_commands: input.verification_commands,
    baseline,
    baseline_sha256: baselineSha256(baseline),
    prompt_sha256: prepared.prompt_sha256,
    prompt_byte_count: prepared.prompt_byte_count,
    created_at: prepared.run_id.match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z/)?.[0] ?? null
  }, null, 2)}\n`;
}

function renderList(title: string, values: readonly string[]): string {
  return values.length === 0 ? "" : [`## ${title}`, "", ...values.map((value) => `- ${value}`), ""].join("\n");
}

function renderAcceptance(values: readonly { id: string; criterion: string }[]): string {
  return values.length === 0 ? "" : ["## Acceptance Criteria", "", ...values.map((value) => `- ${value.id}: ${value.criterion}`), ""].join("\n");
}

function renderValidation(input: CodexTask): string {
  if (!input.validation) return "";
  return [
    "## Structured Validation", "", `- profile: ${input.validation.profile}`,
    ...input.validation.test_paths.map((path) => `- test_path: ${path}`), "",
    "Use the repository's safe validation workflow for this profile. Pass each test path separately; do not construct a shell command.", ""
  ].join("\n");
}

function renderRunner(input: CodexTask): string {
  return [
    "## Runner Handoff", "", `- mode: ${input.runner.mode}`,
    ...(input.runner.requested_runner ? [`- requested_runner: ${input.runner.requested_runner}`] : []),
    ...(input.runner.max_runtime_ms ? [`- max_runtime_ms: ${input.runner.max_runtime_ms}`] : []), "",
    "This is durable handoff metadata only. Writing this task does not queue, start, or resume a runner.", ""
  ].join("\n");
}

function renderLegacyVerification(commands: readonly string[]): string {
  if (commands.length === 0) return "";
  return ["## Legacy Verification Notes", "", ...commands.map((command) => `- ${command}`), "", "These strings are legacy instructions only. The MCP does not execute them.", ""].join("\n");
}

function renderScope(input: CodexTask): string {
  if (!input.implementation_scope || (input.implementation_scope.include.length === 0 && input.implementation_scope.exclude.length === 0)) return "";
  return [
    "## Implementation Scope", "",
    ...(input.implementation_scope.include.length > 0 ? ["Include:", ...input.implementation_scope.include.map((value) => `- ${value}`), ""] : []),
    ...(input.implementation_scope.exclude.length > 0 ? ["Exclude:", ...input.implementation_scope.exclude.map((value) => `- ${value}`), ""] : [])
  ].join("\n");
}

function renderLineage(lineage: CodexCorrectiveLineage): string[] {
  return [
    "## Corrective Review Loop", "",
    `- kind: ${lineage.kind}`,
    `- parent_run_id: ${lineage.parent_run_id}`,
    `- root_run_id: ${lineage.root_run_id}`,
    `- child_index: ${lineage.child_index}`,
    `- max_children: ${lineage.max_children}`,
    "- This child uses a fresh baseline and may preserve or narrow scope only.", ""
  ];
}
