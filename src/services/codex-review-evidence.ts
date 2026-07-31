import type { CodexParsedResult, CodexReviewResult } from "../contracts/codex-task.contract.js";
import type { GitPathState } from "./git-service.js";
import type { CodexRunManifest } from "./codex-run-manifest.js";
import { effectiveForbiddenPatterns, isCodexRunArtifact, matchesAnyPattern } from "./codex-task-policy.js";

type AcceptanceEntry = NonNullable<CodexParsedResult["acceptance_results"]>[number];
type AcceptanceEvidence = CodexReviewResult["acceptance_evidence"];
type ProductAcceptanceEvidence = CodexReviewResult["product_acceptance_evidence"];

export function correlateCodexReviewPaths(input: {
  runId: string;
  manifest?: CodexRunManifest;
  currentPaths: readonly string[];
  claimedPaths: readonly string[];
  currentPathStates?: readonly GitPathState[];
}): CodexReviewResult["scope_evidence"] {
  const currentPaths = uniqueSorted(input.currentPaths.filter((path) => !isReviewOperationalArtifact(path, input.runId)));
  const claimedPaths = uniqueSorted(input.claimedPaths.filter((path) => !isReviewOperationalArtifact(path, input.runId)));
  const initialPaths = input.manifest?.schema_version === 2 || input.manifest?.schema_version === 3
    ? uniqueSorted(input.manifest.baseline.initial_changed_paths.filter((path) => !isReviewOperationalArtifact(path, input.runId)))
    : [];
  const initialSet = new Set(initialPaths);
  const currentSet = new Set(currentPaths);
  const claimedSet = new Set(claimedPaths);
  const preExisting = currentPaths.filter((path) => initialSet.has(path));
  const observedAfterBaseline = currentPaths.filter((path) => !initialSet.has(path));
  const allowed = input.manifest?.schema_version === 3
    ? input.manifest.authorization.effective_scope
    : input.manifest?.allowed_paths ?? [];
  const forbidden = input.manifest?.schema_version === 3
    ? input.manifest.authorization.effective_forbidden_paths
    : effectiveForbiddenPatterns(input.manifest?.schema_version === 2
      ? input.manifest.caller_forbidden_paths
      : (input.manifest?.forbidden_paths ?? []));

  const baselineStates = input.manifest?.schema_version === 3 && input.manifest.baseline.initial_path_states
    ? new Map(input.manifest.baseline.initial_path_states.map((state) => [state.path, state]))
    : undefined;
  const currentStates = input.currentPathStates
    ? new Map(input.currentPathStates.map((state) => [state.path, state]))
    : undefined;
  const dirtyBaselineAttributed = baselineStates && currentStates
    ? preExisting.filter((path) => claimedSet.has(path) && stateChanged(baselineStates.get(path), currentStates.get(path)))
    : [];
  const ambiguous = preExisting.filter((path) => claimedSet.has(path) && !dirtyBaselineAttributed.includes(path));
  const newlyAttributed = observedAfterBaseline.filter((path) => claimedSet.has(path));
  const attributed = uniqueSorted([...newlyAttributed, ...dirtyBaselineAttributed]);
  const modernAttribution = Boolean(baselineStates && currentStates);
  const effectiveAttributed = modernAttribution ? attributed : observedAfterBaseline;

  return {
    newly_observed_paths: modernAttribution ? attributed : observedAfterBaseline,
    pre_existing_paths: preExisting,
    attributed_paths: modernAttribution ? attributed : observedAfterBaseline,
    dirty_baseline_attributed_paths: dirtyBaselineAttributed,
    unattributed_paths: modernAttribution
      ? currentPaths.filter((path) => !initialSet.has(path) && !claimedSet.has(path))
      : [],
    out_of_scope_paths: allowed.length === 0 ? [] : effectiveAttributed.filter((path) => !matchesAnyPattern(path, allowed)),
    forbidden_paths: effectiveAttributed.filter((path) => matchesAnyPattern(path, forbidden)),
    claimed_but_not_observed: claimedPaths.filter((path) => !currentSet.has(path)),
    observed_but_unreported: modernAttribution ? [] : observedAfterBaseline.filter((path) => !claimedSet.has(path)),
    attribution_ambiguous_paths: ambiguous
  };
}

export function correlateTechnicalAcceptance(
  manifest: CodexRunManifest | undefined,
  result: CodexParsedResult
): AcceptanceEvidence {
  if (!manifest || manifest.schema_version === 1) return emptyAcceptanceEvidence(false);
  if (manifest.schema_version === 3) {
    return correlateAcceptance(
      manifest.task.technical_acceptance_criteria.map(({ id }) => id),
      result.technical_acceptance_results,
      true
    );
  }
  return correlateAcceptance(
    manifest.acceptance_criteria.map(({ id }) => id),
    result.acceptance_results,
    true
  );
}

