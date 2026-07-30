import type {
  CodexProductEvidencePack,
  CodexProductReview,
  CodexReviewResult
} from "../contracts/codex-task.contract.js";
import type { DelegationResultV3, DelegationRunManifestV3 } from "../contracts/delegation-v3.contract.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import type { CodexRunManifest } from "./codex-run-manifest.js";

type GitReview = NonNullable<CodexReviewResult["git_review"]>;

export function deriveCodexProductReview(manifest: CodexRunManifest | undefined): CodexProductReview {
  if (!manifest || manifest.schema_version !== 3) {
    return {
      requirement: "unavailable",
      status: "unavailable",
      source: "legacy_unavailable"
    };
  }
  if (manifest.review_requirement === "product_required") {
    return {
      requirement: "required",
      status: "pending",
      source: "manifest"
    };
  }
  return {
    requirement: "not_applicable",
    status: "not_applicable",
    source: "manifest"
  };
}

export function buildDelegationV3ProductEvidence(input: {
  manifest: CodexRunManifest | undefined;
  integrity: CodexReviewResult["integrity"];
  scope: CodexReviewResult["scope_evidence"];
  result?: DelegationResultV3;
  gitReview?: GitReview;
}): CodexProductEvidencePack {
  const { manifest } = input;
  if (!manifest || manifest.schema_version !== 3) {
    return { status: "unavailable", reason: "legacy_run" };
  }
  if (manifest.review_requirement === "technical_only") {
    return { status: "not_applicable", reason: "technical_task" };
  }
  if (
    manifest.product_binding.kind !== "selected"
    || !("product_alignment" in manifest.task)
  ) {
    return { status: "unavailable", reason: "missing_product_binding" };
  }
  if (!input.integrity.manifest_bound) {
    return { status: "unavailable", reason: "integrity_failed" };
  }

  const snapshot = manifest.product_binding.snapshot;
  const resultByPac = new Map(
    (input.result?.product_acceptance_criteria ?? []).map((entry) => [entry.id, entry] as const)
  );
  const changedPaths = input.scope.newly_observed_paths.slice(0, 100);
  const changedSet = new Set(changedPaths);
  const flattenedConnectedChanges = (input.result?.connected_changes ?? []).flatMap((entry) =>
    "path" in entry
      ? [{ path: entry.path, reason: entry.reason }]
      : entry.paths.map((path) => ({ path, reason: entry.reason, category: entry.category }))
  );
  const connectedChanges = flattenedConnectedChanges
    .filter(({ path }) => changedSet.has(path))
    .slice(0, 100)
    .map(({ path, reason }) => ({ path, reason: safe(reason, 500) }));
  const diffSignals = (input.gitReview?.diff_summary.files ?? [])
    .filter(({ path }) => changedSet.has(path))
    .slice(0, 50)
    .map(({ path, status, hunk_count: hunkCount, summary }) => ({
      path,
      ...(status ? { status: safe(status, 100) } : {}),
      hunk_count: hunkCount,
      summary: safe(summary, 500)
    }));
  const lineage = lineageSummary(manifest);
  const truncated = input.scope.newly_observed_paths.length > changedPaths.length
    || flattenedConnectedChanges.length > connectedChanges.length
    || (input.gitReview?.diff_summary.files.length ?? 0) > diffSignals.length
    || Boolean(input.gitReview?.diff_summary.truncated);

  return {
    status: "available",
    product: {
      name: safe(snapshot.product.name, 160),
      purpose: safe(snapshot.product.purpose, 8_000)
    },
    primary_user: {
      id: snapshot.primary_user.id,
      role: safe(snapshot.primary_user.role, 500),
      work_context: safe(snapshot.primary_user.work_context, 8_000)
    },
    jobs_to_be_done: snapshot.jobs_to_be_done.slice(0, 20).map(({ id, statement }) => ({
      id,
      statement: safe(statement, 8_000)
    })),
    declared_outcome: {
      beneficiary: safe(manifest.task.outcome.beneficiary, 500),
      current_problem: safe(manifest.task.outcome.current_problem, 8_000),
      desired_outcome: safe(manifest.task.outcome.desired_outcome, 8_000),
      why_now: safe(manifest.task.outcome.why_now, 8_000)
    },
    product_goal: safe(manifest.task.product_alignment.product_goal, 8_000),
    must_reduce: snapshot.must_reduce.slice(0, 30).map((value) => safe(value, 500)),
    must_not_become: [
      ...snapshot.must_not_become,
      ...manifest.task.product_alignment.additional_must_not_become
    ].slice(0, 60).map((value) => safe(value, 500)),
    experience_principles: snapshot.experience_principles.slice(0, 30).map((value) => safe(value, 500)),
    product_acceptance_criteria: manifest.task.product_alignment.product_acceptance_criteria.map(({ id, criterion }) => {
      const reported = resultByPac.get(id);
      return {
        id,
        criterion: safe(criterion, 500),
        agent_status: reported?.status ?? "missing",
        agent_evidence: safe(reported?.evidence ?? "", 2_000)
      };
    }),
    changed_paths: changedPaths,
    connected_changes: connectedChanges,
    diff_signals: diffSignals,
    lineage,
    scope_extension_required: (input.result?.scope_extension_required ?? []).slice(0, 30).map((entry) => ({
      path_or_area: entry.path_or_area,
      reason: safe(entry.reason, 500),
      required_outcome: safe(entry.required_outcome, 8_000)
    })),
    truncated
  };
}

function lineageSummary(manifest: DelegationRunManifestV3): Extract<CodexProductEvidencePack, { status: "available" }>["lineage"] {
  const lineage = manifest.task.lineage;
  if (!lineage) {
    return {
      kind: "root",
      root_run_id: manifest.run_id,
      parent_run_id: null,
      child_index: null
    };
  }
  return {
    kind: lineage.kind,
    root_run_id: lineage.root_run_id,
    parent_run_id: lineage.parent_run_id,
    child_index: lineage.child_index
  };
}

function safe(value: string, max: number): string {
  return redactSensitiveText(value).slice(0, max);
}
