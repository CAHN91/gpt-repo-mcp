import {
  DelegationResultV3Schema,
  DelegationRunManifestV3Schema,
  DelegationTaskV3InputSchema,
  DelegationTaskV3Schema,
  type DelegationLineageV3,
  type DelegationProductBindingV3,
  type DelegationResultV3,
  type DelegationRunManifestV3,
  type DelegationTaskV3,
  type DelegationTaskV3Input
} from "../contracts/delegation-v3.contract.js";
import type { ProductContextSelectionResult } from "../contracts/product-contract.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { hashCanonical } from "./product-contract-service.js";

export function normalizeDelegationTaskV3(rawInput: DelegationTaskV3Input): DelegationTaskV3 {
  return normalizeDelegationTaskV3Internal(rawInput);
}

export function normalizeDelegationTaskV3WithLineage(
  rawInput: DelegationTaskV3Input,
  resolvedLineage: DelegationLineageV3
): DelegationTaskV3 {
  return normalizeDelegationTaskV3Internal(rawInput, resolvedLineage);
}

function normalizeDelegationTaskV3Internal(
  rawInput: DelegationTaskV3Input,
  resolvedLineage?: DelegationLineageV3
): DelegationTaskV3 {
  const input = DelegationTaskV3InputSchema.parse(rawInput);
  if (input.lineage && !resolvedLineage) {
    throw validationError("Delegation v3 lineage must be resolved and integrity-bound by the server.");
  }
  if (!input.lineage && resolvedLineage) {
    throw validationError("Resolved Delegation v3 lineage requires caller lineage input.");
  }
  const common = {
    repo_id: input.repo_id,
    title: normalizeText(input.title),
    task_kind: input.task_kind,
    assignment: normalizeText(input.assignment),
    outcome: {
      beneficiary: normalizeText(input.outcome.beneficiary),
      current_problem: normalizeText(input.outcome.current_problem),
      desired_outcome: normalizeText(input.outcome.desired_outcome),
      why_now: normalizeText(input.outcome.why_now)
    },
    ...(input.relevant_context ? { relevant_context: normalizeText(input.relevant_context) } : {}),
    starting_points: [...input.starting_points],
    authorization_scope: [...input.authorization_scope],
    forbidden_paths: [...input.forbidden_paths],
    hard_constraints: normalizeTextList(input.hard_constraints),
    must_preserve: normalizeTextList(input.must_preserve),
    explicit_exclusions: normalizeTextList(input.explicit_exclusions),
    technical_acceptance_criteria: normalizeCriteria(input.technical_acceptance_criteria, "TAC"),
    ...(input.validation ? { validation: input.validation } : {}),
    runner: input.runner,
    ...(resolvedLineage ? { lineage: resolvedLineage } : {}),
    ...(input.run_id ? { run_id: input.run_id } : {})
  };

  if (input.task_kind === "product_slice" || input.task_kind === "product_correction") {
    return DelegationTaskV3Schema.parse({
      ...common,
      product_alignment: {
        primary_user_id: input.product_alignment.primary_user_id,
        job_ids: [...input.product_alignment.job_ids],
        user_problem: normalizeText(input.product_alignment.user_problem),
        product_goal: normalizeText(input.product_alignment.product_goal),
        additional_must_not_become: normalizeTextList(input.product_alignment.additional_must_not_become),
        product_acceptance_criteria: normalizeCriteria(input.product_alignment.product_acceptance_criteria, "PAC")
      }
    });
  }

  if (input.task_kind === "technical_infrastructure") {
    return DelegationTaskV3Schema.parse({
      ...common,
      technical_context: {
        enabling_value: normalizeText(input.technical_context.enabling_value)
      }
    });
  }

  if ("security_context" in input) {
    return DelegationTaskV3Schema.parse({
      ...common,
      security_context: {
        protected_contract: normalizeText(input.security_context.protected_contract),
        failure_risk: normalizeText(input.security_context.failure_risk)
      }
    });
  }

  throw validationError("Delegation task kind could not be normalized.");
}

export function reviewRequirementForDelegationTaskV3(task: DelegationTaskV3): "product_required" | "technical_only" {
  return task.task_kind === "product_slice" || task.task_kind === "product_correction"
    ? "product_required"
    : "technical_only";
}

export function buildDelegationProductBindingV3(
  task: DelegationTaskV3,
  selection?: ProductContextSelectionResult
): DelegationProductBindingV3 {
  const productTask = task.task_kind === "product_slice" || task.task_kind === "product_correction";
  if (!productTask) {
    if (selection) {
      throw validationError("Technical delegation tasks cannot carry selected product binding in v3.");
    }
    return { kind: "not_required" };
  }
  if (!selection || !("product_alignment" in task)) {
    throw validationError("Product delegation tasks require a selected repository product context.");
  }
  if (selection.snapshot_sha256 !== hashCanonical(selection.snapshot)) {
    throw validationError("Selected product snapshot hash does not match its normalized content.");
  }
  if (selection.snapshot.primary_user.id !== task.product_alignment.primary_user_id) {
    throw validationError("Selected product user does not match the task product alignment.");
  }
  const selectedJobs = selection.snapshot.jobs_to_be_done.map(({ id }) => id);
  if (!sameSet(selectedJobs, task.product_alignment.job_ids)) {
    throw validationError("Selected product jobs do not match the task product alignment.");
  }
  return {
    kind: "selected",
    source_path: selection.source_path,
    contract_sha256: selection.contract_sha256,
    snapshot_sha256: selection.snapshot_sha256,
    snapshot: selection.snapshot
  };
}

