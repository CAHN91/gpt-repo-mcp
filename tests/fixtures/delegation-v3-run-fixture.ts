import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DelegationResultV3Schema,
  DelegationRunManifestV3Schema,
  type DelegationResultV3,
  type DelegationRunManifestV3,
  type DelegationTaskV3Input
} from "../../src/contracts/delegation-v3.contract.js";
import { auditDelegationTaskV3 } from "../../src/services/delegation-v3-audit.js";
import {
  buildDelegationProductBindingV3,
  delegationBaselineSha256V3,
  delegationTaskSha256V3,
  normalizeDelegationTaskV3
} from "../../src/services/delegation-v3-normalizer.js";
import { renderDelegationPromptV3 } from "../../src/services/delegation-v3-renderer.js";
import { codexRunPaths } from "../../src/services/codex-run-paths.js";
import {
  bindPromptToBaseline,
  effectiveForbiddenPatterns,
  sha256Text,
  type CodexBaseline
} from "../../src/services/codex-task-policy.js";
import {
  productSelection,
  productTaskInput,
  technicalTaskInput
} from "./delegation-v3-fixtures.js";

export const DELEGATION_V3_BASELINE_HEAD = "a".repeat(40);
export const DELEGATION_V3_BASELINE_FINGERPRINT = "clean";

export type QueuedV3RunOptions = {
  runner?: "codex_sdk" | "opencode_sdk";
  task_kind?: "technical_infrastructure" | "product_slice" | "product_correction";
  max_runtime_ms?: number;
  validation?: DelegationTaskV3Input["validation"] | null;
  authorization_scope?: string[];
  forbidden_paths?: string[];
  baseline?: CodexBaseline;
  created_at?: string;
};

