import { DelegationRunStore, type DelegationRunRecord } from "../delegation/run-store.js";
import { readSafeRunArtifact } from "../delegation/safe-artifact.js";
import { CodexReviewAttestationAnySchema } from "../contracts/codex-review-attestation.contract.js";
import {
  DelegationDriftSummarySchema,
  type DelegationCheckpoint,
  type DelegationDriftSummary
} from "../contracts/delegation-drift.contract.js";
import type { DelegationResultV3, DelegationRunManifestV3 } from "../contracts/delegation-v3.contract.js";
import type { PathSandbox } from "./path-sandbox.js";
import { ProductContractService } from "./product-contract-service.js";
import { codexReviewAttestationAnySha256 } from "./codex-review-state.js";
import { codexRunPaths } from "./codex-run-paths.js";
import { parseDelegationResultV3 } from "./delegation-v3-normalizer.js";

const MAX_DISCOVERED_RUNS = 250;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_REVIEW_BYTES = 512 * 1024;
const SIGNAL_CORRECTION_LOOP = "DELEGATION_DRIFT_CORRECTION_LOOP";
const SIGNAL_SCOPE_EXTENSION = "DELEGATION_DRIFT_SCOPE_EXTENSION_FREQUENT";
const SIGNAL_PROMPT_GROWTH = "DELEGATION_DRIFT_PROMPT_GROWTH";
const SIGNAL_AUTHORIZATION_GROWTH = "DELEGATION_DRIFT_AUTHORIZATION_GROWTH";
const SIGNAL_REPEATED_AREA = "DELEGATION_DRIFT_REPEATED_AREA";
const SIGNAL_PRODUCT_REVIEW_FAILURE = "DELEGATION_DRIFT_PRODUCT_REVIEW_FAILURES";
const SIGNAL_CHECKPOINT_DUE = "DELEGATION_PRODUCT_CHECKPOINT_DUE";
const SIGNAL_TECHNICAL_DOMINANCE = "DELEGATION_DRIFT_TECHNICAL_ROOT_DOMINANCE";

export type DelegationDriftServiceOptions = {
  records?: readonly DelegationRunRecord[];
};

type Observation = {
  manifest: DelegationRunManifestV3;
  result?: DelegationResultV3;
  review?: {
    product_verdict: "passed" | "failed" | "not_applicable";
    reviewed_at: string;
  };
};

export class DelegationDriftService {
  private readonly store: DelegationRunStore;

  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {
    this.store = new DelegationRunStore(root);
  }

  async analyze(repoId: string, options: DelegationDriftServiceOptions = {}): Promise<DelegationDriftSummary> {
    const warnings: string[] = [];
    const records = options.records
      ? [...options.records].slice(0, MAX_DISCOVERED_RUNS)
      : await this.discoverRecords(repoId, warnings);
    if (options.records && options.records.length > records.length) warnings.push("DELEGATION_DRIFT_DISCOVERY_TRUNCATED");

    const observations: Observation[] = [];
    for (const record of records) {
      if (record.repo_id !== repoId || record.manifest.schema_version !== 3) continue;
      const manifest = record.manifest;
      const result = await this.readResult(manifest, warnings);
      const review = await this.readReview(manifest, warnings);
      observations.push({ manifest, ...(result ? { result } : {}), ...(review ? { review } : {}) });
    }
    observations.sort(compareObservations);

    const productContext = await new ProductContractService(this.sandbox).load().catch(() => undefined);
    const checkpoint = checkpointFor(observations, productContext?.status === "configured"
      ? {
          mode: productContext.contract.governance.mode,
          threshold: productContext.contract.governance.checkpoint_every_root_runs
        }
      : undefined);
    const roots = observations.filter(({ manifest }) => !manifest.task.lineage);
    const productRoots = roots.filter(({ manifest }) => manifest.review_requirement === "product_required");
    const technicalRoots = roots.filter(({ manifest }) => manifest.review_requirement === "technical_only");
    const children = observations.filter(({ manifest }) => Boolean(manifest.task.lineage));
    const correctiveChildren = children.filter(({ manifest }) => manifest.task.lineage?.kind === "corrective");
    const scopeAmendmentChildren = children.filter(({ manifest }) => manifest.task.lineage?.kind === "scope_amendment");
    const scopeExtensionRuns = observations.filter(({ result }) => (result?.scope_extension_required.length ?? 0) > 0);
    const failedProductReviews = observations.filter(({ review }) => review?.product_verdict === "failed");
    const repeatedAreas = repeatedAreasFor(observations);
    const maximumCorrectiveChildrenPerRoot = maximumChildrenPerRoot(correctiveChildren);
    const promptBytes = metricFor(roots.map(({ manifest }) => manifest.prompt_byte_count));
    const startingPoints = metricFor(roots.map(({ manifest }) => manifest.authorization.starting_points.length));
    const authorizationPatterns = metricFor(roots.map(({ manifest }) => manifest.authorization.effective_scope.length));
    const signals = driftSignals({
      roots,
      technicalRoots,
      scopeExtensionRuns,
      failedProductReviews,
      repeatedAreas,
      maximumCorrectiveChildrenPerRoot,
      promptBytes,
      authorizationPatterns,
      checkpoint
    });

    return DelegationDriftSummarySchema.parse({
      status: observations.length === 0 ? "no_history" : "observed",
      observed_v3_run_count: observations.length,
      root_run_count: roots.length,
      product_root_run_count: productRoots.length,
      technical_root_run_count: technicalRoots.length,
      child_run_count: children.length,
      corrective_child_count: correctiveChildren.length,
      scope_amendment_child_count: scopeAmendmentChildren.length,
      scope_extension_run_count: scopeExtensionRuns.length,
      failed_product_review_count: failedProductReviews.length,
      maximum_corrective_children_per_root: maximumCorrectiveChildrenPerRoot,
      prompt_bytes: promptBytes,
      starting_point_count: startingPoints,
      authorization_pattern_count: authorizationPatterns,
      repeated_areas: repeatedAreas,
      checkpoint,
      signals,
      warnings: [...new Set(warnings)].slice(0, 50)
    });
  }

