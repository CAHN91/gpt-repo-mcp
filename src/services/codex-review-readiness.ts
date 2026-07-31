import type {
  CodexParsedResult,
  CodexReviewResult,
  CodexTechnicalReadiness
} from "../contracts/codex-task.contract.js";
import type { CodexRunManifest } from "./codex-run-manifest.js";

type GitReview = NonNullable<CodexReviewResult["git_review"]>;
type CheckStatus = CodexTechnicalReadiness["checks"][keyof CodexTechnicalReadiness["checks"]];

export function applyCodexReviewReadiness(input: {
  integrity: CodexReviewResult["integrity"];
  scope: CodexReviewResult["scope_evidence"];
  acceptance: CodexReviewResult["acceptance_evidence"];
  technicalAcceptance: CodexReviewResult["technical_acceptance_evidence"];
  status: CodexParsedResult["status"];
  resultFound: boolean;
  connectedChangesComplete: boolean;
  manifest: CodexRunManifest | undefined;
  gitReview: GitReview;
}): {
  gitReview: GitReview;
  suppressHappyPath: boolean;
  warnings: string[];
  technicalReadiness: CodexTechnicalReadiness;
} {
  const technicalReadiness = evaluateCodexTechnicalReadiness({
    integrity: input.integrity,
    scope: input.scope,
    technicalAcceptance: input.technicalAcceptance,
    status: input.status,
    resultFound: input.resultFound,
    connectedChangesComplete: input.connectedChangesComplete,
    manifest: input.manifest,
    gitReview: input.gitReview
  });
  const warnings = [
    ...scopeWarnings(input.scope),
    ...acceptanceWarnings(input.acceptance),
    ...technicalReadinessWarnings(technicalReadiness)
  ];
  const v3AttestationRequired = input.manifest?.schema_version === 3;
  const suppressHappyPath = v3AttestationRequired || technicalReadiness.status !== "passed";
  if (v3AttestationRequired) warnings.push("DELEGATION_V3_REVIEW_ATTESTATION_REQUIRED");
  if (suppressHappyPath) warnings.push("CODEX_HAPPY_PATH_PAYLOADS_SUPPRESSED");
  return {
    suppressHappyPath,
    technicalReadiness,
    gitReview: suppressHappyPath ? withoutHappyPathPayloads(input.gitReview) : input.gitReview,
    warnings: [...new Set(warnings)]
  };
}

export function evaluateCodexTechnicalReadiness(input: {
  integrity: CodexReviewResult["integrity"];
  scope: CodexReviewResult["scope_evidence"];
  technicalAcceptance: CodexReviewResult["technical_acceptance_evidence"];
  status: CodexParsedResult["status"] | undefined;
  resultFound: boolean;
  connectedChangesComplete: boolean;
  manifest: CodexRunManifest | undefined;
  gitReview?: GitReview;
}): CodexTechnicalReadiness {
  if (!input.manifest || input.manifest.schema_version === 1) {
    return {
      status: "unavailable",
      deterministic: true,
      checks: unavailableChecks(input.resultFound),
      blocking_reasons: [],
      incomplete_reasons: ["TECHNICAL_READINESS_UNAVAILABLE_FOR_LEGACY_RUN"]
    };
  }

  const validationRequested = input.manifest.schema_version === 3
    ? Boolean(input.manifest.task.validation)
    : Boolean(input.manifest.validation);
  const checks: CodexTechnicalReadiness["checks"] = {
    integrity: input.integrity.manifest_bound ? "passed" : "failed",
    baseline: input.integrity.head_matches_baseline === true
      ? "passed"
      : input.integrity.head_matches_baseline === false ? "failed" : "incomplete",
    authorization: input.manifest.schema_version === 3
      ? input.integrity.authorization_matches === true ? "passed" : "failed"
      : input.integrity.manifest_bound ? "passed" : "failed",
    result_contract: input.resultFound ? "passed" : "incomplete",
    result_status: !input.resultFound
      ? "incomplete"
      : input.status === "completed" ? "passed" : "failed",
    scope: !input.gitReview
      ? "incomplete"
      : input.scope.out_of_scope_paths.length > 0 || input.scope.forbidden_paths.length > 0
        ? "failed"
        : "passed",
    change_attribution: !input.gitReview
      ? "incomplete"
      : input.scope.claimed_but_not_observed.length > 0 || input.scope.observed_but_unreported.length > 0
        ? "failed"
        : input.scope.attribution_ambiguous_paths.length > 0 ? "incomplete" : "passed",
    connected_changes: input.manifest.schema_version === 3
      ? !input.resultFound ? "incomplete" : input.connectedChangesComplete ? "passed" : "failed"
      : "not_applicable",
    technical_acceptance: technicalAcceptanceStatus(input.technicalAcceptance, input.resultFound),
    validation: validationStatus(validationRequested, input.gitReview)
  };
  const blockingReasons = reasonCodes(checks, "failed");
  const incompleteReasons = reasonCodes(checks, "incomplete");
  const status = blockingReasons.length > 0
    ? "failed"
    : incompleteReasons.length > 0 ? "incomplete" : "passed";
  return {
    status,
    deterministic: true,
    checks,
    blocking_reasons: blockingReasons,
    incomplete_reasons: incompleteReasons
  };
}

