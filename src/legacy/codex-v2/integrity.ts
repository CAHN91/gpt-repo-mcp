import type { CodexTask, CodexReviewResult } from "../../contracts/codex-task.contract.js";
import type { CodexRunManifestV2 } from "./manifest.js";
import {
  baselineSha256,
  bindPromptToBaseline,
  effectiveForbiddenPatterns,
  sha256Text
} from "../../services/codex-task-policy.js";
import { renderCodexPrompt } from "./renderer.js";

type ArtifactPaths = { resultPath: string; resultJsonPath: string };

export function evaluateCodexV2RunIntegrity(
  manifest: CodexRunManifestV2,
  prompt: string | undefined,
  paths: ArtifactPaths
): { integrity: CodexReviewResult["integrity"]; warnings: string[] } {
  const expectedPolicy = effectiveForbiddenPatterns(manifest.caller_forbidden_paths);
  const policyMatches = sameStringSet(expectedPolicy, manifest.effective_forbidden_paths);
  const expectedBaselineSha = baselineSha256(manifest.baseline);
  const baselineMatches = expectedBaselineSha === manifest.baseline_sha256;
  const expectedPrompt = bindPromptToBaseline(renderCodexPrompt(
    manifestTask(manifest),
    manifest.run_id,
    paths,
    {
      includeRunner: manifest.runner !== undefined,
      ...(manifest.lineage ? { lineage: manifest.lineage } : {})
    }
  ), manifest.baseline);
  const promptHashMatches = prompt === undefined ? false : sha256Text(prompt) === manifest.prompt_sha256;
  const promptByteCountMatches = prompt === undefined ? false : Buffer.byteLength(prompt, "utf8") === manifest.prompt_byte_count;
  const promptContentMatches = prompt === expectedPrompt;
  const manifestBound = policyMatches && baselineMatches && promptHashMatches && promptByteCountMatches && promptContentMatches;
  const warnings: string[] = [];
  if (!prompt) warnings.push("CODEX_PROMPT_MISSING");
  if (prompt && !promptHashMatches) warnings.push("CODEX_PROMPT_HASH_MISMATCH");
  if (!policyMatches) warnings.push("CODEX_MANIFEST_POLICY_MISMATCH");
  if (!baselineMatches) warnings.push("CODEX_MANIFEST_BASELINE_BINDING_MISMATCH");
  if (!promptContentMatches || !promptByteCountMatches) warnings.push("CODEX_MANIFEST_PROMPT_BINDING_MISMATCH");
  return {
    integrity: {
      manifest_version: 2,
      manifest_found: true,
      manifest_bound: manifestBound,
      policy_matches: policyMatches,
      prompt_found: Boolean(prompt),
      prompt_hash_matches: promptHashMatches,
      prompt_byte_count_matches: promptByteCountMatches,
      prompt_content_matches: promptContentMatches,
      baseline_matches: baselineMatches
    },
    warnings
  };
}

function manifestTask(manifest: CodexRunManifestV2): CodexTask {
  return {
    repo_id: manifest.repo_id,
    title: manifest.title,
    objective: manifest.objective,
    ...(manifest.context_summary ? { context_summary: manifest.context_summary } : {}),
    inspect_first: manifest.inspect_first,
    allowed_paths: manifest.allowed_paths,
    forbidden_paths: manifest.caller_forbidden_paths,
    ...(manifest.implementation_scope ? { implementation_scope: manifest.implementation_scope } : {}),
    acceptance_criteria: manifest.acceptance_criteria,
    ...(manifest.validation ? { validation: manifest.validation } : {}),
    runner: manifest.runner ?? { mode: "manual" },
    verification_commands: manifest.verification_commands,
    run_id: manifest.run_id
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
