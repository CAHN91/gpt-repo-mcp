import type { FailureDiagnoseInput, FailureDiagnoseResult } from "../contracts/failure-diagnose.contract.js";
import type { GitReviewInput, GitReviewResult } from "../contracts/git-review.contract.js";
import type { SemanticReviewInput, SemanticReviewResult } from "../contracts/semantic-review.contract.js";
import type { ShipReviewReason, ShipReviewResult, ShipReviewToolInput } from "../contracts/ship-review.contract.js";

export type ShipReviewDependencies = {
  gitReview: { review(input: GitReviewInput): Promise<GitReviewResult> };
  semanticReview: { review(input: SemanticReviewInput): Promise<SemanticReviewResult> };
  failureDiagnose: { diagnose(input: FailureDiagnoseInput): Promise<FailureDiagnoseResult> };
};

const REVIEW_LOOP = {
  max_corrective_children: 2 as const,
  scope_policy: "preserve_or_narrow" as const,
  instructions: [
    "Use repo_codex_review for the terminal Delegation v3 result before ship decisions.",
    "Record the state-bound product or technical attestation through repo_write_codex_review.",
    "Run repo_ship_review only after attestation; it combines semantic, validation, Git, and delegation-gate readiness.",
    "Corrective children remain baseline-bound and scope amendments require structured evidence."
  ]
};

export class ShipReviewService {
  constructor(private readonly dependencies: ShipReviewDependencies) {}

  async review(input: ShipReviewToolInput): Promise<ShipReviewResult> {
    const detail = input.detail ?? "compact";
    const semanticInput: SemanticReviewInput = {
      repo_id: input.repo_id,
      ...(input.paths ? { paths: input.paths } : {}),
      ...(input.categories ? { categories: input.categories } : {}),
      ...(input.max_findings ? { max_findings: input.max_findings } : {}),
      ...(input.max_files ? { max_files: input.max_files } : {})
    };
    const [gitReview, semanticReview] = await Promise.all([
      this.dependencies.gitReview.review({
        repo_id: input.repo_id,
        mode: "commit_plan",
        detail,
        paths: input.paths,
        max_files: input.max_files
      }),
      this.dependencies.semanticReview.review(semanticInput)
    ]);
    const validation = gitReview.ship_readiness.validation;
    const failureDiagnosis = validation.status === "failed"
      ? await this.dependencies.failureDiagnose.diagnose({ repo_id: input.repo_id, scope_paths: input.paths })
      : undefined;
    const reasons = readinessReasons(gitReview, semanticReview, input.run_id);
    const ready = reasons.length === 0;
    const compactGitReview = detail === "compact"
      ? {
          ...gitReview,
          next_tool_payloads: {
            ...(gitReview.next_tool_payloads.repo_write_recover
              ? { repo_write_recover: gitReview.next_tool_payloads.repo_write_recover }
              : {})
          }
        }
      : gitReview;
    return {
      ok: true,
      detail,
      repo_id: input.repo_id,
      ...(input.run_id ? { run_id: input.run_id } : {}),
      git_review: compactGitReview,
      ...(detail === "full" ? { delegation_gate: gitReview.delegation_gate } : {}),
      semantic_review: semanticReview,
      ...(failureDiagnosis ? { failure_diagnosis: failureDiagnosis } : {}),
      ship_readiness: {
        status: ready ? "ready" : "review_required",
        reasons,
        validation_status: validation.status,
        blocking_finding_ids: semanticReview.ship_readiness.blocking_finding_ids,
        diagnosis_included: Boolean(failureDiagnosis)
      },
      next_tool_payloads: {
        ...(validation.status !== "passed" || validation.focused
          ? { repo_validate: { repo_id: input.repo_id, profile: "all" as const } }
          : {}),
        ...(ready && gitReview.next_tool_payloads.repo_write_stage_commit
          ? { repo_write_stage_commit: gitReview.next_tool_payloads.repo_write_stage_commit }
          : {}),
        ...(ready && gitReview.next_tool_payloads.repo_write_commit
          ? { repo_write_commit: gitReview.next_tool_payloads.repo_write_commit }
          : {}),
        ...(detail === "full" && ready && gitReview.next_tool_payloads.repo_write_commit_dry_run
          ? { repo_write_commit_dry_run: gitReview.next_tool_payloads.repo_write_commit_dry_run }
          : {})
      },
      ...(detail === "full" ? { review_loop: REVIEW_LOOP } : {}),
      truncated: gitReview.diff_summary.truncated || semanticReview.truncated || Boolean(failureDiagnosis?.truncated),
      warnings: [...new Set([
        ...gitReview.recommendation.warnings,
        ...gitReview.delegation_gate.warnings,
        ...semanticReview.warnings,
        ...(failureDiagnosis?.warnings ?? [])
      ])].sort()
    };
  }
}

function readinessReasons(
  gitReview: GitReviewResult,
  semanticReview: SemanticReviewResult,
  requestedRunId?: string
): ShipReviewReason[] {
  const reasons = new Set<ShipReviewReason>();
  const validation = gitReview.ship_readiness.validation;
  if (semanticReview.ship_readiness.status === "review_required") reasons.add("SEMANTIC_REVIEW_REQUIRED");
  if (validation.status === "failed") reasons.add("VALIDATION_FAILED");
  if (validation.status === "missing") reasons.add("VALIDATION_MISSING");
  if (validation.status === "stale") reasons.add("VALIDATION_STALE");
  if (validation.focused) reasons.add("VALIDATION_FOCUSED");
  if (gitReview.recommendation.risk_level === "high") reasons.add("GIT_REVIEW_HIGH_RISK");
  if (
    !gitReview.clean
    && gitReview.recommendation.ready_to_stage
    && !gitReview.next_tool_payloads.repo_write_stage_commit
    && !gitReview.next_tool_payloads.repo_write_commit
  ) {
    reasons.add("GIT_CANONICAL_SHIP_PAYLOAD_UNAVAILABLE");
  }
  if (gitReview.delegation_gate.status === "blocked") {
    reasons.add("DELEGATION_REVIEW_GATE_BLOCKED");
    for (const reason of gitReview.delegation_gate.blocking_reasons) {
      if (isShipReviewReason(reason)) reasons.add(reason);
    }
  }
  if (requestedRunId && !gitReview.delegation_gate.applicable_runs.some(({ run_id }) => run_id === requestedRunId)) {
    reasons.add("DELEGATION_GATE_RUN_MISMATCH");
  }
  return [...reasons];
}

function isShipReviewReason(value: string): value is ShipReviewReason {
  return [
    "DELEGATION_REVIEW_GATE_MISSING",
    "DELEGATION_REVIEW_GATE_INVALID",
    "DELEGATION_REVIEW_ATTESTATION_MISSING",
    "DELEGATION_REVIEW_GATE_BINDING_MISSING",
    "DELEGATION_REVIEW_STATE_CHANGED",
    "DELEGATION_PRODUCT_REVIEW_FAILED",
    "DELEGATION_TECHNICAL_REVIEW_INVALID",
    "DELEGATION_GATE_DISCOVERY_TRUNCATED"
  ].includes(value);
}