function unavailableChecks(resultFound: boolean): CodexTechnicalReadiness["checks"] {
  return {
    integrity: "unavailable",
    baseline: "unavailable",
    authorization: "unavailable",
    result_contract: resultFound ? "passed" : "incomplete",
    result_status: resultFound ? "unavailable" : "incomplete",
    scope: "unavailable",
    change_attribution: "unavailable",
    connected_changes: "not_applicable",
    technical_acceptance: "unavailable",
    validation: "unavailable"
  };
}

function technicalAcceptanceStatus(
  evidence: CodexReviewResult["technical_acceptance_evidence"],
  resultFound: boolean
): CheckStatus {
  if (!resultFound) return "incomplete";
  if (!evidence.binding_available) return "unavailable";
  if (evidence.failed_ids.length > 0 || evidence.unknown_ids.length > 0 || evidence.duplicate_ids.length > 0) return "failed";
  if (evidence.missing_ids.length > 0 || evidence.unverified_ids.length > 0 || !evidence.complete) return "incomplete";
  return evidence.all_passed ? "passed" : "incomplete";
}

function validationStatus(validationRequested: boolean, gitReview: GitReview | undefined): CheckStatus {
  if (!validationRequested) return "not_applicable";
  if (!gitReview) return "incomplete";
  const status = gitReview.ship_readiness.validation.status;
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  return "incomplete";
}

function reasonCodes(checks: CodexTechnicalReadiness["checks"], status: "failed" | "incomplete"): string[] {
  return Object.entries(checks)
    .filter(([, value]) => value === status)
    .map(([key]) => `${status === "failed" ? "TECHNICAL_CHECK_FAILED" : "TECHNICAL_CHECK_INCOMPLETE"}:${key}`);
}

function technicalReadinessWarnings(readiness: CodexTechnicalReadiness): string[] {
  if (readiness.status === "passed") return [];
  if (readiness.status === "unavailable") return ["CODEX_TECHNICAL_READINESS_UNAVAILABLE"];
  if (readiness.status === "incomplete") return ["CODEX_TECHNICAL_READINESS_INCOMPLETE"];
  return ["CODEX_TECHNICAL_READINESS_FAILED"];
}

function scopeWarnings(scope: CodexReviewResult["scope_evidence"]): string[] {
  const warnings: string[] = [];
  if (scope.out_of_scope_paths.length > 0) warnings.push("CODEX_SCOPE_OUT_OF_SCOPE_PATHS");
  if (scope.forbidden_paths.length > 0) warnings.push("CODEX_SCOPE_FORBIDDEN_PATHS");
  if (scope.claimed_but_not_observed.length > 0 || scope.observed_but_unreported.length > 0) warnings.push("CODEX_RESULT_CLAIM_MISMATCH");
  if (scope.attribution_ambiguous_paths.length > 0) warnings.push("CODEX_PREEXISTING_PATH_ATTRIBUTION_AMBIGUOUS");
  return warnings;
}

function acceptanceWarnings(evidence: CodexReviewResult["acceptance_evidence"]): string[] {
  if (!evidence.binding_available) return [];
  const warnings: string[] = [];
  if (evidence.unknown_ids.length > 0) warnings.push("CODEX_ACCEPTANCE_UNKNOWN_IDS");
  if (evidence.duplicate_ids.length > 0) warnings.push("CODEX_ACCEPTANCE_DUPLICATE_IDS");
  if (evidence.missing_ids.length > 0) warnings.push("CODEX_ACCEPTANCE_MISSING_IDS");
  if (evidence.failed_ids.length > 0) warnings.push("CODEX_ACCEPTANCE_FAILED");
  if (evidence.unverified_ids.length > 0) warnings.push("CODEX_ACCEPTANCE_UNVERIFIED");
  return warnings;
}

function withoutHappyPathPayloads(gitReview: GitReview): GitReview {
  const nextToolPayloads = { ...gitReview.next_tool_payloads };
  delete nextToolPayloads.repo_write_stage_commit;
  delete nextToolPayloads.repo_write_commit;
  delete nextToolPayloads.repo_write_stage_dry_run;
  delete nextToolPayloads.repo_write_stage_actual;
  delete nextToolPayloads.repo_write_stage_commit_dry_run;
  delete nextToolPayloads.repo_write_stage_commit_actual;
  delete nextToolPayloads.repo_write_commit_dry_run;
  return {
    ...gitReview,
    recommendation: { ...gitReview.recommendation, ready_to_stage: false, recommended_stage_paths: [] },
    next_tool_payloads: nextToolPayloads
  };
}