export async function writeQueuedV3Run(
  root: string,
  runId: string,
  options: QueuedV3RunOptions = {}
): Promise<DelegationRunManifestV3> {
  const kind = options.task_kind ?? "technical_infrastructure";
  const baseInput = kind === "technical_infrastructure"
    ? technicalTaskInput()
    : productTaskInput(kind);
  const input = {
    ...baseInput,
    run_id: runId,
    authorization_scope: options.authorization_scope ?? ["src/**"],
    forbidden_paths: options.forbidden_paths ?? [],
    ...(options.validation === null
      ? { validation: undefined }
      : options.validation
        ? { validation: options.validation }
        : { validation: { profile: "test" as const, test_paths: [] } }),
    runner: {
      mode: "queued" as const,
      requested_runner: options.runner ?? "codex_sdk" as const,
      ...(options.max_runtime_ms === undefined ? {} : { max_runtime_ms: options.max_runtime_ms })
    }
  } satisfies DelegationTaskV3Input;
  const task = normalizeDelegationTaskV3(input);
  const productBinding = "product_alignment" in task
    ? buildDelegationProductBindingV3(task, productSelection())
    : buildDelegationProductBindingV3(task);
  const audit = auditDelegationTaskV3(task, productBinding, "advisory");
  const baseline = options.baseline ?? {
    head_sha: DELEGATION_V3_BASELINE_HEAD,
    worktree_fingerprint: DELEGATION_V3_BASELINE_FINGERPRINT,
    initial_changed_paths: []
  };
  const paths = codexRunPaths(runId);
  const effectiveForbidden = effectiveForbiddenPatterns(task.forbidden_paths);
  const prompt = bindPromptToBaseline(renderDelegationPromptV3({
    task,
    runId,
    paths,
    productBinding,
    effectiveForbiddenPaths: effectiveForbidden,
    audit
  }), baseline);
  const manifest = DelegationRunManifestV3Schema.parse({
    schema_version: 3,
    repo_id: task.repo_id,
    run_id: runId,
    title: task.title,
    task_kind: task.task_kind,
    task,
    prompt_path: paths.promptPath,
    result_json_path: paths.resultJsonPath,
    manifest_path: paths.manifestPath,
    product_binding: productBinding,
    review_requirement: "product_alignment" in task ? "product_required" : "technical_only",
    delegation_audit: audit,
    authorization: {
      starting_points: task.starting_points,
      caller_scope: task.authorization_scope,
      effective_scope: task.authorization_scope,
      caller_forbidden_paths: task.forbidden_paths,
      effective_forbidden_paths: effectiveForbidden
    },
    baseline,
    baseline_sha256: delegationBaselineSha256V3(baseline),
    task_sha256: delegationTaskSha256V3(task),
    prompt_sha256: sha256Text(prompt),
    prompt_byte_count: Buffer.byteLength(prompt, "utf8"),
    created_at: options.created_at ?? "2026-07-19T00:00:00.000Z"
  });
  await mkdir(join(root, paths.runDir), { recursive: true });
  await writeFile(join(root, paths.promptPath), prompt, "utf8");
  await writeFile(join(root, paths.manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export type V3ResultOptions = {
  status?: "completed" | "blocked";
  changed_files?: string[];
  blockers?: string[];
  scope_extension_required?: DelegationResultV3["scope_extension_required"];
  product_status?: "passed" | "failed" | "unverified";
  technical_status?: "passed" | "failed" | "unverified";
  omit_product_ids?: string[];
  omit_technical_ids?: string[];
  extra_product_id?: string;
  extra_technical_id?: string;
  connected_changes?: DelegationResultV3["connected_changes"];
};

export async function writeV3Result(
  root: string,
  runId: string,
  options: V3ResultOptions = {}
): Promise<DelegationResultV3> {
  const paths = codexRunPaths(runId);
  const manifest = DelegationRunManifestV3Schema.parse(
    JSON.parse(await readFile(join(root, paths.manifestPath), "utf8"))
  );
  const changedFiles = options.changed_files ?? [];
  const productIds = "product_alignment" in manifest.task
    ? manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => id)
    : [];
  const technicalIds = manifest.task.technical_acceptance_criteria.map(({ id }) => id);
  const productEntries = productIds
    .filter((id) => !(options.omit_product_ids ?? []).includes(id))
    .map((id) => ({
      id,
      status: options.product_status ?? "passed" as const,
      evidence: "Bound product evidence."
    }));
  const technicalEntries = technicalIds
    .filter((id) => !(options.omit_technical_ids ?? []).includes(id))
    .map((id) => ({
      id,
      status: options.technical_status ?? "passed" as const,
      evidence: "Bound technical evidence."
    }));
  if (options.extra_product_id) {
    productEntries.push({ id: options.extra_product_id, status: "passed", evidence: "Unexpected evidence." });
  }
  if (options.extra_technical_id) {
    technicalEntries.push({ id: options.extra_technical_id, status: "passed", evidence: "Unexpected evidence." });
  }
  const status = options.status ?? "completed";
  const result = DelegationResultV3Schema.parse({
    schema_version: 3,
    repo_id: manifest.repo_id,
    run_id: manifest.run_id,
    status,
    summary: status === "completed" ? "Implemented and verified." : "Blocked with structured evidence.",
    changed_files: changedFiles,
    connected_changes: options.connected_changes ?? changedFiles.map((path) => ({
      path,
      reason: "This connected change was required for the declared outcome."
    })),
    commands_run: [],
    tests: [],
    product_acceptance_criteria: productEntries,
    technical_acceptance_criteria: technicalEntries,
    scope_extension_required: options.scope_extension_required ?? [],
    blockers: options.blockers ?? (status === "blocked" && (options.scope_extension_required?.length ?? 0) === 0
      ? ["Runner cannot complete inside the current authorization boundary."]
      : []),
    followups: []
  });
  await writeFile(join(root, paths.resultJsonPath), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export function runnerStatusBinding(
  runId: string,
  manifestVersion: 1 | 2 | 3 = 1,
  reviewRequirement: "product_required" | "technical_only" = "technical_only"
) {
  const paths = codexRunPaths(runId);
  return {
    manifest_version: manifestVersion,
    review_requirement: manifestVersion === 3 ? reviewRequirement : "legacy_unavailable" as const,
    prompt_path: paths.promptPath,
    ...(manifestVersion === 3 ? {} : { legacy_result_path: paths.resultPath }),
    result_json_path: paths.resultJsonPath
  };
}