export function correlateProductAcceptance(
  manifest: CodexRunManifest | undefined,
  result: CodexParsedResult
): ProductAcceptanceEvidence {
  if (
    !manifest
    || manifest.schema_version !== 3
    || !("product_alignment" in manifest.task)
  ) {
    return emptyProductAcceptanceEvidence(false);
  }
  const evidence = correlateAcceptance(
    manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => id),
    result.product_acceptance_results,
    true
  );
  const { all_passed: agentAllPassed, ...rest } = evidence;
  return { ...rest, agent_all_passed: agentAllPassed };
}

export function correlateCodexAcceptance(
  manifest: CodexRunManifest | undefined,
  result: CodexParsedResult
): AcceptanceEvidence {
  if (!manifest || manifest.schema_version === 1) return emptyAcceptanceEvidence(false);
  if (manifest.schema_version === 3) {
    const expectedIds = [
      ...("product_alignment" in manifest.task
        ? manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => id)
        : []),
      ...manifest.task.technical_acceptance_criteria.map(({ id }) => id)
    ];
    return correlateAcceptance(expectedIds, result.acceptance_results, true);
  }
  return correlateAcceptance(
    manifest.acceptance_criteria.map(({ id }) => id),
    result.acceptance_results,
    true
  );
}

export function emptyAcceptanceEvidence(bindingAvailable: boolean): CodexReviewResult["acceptance_evidence"] {
  return {
    binding_available: bindingAvailable,
    expected_ids: [],
    reported_ids: [],
    passed_ids: [],
    failed_ids: [],
    unverified_ids: [],
    unknown_ids: [],
    duplicate_ids: [],
    missing_ids: [],
    complete: false,
    all_passed: false
  };
}

export function emptyProductAcceptanceEvidence(bindingAvailable: boolean): ProductAcceptanceEvidence {
  return {
    binding_available: bindingAvailable,
    expected_ids: [],
    reported_ids: [],
    passed_ids: [],
    failed_ids: [],
    unverified_ids: [],
    unknown_ids: [],
    duplicate_ids: [],
    missing_ids: [],
    complete: false,
    agent_all_passed: false
  };
}

function correlateAcceptance(
  expectedIds: readonly string[],
  entries: readonly AcceptanceEntry[] | undefined,
  bindingAvailable: boolean
): AcceptanceEvidence {
  if (!entries) {
    const complete = expectedIds.length === 0;
    return {
      ...emptyAcceptanceEvidence(bindingAvailable),
      expected_ids: [...expectedIds],
      missing_ids: [...expectedIds],
      complete,
      all_passed: complete
    };
  }
  const reportedIds = entries.map(({ id }) => id);
  const expected = new Set(expectedIds);
  const counts = new Map<string, number>();
  for (const id of reportedIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const passedIds = uniqueSorted(entries.filter(({ status }) => status === "passed").map(({ id }) => id));
  const failedIds = uniqueSorted(entries.filter(({ status }) => status === "failed").map(({ id }) => id));
  const unverifiedIds = uniqueSorted(entries.filter(({ status }) => status === "unverified").map(({ id }) => id));
  const unknownIds = uniqueSorted(reportedIds.filter((id) => !expected.has(id)));
  const duplicateIds = uniqueSorted([...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id));
  const missingIds = uniqueSorted(expectedIds.filter((id) => !counts.has(id)));
  const complete = unknownIds.length === 0 && duplicateIds.length === 0 && missingIds.length === 0;
  const allPassed = complete
    && failedIds.length === 0
    && unverifiedIds.length === 0
    && expectedIds.every((id) => passedIds.includes(id));
  return {
    binding_available: bindingAvailable,
    expected_ids: [...expectedIds],
    reported_ids: reportedIds,
    passed_ids: passedIds,
    failed_ids: failedIds,
    unverified_ids: unverifiedIds,
    unknown_ids: unknownIds,
    duplicate_ids: duplicateIds,
    missing_ids: missingIds,
    complete,
    all_passed: allPassed
  };
}

function stateChanged(baseline: GitPathState | undefined, current: GitPathState | undefined): boolean {
  if (!baseline || !current) return false;
  return baseline.exists !== current.exists
    || baseline.kind !== current.kind
    || baseline.content_sha256 !== current.content_sha256;
}

function isReviewOperationalArtifact(path: string, runId: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === ".chatgpt"
    || normalized.startsWith(".chatgpt/")
    || isCodexRunArtifact(normalized, runId);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
