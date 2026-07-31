import type { CodexReviewResult } from "../contracts/codex-task.contract.js";
import type { CodexRunManifest } from "./codex-run-manifest.js";
import { evaluateCodexV2RunIntegrity } from "../legacy/codex-v2/integrity.js";
import {
  bindPromptToBaseline,
  effectiveForbiddenPatterns,
  sha256Text
} from "./codex-task-policy.js";
import { renderDelegationPromptV3 } from "./delegation-v3-renderer.js";
import {
  delegationBaselineSha256V3,
  delegationTaskSha256V3
} from "./delegation-v3-normalizer.js";
import { hashCanonical } from "./product-contract-service.js";

type ArtifactPaths = { resultPath: string; resultJsonPath: string };

export function evaluateCodexRunIntegrity(
  manifest: CodexRunManifest | undefined,
  prompt: string | undefined,
  paths: ArtifactPaths
): { integrity: CodexReviewResult["integrity"]; warnings: string[] } {
  if (!manifest) {
    return {
      integrity: { manifest_found: false, manifest_bound: false, prompt_found: Boolean(prompt) },
      warnings: []
    };
  }
  if (manifest.schema_version === 1) {
    return {
      integrity: { manifest_version: 1, manifest_found: true, manifest_bound: true, prompt_found: Boolean(prompt) },
      warnings: []
    };
  }
  if (manifest.schema_version === 2) {
    return evaluateCodexV2RunIntegrity(manifest, prompt, paths);
  }

  const expectedPolicy = effectiveForbiddenPatterns(manifest.authorization.caller_forbidden_paths);
  const policyMatches = sameStringSet(expectedPolicy, manifest.authorization.effective_forbidden_paths);
  const authorizationMatches = sameStringSet(manifest.authorization.caller_scope, manifest.authorization.effective_scope)
    && sameOrderedList(manifest.task.starting_points, manifest.authorization.starting_points)
    && sameOrderedList(manifest.task.authorization_scope, manifest.authorization.caller_scope)
    && sameOrderedList(manifest.task.forbidden_paths, manifest.authorization.caller_forbidden_paths);
  const baselineMatches = delegationBaselineSha256V3(manifest.baseline) === manifest.baseline_sha256;
  const taskBindingMatches = delegationTaskSha256V3(manifest.task) === manifest.task_sha256;
  const productBindingMatches = manifest.product_binding.kind === "not_required"
    ? true
    : hashCanonical(manifest.product_binding.snapshot) === manifest.product_binding.snapshot_sha256;
  const expectedPrompt = bindPromptToBaseline(renderDelegationPromptV3({
    task: manifest.task,
    runId: manifest.run_id,
    paths,
    productBinding: manifest.product_binding,
    effectiveForbiddenPaths: manifest.authorization.effective_forbidden_paths,
    audit: manifest.delegation_audit
  }), manifest.baseline);
  const promptHashMatches = prompt === undefined ? false : sha256Text(prompt) === manifest.prompt_sha256;
  const promptByteCountMatches = prompt === undefined ? false : Buffer.byteLength(prompt, "utf8") === manifest.prompt_byte_count;
  const promptContentMatches = prompt === expectedPrompt;
  const manifestBound = policyMatches
    && authorizationMatches
    && baselineMatches
    && taskBindingMatches
    && productBindingMatches
    && promptHashMatches
    && promptByteCountMatches
    && promptContentMatches;
  const warnings: string[] = [];
  if (!prompt) warnings.push("CODEX_PROMPT_MISSING");
  if (prompt && !promptHashMatches) warnings.push("CODEX_PROMPT_HASH_MISMATCH");
  if (!policyMatches) warnings.push("CODEX_MANIFEST_POLICY_MISMATCH");
  if (!authorizationMatches) warnings.push("DELEGATION_V3_AUTHORIZATION_BINDING_MISMATCH");
  if (!baselineMatches) warnings.push("CODEX_MANIFEST_BASELINE_BINDING_MISMATCH");
  if (!taskBindingMatches) warnings.push("DELEGATION_V3_TASK_BINDING_MISMATCH");
  if (!productBindingMatches) warnings.push("DELEGATION_V3_PRODUCT_BINDING_MISMATCH");
  if (!promptContentMatches || !promptByteCountMatches) warnings.push("CODEX_MANIFEST_PROMPT_BINDING_MISMATCH");
  return {
    integrity: {
      manifest_version: 3,
      manifest_found: true,
      manifest_bound: manifestBound,
      policy_matches: policyMatches,
      prompt_found: Boolean(prompt),
      prompt_hash_matches: promptHashMatches,
      prompt_byte_count_matches: promptByteCountMatches,
      prompt_content_matches: promptContentMatches,
      baseline_matches: baselineMatches,
      task_binding_matches: taskBindingMatches,
      product_binding_matches: productBindingMatches,
      authorization_matches: authorizationMatches
    },
    warnings
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameOrderedList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