export function delegationTaskSha256V3(task: DelegationTaskV3): string {
  return hashCanonical(task);
}

export function delegationBaselineSha256V3(baseline: DelegationRunManifestV3["baseline"]): string {
  return hashCanonical({
    head_sha: baseline.head_sha,
    worktree_fingerprint: baseline.worktree_fingerprint,
    initial_changed_paths: [...baseline.initial_changed_paths].sort((left, right) => left.localeCompare(right)),
    ...(baseline.initial_path_states ? {
      initial_path_states: [...baseline.initial_path_states].sort((left, right) => left.path.localeCompare(right.path))
    } : {})
  });
}

export function delegationManifestSha256V3(manifest: DelegationRunManifestV3): string {
  return hashCanonical(parseDelegationManifestV3(manifest));
}

export function parseDelegationManifestV3(value: unknown): DelegationRunManifestV3 {
  const manifest = DelegationRunManifestV3Schema.parse(value);
  if (manifest.task_sha256 !== delegationTaskSha256V3(manifest.task)) {
    throw validationError("Delegation v3 manifest task hash does not match the normalized task.");
  }
  if (manifest.baseline_sha256 !== delegationBaselineSha256V3(manifest.baseline)) {
    throw validationError("Delegation v3 manifest baseline hash does not match the normalized baseline.");
  }
  if (manifest.product_binding.kind === "selected" && manifest.product_binding.snapshot_sha256 !== hashCanonical(manifest.product_binding.snapshot)) {
    throw validationError("Delegation v3 manifest product snapshot hash does not match the selected snapshot.");
  }
  return manifest;
}

export function delegationConnectedChangePaths(result: Pick<DelegationResultV3, "connected_changes">): string[] {
  return result.connected_changes.flatMap((entry) => "path" in entry ? [entry.path] : entry.paths);
}

export function parseDelegationResultV3(text: string, repoId: string, runId: string): DelegationResultV3 {
  return parseDelegationResultV3WithWarnings(text, repoId, runId).result;
}

export function parseDelegationResultV3WithWarnings(
  text: string,
  repoId: string,
  runId: string
): { result: DelegationResultV3; warnings: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw validationError("Invalid JSON in Delegation v3 RESULT.json.");
  }
  const compatible = normalizeDelegationResultV3Compatibility(value);
  const result = DelegationResultV3Schema.parse(compatible.value);
  if (result.repo_id !== repoId || result.run_id !== runId) {
    throw validationError("Delegation v3 RESULT.json repo_id or run_id does not match the requested run.");
  }
  return { result, warnings: compatible.warnings };
}

function normalizeDelegationResultV3Compatibility(value: unknown): { value: unknown; warnings: string[] } {
  if (!isRecord(value)) return { value, warnings: [] };
  const normalized: Record<string, unknown> = { ...value };
  let replacedVerified = false;
  for (const field of ["product_acceptance_criteria", "technical_acceptance_criteria"] as const) {
    const entries = value[field];
    if (!Array.isArray(entries)) continue;
    normalized[field] = entries.map((entry) => {
      if (!isRecord(entry) || entry.status !== "verified") return entry;
      replacedVerified = true;
      return { ...entry, status: "passed" };
    });
  }
  return {
    value: normalized,
    warnings: replacedVerified ? ["DELEGATION_V3_STATUS_VERIFIED_NORMALIZED"] : []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCriteria(
  input: readonly (string | { id?: string; criterion: string })[],
  prefix: "PAC" | "TAC"
): Array<{ id: string; criterion: string }> {
  const explicitIds = input.flatMap((entry) => typeof entry === "string" || !entry.id ? [] : [entry.id]);
  if (new Set(explicitIds).size !== explicitIds.length) {
    throw validationError(`Duplicate explicit ${prefix} criterion ids are not allowed.`);
  }
  const used = new Set(explicitIds);
  let next = 1;
  return input.map((entry) => {
    const criterion = normalizeText(typeof entry === "string" ? entry : entry.criterion);
    if (typeof entry !== "string" && entry.id) {
      return { id: entry.id, criterion };
    }
    while (used.has(`${prefix}-${next}`)) next += 1;
    const id = `${prefix}-${next}`;
    used.add(id);
    next += 1;
    return { id, criterion };
  });
}

function normalizeText(value: string): string {
  return value.trim();
}

function normalizeTextList(values: readonly string[]): string[] {
  return values.map(normalizeText);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function validationError(message: string): RepoReaderError {
  return new RepoReaderError("VALIDATION_ERROR", message);
}
