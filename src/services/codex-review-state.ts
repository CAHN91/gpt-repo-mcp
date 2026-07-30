import type {
  CodexReviewAttestationStatus,
  CodexReviewResult,
  CodexReviewState
} from "../contracts/codex-task.contract.js";
import {
  CodexReviewAttestationAnySchema,
  type CodexReviewAttestation,
  type CodexReviewAttestationAny
} from "../contracts/codex-review-attestation.contract.js";
import type { DelegationRunManifestV3 } from "../contracts/delegation-v3.contract.js";
import { readSafeRunArtifact } from "../delegation/safe-artifact.js";
import { delegationManifestSha256V3 } from "./delegation-v3-normalizer.js";
import { sha256Text } from "./codex-task-policy.js";
import { hashCanonical } from "./product-contract-service.js";

const MAX_REVIEW_BYTES = 128 * 1024;

export function buildCodexReviewState(input: {
  manifest?: DelegationRunManifestV3;
  promptText?: string;
  resultText?: string;
  resultFound: boolean;
  gitReview?: CodexReviewResult["git_review"];
  technicalReadiness: CodexReviewResult["technical_readiness"];
  productReview: CodexReviewResult["product_review"];
  productEvidence: CodexReviewResult["product_evidence"];
  scopeEvidence: CodexReviewResult["scope_evidence"];
  technicalAcceptance: CodexReviewResult["technical_acceptance_evidence"];
  productAcceptance: CodexReviewResult["product_acceptance_evidence"];
  worktreeFingerprint?: string;
}): CodexReviewState {
  if (!input.manifest) return { status: "unavailable", reason: "legacy_run" };
  if (!input.resultFound || input.resultText === undefined) {
    return { status: "unavailable", reason: "missing_result" };
  }
  if (!input.gitReview) return { status: "unavailable", reason: "missing_git_state" };
  if (!input.worktreeFingerprint) return { status: "unavailable", reason: "missing_root" };

  const modernBinding = input.manifest.baseline.initial_path_states !== undefined;
  const changedPaths = modernBinding
    ? uniqueSorted(input.scopeEvidence.attributed_paths)
    : uniqueSorted([...input.scopeEvidence.pre_existing_paths, ...input.scopeEvidence.newly_observed_paths]);
  const scopeBinding = modernBinding
    ? {
        attributed_paths: input.scopeEvidence.attributed_paths,
        dirty_baseline_attributed_paths: input.scopeEvidence.dirty_baseline_attributed_paths,
        out_of_scope_paths: input.scopeEvidence.out_of_scope_paths,
        forbidden_paths: input.scopeEvidence.forbidden_paths,
        claimed_but_not_observed: input.scopeEvidence.claimed_but_not_observed,
        attribution_ambiguous_paths: input.scopeEvidence.attribution_ambiguous_paths
      }
    : input.scopeEvidence;
  const binding = {
    status: "available" as const,
    manifest_sha256: delegationManifestSha256V3(input.manifest),
    prompt_sha256: sha256Text(input.promptText ?? ""),
    result_sha256: sha256Text(input.resultText),
    head_sha: input.gitReview.head_sha,
    worktree_fingerprint: input.worktreeFingerprint,
    ...(modernBinding ? { binding_version: 2 as const, pathset_fingerprint: input.worktreeFingerprint } : {}),
    changed_paths: changedPaths,
    technical_readiness_sha256: hashCanonical(input.technicalReadiness),
    product_review_sha256: hashCanonical(input.productReview),
    product_evidence_sha256: hashCanonical(input.productEvidence),
    scope_evidence_sha256: hashCanonical(scopeBinding),
    technical_acceptance_sha256: hashCanonical(input.technicalAcceptance),
    product_acceptance_sha256: hashCanonical(input.productAcceptance)
  };
  return {
    ...binding,
    state_sha256: hashCanonical(binding)
  };
}

export async function inspectCodexReviewAttestation(input: {
  root: string;
  reviewPath: string;
  repoId: string;
  runId: string;
  currentState: CodexReviewState;
}): Promise<CodexReviewAttestationStatus> {
  const text = await readSafeRunArtifact(input.root, input.reviewPath, MAX_REVIEW_BYTES);
  if (text === undefined) {
    return input.currentState.status === "available"
      ? { status: "missing", review_path: input.reviewPath, reasons: ["REVIEW_ATTESTATION_MISSING"] }
      : { status: "unavailable", review_path: input.reviewPath, reasons: ["REVIEW_STATE_UNAVAILABLE"] };
  }

  let attestation: CodexReviewAttestationAny;
  try {
    attestation = CodexReviewAttestationAnySchema.parse(JSON.parse(text) as unknown);
  } catch {
    return { status: "tampered", review_path: input.reviewPath, reasons: ["REVIEW_ATTESTATION_INVALID"] };
  }
  if (attestation.repo_id !== input.repoId || attestation.run_id !== input.runId) {
    return { status: "tampered", review_path: input.reviewPath, reasons: ["REVIEW_ATTESTATION_IDENTITY_MISMATCH"] };
  }
  if (attestation.review_sha256 !== codexReviewAttestationAnySha256(attestation)) {
    return { status: "tampered", review_path: input.reviewPath, reasons: ["REVIEW_ATTESTATION_HASH_MISMATCH"] };
  }
  const summary = {
    review_path: input.reviewPath,
    verdict: attestation.product_verdict,
    reviewed_at: attestation.reviewed_at,
    review_sha256: attestation.review_sha256,
    rationale: attestation.rationale,
    evidence: attestation.evidence
  };
  if (input.currentState.status !== "available") {
    return { status: "stale", ...summary, reasons: ["REVIEW_STATE_UNAVAILABLE"] };
  }
  if (
    attestation.binding.state_sha256 !== input.currentState.state_sha256
    || hashCanonical(attestation.binding) !== hashCanonical(input.currentState)
  ) {
    return { status: "stale", ...summary, reasons: ["REVIEW_STATE_CHANGED"] };
  }
  return { status: "valid", ...summary, reasons: [] };
}

export function codexReviewAttestationSha256(attestation: CodexReviewAttestation): string {
  const unsigned = { ...attestation } as Partial<CodexReviewAttestation>;
  delete unsigned.review_sha256;
  return hashCanonical(unsigned);
}

export function codexReviewAttestationAnySha256(attestation: CodexReviewAttestationAny): string {
  const unsigned = { ...attestation } as Partial<CodexReviewAttestationAny>;
  delete unsigned.review_sha256;
  return hashCanonical(unsigned);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