  private async discoverRecords(repoId: string, warnings: string[]): Promise<DelegationRunRecord[]> {
    const discovered = (await this.store.discoverRunIds()).sort((left, right) => left.localeCompare(right));
    const runIds = discovered.slice(-MAX_DISCOVERED_RUNS);
    if (discovered.length > runIds.length) warnings.push("DELEGATION_DRIFT_DISCOVERY_TRUNCATED");
    const records: DelegationRunRecord[] = [];
    for (const runId of runIds) {
      try {
        const record = await this.store.readRun(runId);
        if (record.repo_id === repoId) records.push(record);
      } catch {
        warnings.push(`DELEGATION_DRIFT_RUN_INVALID:${runId}`);
      }
    }
    return records;
  }

  private async readResult(manifest: DelegationRunManifestV3, warnings: string[]): Promise<DelegationResultV3 | undefined> {
    try {
      const text = await readSafeRunArtifact(this.root, manifest.result_json_path, MAX_RESULT_BYTES);
      return text === undefined ? undefined : parseDelegationResultV3(text, manifest.repo_id, manifest.run_id);
    } catch {
      warnings.push(`DELEGATION_DRIFT_RESULT_INVALID:${manifest.run_id}`);
      return undefined;
    }
  }

  private async readReview(manifest: DelegationRunManifestV3, warnings: string[]): Promise<Observation["review"]> {
    try {
      const text = await readSafeRunArtifact(this.root, codexRunPaths(manifest.run_id).reviewPath, MAX_REVIEW_BYTES);
      if (text === undefined) return undefined;
      const review = CodexReviewAttestationAnySchema.parse(JSON.parse(text) as unknown);
      if (
        review.repo_id !== manifest.repo_id
        || review.run_id !== manifest.run_id
        || review.review_requirement !== manifest.review_requirement
        || review.review_sha256 !== codexReviewAttestationAnySha256(review)
      ) {
        throw new Error("Review binding mismatch.");
      }
      return { product_verdict: review.product_verdict, reviewed_at: review.reviewed_at };
    } catch {
      warnings.push(`DELEGATION_DRIFT_REVIEW_INVALID:${manifest.run_id}`);
      return undefined;
    }
  }
}

function checkpointFor(
  observations: readonly Observation[],
  governance?: { mode: "advisory" | "enforce"; threshold: number }
): DelegationCheckpoint {
  const roots = observations.filter(({ manifest }) => !manifest.task.lineage);
  if (!governance) {
    return {
      status: "unavailable",
      governance_mode: "unavailable",
      root_runs_since_last_product_checkpoint: roots.length
    };
  }
  if (roots.length === 0) {
    return {
      status: "no_history",
      governance_mode: governance.mode,
      threshold_root_runs: governance.threshold,
      root_runs_since_last_product_checkpoint: 0
    };
  }
  const passingProductReviews = observations
    .filter(({ manifest, review }) => !manifest.task.lineage && manifest.review_requirement === "product_required" && review?.product_verdict === "passed")
    .sort((left, right) => (left.review!.reviewed_at.localeCompare(right.review!.reviewed_at)));
  const latest = passingProductReviews.at(-1);
  const since = latest
    ? roots.filter(({ manifest }) => manifest.created_at > latest.review!.reviewed_at).length
    : roots.length;
  return {
    status: since >= governance.threshold ? "due" : "current",
    governance_mode: governance.mode,
    threshold_root_runs: governance.threshold,
    root_runs_since_last_product_checkpoint: since,
    ...(latest ? {
      latest_product_checkpoint_run_id: latest.manifest.run_id,
      latest_product_checkpoint_at: latest.review!.reviewed_at
    } : {})
  };
}

function metricFor(values: readonly number[]) {
  if (values.length === 0) return { sample_count: 0, trend: "insufficient_data" as const };
  const first = values[0]!;
  const latest = values.at(-1)!;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  return {
    sample_count: values.length,
    first,
    latest,
    minimum,
    maximum,
    average,
    trend: trendFor(values)
  };
}

function trendFor(values: readonly number[]): "insufficient_data" | "stable" | "increasing" | "decreasing" {
  if (values.length < 2) return "insufficient_data";
  const first = values[0]!;
  const latest = values.at(-1)!;
  const baseline = Math.max(first, 1);
  if (latest >= baseline * 1.25 && latest - first >= 2) return "increasing";
  if (latest <= baseline * 0.75 && first - latest >= 2) return "decreasing";
  return "stable";
}

function repeatedAreasFor(observations: readonly Observation[]) {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const areas = new Set((observation.result?.changed_files ?? []).map(areaForPath).filter((area): area is string => Boolean(area)));
    for (const area of areas) counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, runCount]) => runCount >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([area, run_count]) => ({ area, run_count }));
}

function areaForPath(path: string): string | undefined {
  if (path.startsWith(".chatgpt/")) return undefined;
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return undefined;
  if (["apps", "packages", "crates", "tools"].includes(parts[0]!) && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function maximumChildrenPerRoot(observations: readonly Observation[]): number {
  const counts = new Map<string, number>();
  for (const { manifest } of observations) {
    const lineage = manifest.task.lineage;
    if (!lineage) continue;
    counts.set(lineage.root_run_id, (counts.get(lineage.root_run_id) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function driftSignals(input: {
  roots: readonly Observation[];
  technicalRoots: readonly Observation[];
  scopeExtensionRuns: readonly Observation[];
  failedProductReviews: readonly Observation[];
  repeatedAreas: ReadonlyArray<{ area: string; run_count: number }>;
  maximumCorrectiveChildrenPerRoot: number;
  promptBytes: ReturnType<typeof metricFor>;
  authorizationPatterns: ReturnType<typeof metricFor>;
  checkpoint: DelegationCheckpoint;
}): string[] {
  const signals: string[] = [];
  if (input.maximumCorrectiveChildrenPerRoot >= 2) signals.push(SIGNAL_CORRECTION_LOOP);
  if (input.scopeExtensionRuns.length >= 2 && input.scopeExtensionRuns.length / Math.max(1, input.roots.length) >= 0.25) signals.push(SIGNAL_SCOPE_EXTENSION);
  if (input.promptBytes.trend === "increasing") signals.push(SIGNAL_PROMPT_GROWTH);
  if (input.authorizationPatterns.trend === "increasing") signals.push(SIGNAL_AUTHORIZATION_GROWTH);
  if (input.repeatedAreas.some(({ run_count }) => run_count >= 3)) signals.push(SIGNAL_REPEATED_AREA);
  if (input.failedProductReviews.length > 0) signals.push(SIGNAL_PRODUCT_REVIEW_FAILURE);
  if (input.checkpoint.status === "due") signals.push(SIGNAL_CHECKPOINT_DUE);
  if (input.roots.length >= 5 && input.technicalRoots.length / input.roots.length >= 0.8) signals.push(SIGNAL_TECHNICAL_DOMINANCE);
  return signals;
}

function compareObservations(left: Observation, right: Observation): number {
  return left.manifest.created_at.localeCompare(right.manifest.created_at)
    || left.manifest.run_id.localeCompare(right.manifest.run_id);
}
