import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DelegationGateDecisionSchema,
  DelegationReviewGateSchema,
  type DelegationGateDecision,
  type DelegationGateRunDecision,
  type DelegationReviewGate
} from "../contracts/delegation-gate.contract.js";
import {
  CodexReviewAttestationAnySchema,
  type CodexReviewAttestationAny
} from "../contracts/codex-review-attestation.contract.js";
import {
  DelegationResultV3Schema,
  type DelegationRunManifestV3
} from "../contracts/delegation-v3.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { readSafeRunArtifact, writeSafeRunJson } from "../delegation/safe-artifact.js";
import { parseCodexRunManifest } from "./codex-run-manifest.js";
import { CODEX_RUN_DIR, codexRunPaths } from "./codex-run-paths.js";
import {
  delegationManifestSha256V3,
  parseDelegationManifestV3
} from "./delegation-v3-normalizer.js";
import { sha256Text } from "./codex-task-policy.js";
import { hashCanonical } from "./product-contract-service.js";
import { matchesGlob } from "./glob-service.js";
import { GitService, type GitPathState } from "./git-service.js";
import { codexReviewAttestationAnySha256 } from "./codex-review-state.js";
import type { WritePolicy } from "./write-policy.js";

const MAX_DISCOVERED_RUNS = 1_000;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_GATE_BYTES = 128 * 1024;
const MAX_REVIEW_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 512 * 1024;

export type DelegationGateOperation = "review" | "ship" | "stage" | "commit" | "stage_commit" | "runner_commit";

export class DelegationGateService {
  private readonly git: GitService;

  constructor(private readonly root: string) {
    this.git = new GitService(root);
  }

  async evaluate(input: {
    repo_id: string;
    paths: string[];
    operation: DelegationGateOperation;
    head_sha?: string;
    review_state_fingerprint?: string;
  }): Promise<DelegationGateDecision> {
    const requestedPaths = uniqueSorted(input.paths.filter((path) => path.length > 0 && !path.startsWith(".chatgpt/")));
    if (requestedPaths.length === 0) return emptyDecision(requestedPaths);
    const [status, discovered] = await Promise.all([
      input.head_sha ? Promise.resolve({ head_sha: input.head_sha }) : this.git.status(),
      this.discoverRunIds()
    ]);
    const applicableRuns: DelegationGateRunDecision[] = [];
    const runCandidates: Array<{
      manifest: DelegationRunManifestV3;
      governed_paths: string[];
      claimed_paths: string[];
    }> = [];
    const warnings = [...discovered.warnings];

    for (const runId of discovered.run_ids) {
      const loaded = await this.loadManifest(input.repo_id, runId);
      if (!loaded) {
        const orphanedGate = await this.evaluateGateWithoutManifest(input.repo_id, runId, requestedPaths);
        if (orphanedGate) applicableRuns.push(orphanedGate);
        continue;
      }
      const coverage = await this.pathCoverage(loaded.manifest, requestedPaths);
      if (coverage.governed_paths.length > 0) {
        runCandidates.push({ manifest: loaded.manifest, ...coverage });
      }
    }

    const coveredPaths = new Set(runCandidates.flatMap(({ claimed_paths: paths }) => paths));
    for (const candidate of runCandidates) {
      const uncoveredPaths = candidate.governed_paths.filter((path) => !coveredPaths.has(path));
      if (uncoveredPaths.length > 0) {
        applicableRuns.push(runDecision(
          {
            manifest: candidate.manifest,
            applicable_paths: uniqueSorted([...candidate.claimed_paths, ...uncoveredPaths])
          },
          candidate.manifest.delegation_audit.mode,
          "stale",
          "stale",
          ["DELEGATION_REVIEW_STATE_CHANGED"]
        ));
        continue;
      }
      if (candidate.claimed_paths.length > 0) {
        applicableRuns.push(await this.evaluateRun({
          manifest: candidate.manifest,
          applicable_paths: candidate.claimed_paths,
          head_sha: status.head_sha,
          legacy_review_state_fingerprint: input.review_state_fingerprint
        }));
      }
    }

    const enforceFailures = applicableRuns.filter((entry) => entry.governance_mode === "enforce" && entry.status !== "passed");
    const advisoryFailures = applicableRuns.filter((entry) => entry.governance_mode === "advisory" && entry.status !== "passed");
    const discoveryBlocked = discovered.truncated;
    const blockingReasons = uniqueSorted([
      ...(discoveryBlocked ? ["DELEGATION_GATE_DISCOVERY_TRUNCATED"] : []),
      ...enforceFailures.flatMap(({ reasons }) => reasons)
    ]);
    warnings.push(...advisoryFailures.flatMap(({ reasons }) => reasons.map((reason) => `ADVISORY:${reason}`)));
    const decision = {
      status: discoveryBlocked || enforceFailures.length > 0
        ? "blocked" as const
        : advisoryFailures.length > 0
          ? "advisory" as const
          : applicableRuns.length > 0
            ? "passed" as const
            : "not_applicable" as const,
      requested_paths: requestedPaths,
      applicable_runs: applicableRuns,
      blocking_reasons: blockingReasons,
      warnings: uniqueSorted(warnings),
      truncated: discovered.truncated
    };
    return DelegationGateDecisionSchema.parse(decision);
  }

  async assertAllowed(input: {
    repo_id: string;
    paths: string[];
    operation: DelegationGateOperation;
    head_sha?: string;
    review_state_fingerprint?: string;
  }): Promise<DelegationGateDecision> {
    const decision = await this.evaluate(input);
    if (decision.status === "blocked") {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Delegation review gate blocked this Git operation.", {
        diagnostics: {
          operation: input.operation,
          paths: decision.requested_paths,
          blocking_reasons: decision.blocking_reasons,
          applicable_runs: decision.applicable_runs.map(({ run_id, status, applicable_paths, reasons }) => ({
            run_id, status, applicable_paths, reasons
          }))
        }
      });
    }
    return decision;
  }

  async ensureGate(input: {
    manifest: DelegationRunManifestV3;
    write_policy: WritePolicy;
    dry_run?: boolean;
  }): Promise<{ gate: DelegationReviewGate; gate_path: string; written: boolean }> {
    const gate = buildDelegationReviewGate(input.manifest);
    const paths = codexRunPaths(input.manifest.run_id);
    const bytes = Buffer.byteLength(`${JSON.stringify(gate, null, 2)}\n`, "utf8");
    input.write_policy.assertAllowed({ path: paths.reviewGatePath, bytes, action: "write" });
    const existing = await readSafeRunArtifact(this.root, paths.reviewGatePath, MAX_GATE_BYTES);
    if (existing !== undefined) {
      const parsed = DelegationReviewGateSchema.parse(JSON.parse(existing) as unknown);
      if (parsed.gate_sha256 !== delegationReviewGateSha256(parsed) || hashCanonical(parsed) !== hashCanonical(gate)) {
        throw new RepoReaderError("DELEGATION_REVIEW_GATE_INVALID", "Existing review gate does not match the bound Delegation v3 manifest.", {
          diagnostics: { run_id: input.manifest.run_id }
        });
      }
      return { gate: parsed, gate_path: paths.reviewGatePath, written: false };
    }
    if (!(input.dry_run ?? false)) await writeSafeRunJson(this.root, paths.reviewGatePath, gate);
    return { gate, gate_path: paths.reviewGatePath, written: !(input.dry_run ?? false) };
  }

  private async discoverRunIds(): Promise<{ run_ids: string[]; truncated: boolean; warnings: string[] }> {
    try {
      const entries = (await readdir(join(this.root, CODEX_RUN_DIR), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(({ name }) => name)
        .sort((left, right) => right.localeCompare(left));
      const truncated = entries.length > MAX_DISCOVERED_RUNS;
      return {
        run_ids: entries.slice(0, MAX_DISCOVERED_RUNS),
        truncated,
        warnings: truncated ? ["DELEGATION_GATE_DISCOVERY_TRUNCATED"] : []
      };
    } catch (error) {
      if (isNotFound(error)) return { run_ids: [], truncated: false, warnings: [] };
      return { run_ids: [], truncated: true, warnings: ["DELEGATION_GATE_DISCOVERY_UNSAFE"] };
    }
  }

  private async loadManifest(repoId: string, runId: string): Promise<{ manifest: DelegationRunManifestV3; text: string } | undefined> {
    let paths: ReturnType<typeof codexRunPaths>;
    try {
      paths = codexRunPaths(runId);
    } catch {
      return undefined;
    }
    const text = await readSafeRunArtifact(this.root, paths.manifestPath, MAX_MANIFEST_BYTES).catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      const manifest = parseCodexRunManifest(JSON.parse(text) as unknown);
      if (manifest.schema_version !== 3 || manifest.repo_id !== repoId || manifest.run_id !== runId) return undefined;
      return { manifest, text };
    } catch {
      return undefined;
    }
  }

  private async pathCoverage(
    manifest: DelegationRunManifestV3,
    requestedPaths: string[]
  ): Promise<{ governed_paths: string[]; claimed_paths: string[] }> {
    const baselineChanged = new Set(manifest.baseline.initial_changed_paths);
    const authorized = requestedPaths.filter((path) =>
      manifest.authorization.effective_scope.some((pattern) => matchesGlob(path, pattern))
    );
    if (!manifest.baseline.initial_path_states) {
      const governedPaths = authorized.filter((path) => !baselineChanged.has(path));
      return {
        governed_paths: governedPaths,
        claimed_paths: await this.claimedPaths(manifest, governedPaths, true)
      };
    }
    const baselineStates = new Map(
      manifest.baseline.initial_path_states.map((state) => [state.path, state])
    );
    const currentStates = new Map(
      (await this.git.pathStates(authorized.filter((path) => baselineChanged.has(path))))
        .map((state) => [state.path, state])
    );
    const governedPaths = authorized.filter((path) =>
      !baselineChanged.has(path)
      || pathStateChanged(baselineStates.get(path), currentStates.get(path))
    );
    return {
      governed_paths: governedPaths,
      claimed_paths: await this.claimedPaths(manifest, governedPaths, false)
    };
  }

  private async claimedPaths(
    manifest: DelegationRunManifestV3,
    governedPaths: string[],
    useGovernedFallback: boolean
  ): Promise<string[]> {
    const resultText = await readSafeRunArtifact(
      this.root,
      codexRunPaths(manifest.run_id).resultJsonPath,
      MAX_RESULT_BYTES
    ).catch(() => undefined);
    if (resultText === undefined) return useGovernedFallback ? governedPaths : [];
    try {
      const result = DelegationResultV3Schema.parse(JSON.parse(resultText) as unknown);
      if (result.repo_id !== manifest.repo_id || result.run_id !== manifest.run_id) {
        return useGovernedFallback ? governedPaths : [];
      }
      const claimed = new Set(result.changed_files);
      return governedPaths.filter((path) => claimed.has(path));
    } catch {
      return useGovernedFallback ? governedPaths : [];
    }
  }

  private async evaluateGateWithoutManifest(
    repoId: string,
    runId: string,
    requestedPaths: string[]
  ): Promise<DelegationGateRunDecision | undefined> {
    const paths = codexRunPaths(runId);
    const gateText = await readSafeRunArtifact(this.root, paths.reviewGatePath, MAX_GATE_BYTES).catch(() => undefined);
    if (gateText === undefined) return undefined;
    try {
      const gate = DelegationReviewGateSchema.parse(JSON.parse(gateText) as unknown);
      if (
        gate.repo_id !== repoId
        || gate.run_id !== runId
        || gate.gate_sha256 !== delegationReviewGateSha256(gate)
      ) return undefined;
      const baselineChanged = new Set(gate.initial_changed_paths);
      const applicablePaths = requestedPaths.filter((path) =>
        !baselineChanged.has(path)
        && gate.authorization_scope.some((pattern) => matchesGlob(path, pattern))
      );
      if (applicablePaths.length === 0) return undefined;
      return {
        run_id: runId,
        governance_mode: gate.governance_mode,
        applicable_paths: applicablePaths,
        status: "invalid_gate",
        review_status: "tampered",
        reasons: ["DELEGATION_REVIEW_GATE_INVALID"]
      };
    } catch {
      return undefined;
    }
  }

  private async evaluateRun(input: {
    manifest: DelegationRunManifestV3;
    applicable_paths: string[];
    head_sha: string;
    legacy_review_state_fingerprint?: string;
  }): Promise<DelegationGateRunDecision> {
    const paths = codexRunPaths(input.manifest.run_id);
    const mode = input.manifest.delegation_audit.mode;
    const gateText = await readSafeRunArtifact(this.root, paths.reviewGatePath, MAX_GATE_BYTES).catch(() => undefined);
    if (gateText === undefined) {
      return runDecision(input, mode, "missing_gate", "unavailable", ["DELEGATION_REVIEW_GATE_MISSING"]);
    }
    let gate: DelegationReviewGate;
    try {
      gate = DelegationReviewGateSchema.parse(JSON.parse(gateText) as unknown);
      const expected = buildDelegationReviewGate(input.manifest);
      if (
        gate.gate_sha256 !== delegationReviewGateSha256(gate)
        || hashCanonical(gate) !== hashCanonical(expected)
      ) {
        return runDecision(input, mode, "invalid_gate", "tampered", ["DELEGATION_REVIEW_GATE_INVALID"]);
      }
    } catch {
      return runDecision(input, mode, "invalid_gate", "tampered", ["DELEGATION_REVIEW_GATE_INVALID"]);
    }

    const reviewText = await readSafeRunArtifact(this.root, paths.reviewPath, MAX_REVIEW_BYTES).catch(() => undefined);
    if (reviewText === undefined) {
      return runDecision(input, mode, "open", "missing", ["DELEGATION_REVIEW_ATTESTATION_MISSING"]);
    }
    let attestation: CodexReviewAttestationAny;
    try {
      attestation = CodexReviewAttestationAnySchema.parse(JSON.parse(reviewText) as unknown);
    } catch {
      return runDecision(input, mode, "tampered", "tampered", ["DELEGATION_REVIEW_ATTESTATION_TAMPERED"]);
    }
    if (attestation.review_sha256 !== codexReviewAttestationAnySha256(attestation)) {
      return runDecision(input, mode, "tampered", "tampered", ["DELEGATION_REVIEW_ATTESTATION_TAMPERED"]);
    }
    if (attestation.schema_version !== 2 || attestation.review_gate_sha256 !== gate.gate_sha256) {
      return runDecision(input, mode, "stale", "stale", ["DELEGATION_REVIEW_GATE_BINDING_MISSING"], attestation.product_verdict);
    }
    const attestedPaths = new Set(attestation.binding.changed_paths);
    if (input.applicable_paths.some((path) => !attestedPaths.has(path))) {
      return runDecision(input, mode, "stale", "stale", ["DELEGATION_REVIEW_STATE_CHANGED"], attestation.product_verdict);
    }

    const [promptText, resultText] = await Promise.all([
      readSafeRunArtifact(this.root, paths.promptPath, MAX_PROMPT_BYTES).catch(() => undefined),
      readSafeRunArtifact(this.root, paths.resultJsonPath, MAX_RESULT_BYTES).catch(() => undefined)
    ]);
    const currentBindingFingerprint = attestation.binding.binding_version === 2
      ? await this.git.contentFingerprint(attestation.binding.changed_paths)
      : input.legacy_review_state_fingerprint ?? await this.git.reviewStateFingerprint();
    const stateMatches = Boolean(
      promptText !== undefined
      && resultText !== undefined
      && attestation.repo_id === input.manifest.repo_id
      && attestation.run_id === input.manifest.run_id
      && attestation.binding.manifest_sha256 === delegationManifestSha256V3(input.manifest)
      && attestation.binding.prompt_sha256 === sha256Text(promptText)
      && attestation.binding.result_sha256 === sha256Text(resultText)
      && attestation.binding.head_sha === input.head_sha
      && attestation.binding.worktree_fingerprint === currentBindingFingerprint
      && (attestation.binding.pathset_fingerprint === undefined || attestation.binding.pathset_fingerprint === currentBindingFingerprint)
      && attestation.technical_readiness.status === "passed"
    );
    if (!stateMatches) {
      return runDecision(input, mode, "stale", "stale", ["DELEGATION_REVIEW_STATE_CHANGED"], attestation.product_verdict);
    }
    if (gate.review_requirement === "product_required" && attestation.product_verdict !== "passed") {
      return runDecision(input, mode, "failed", "valid", ["DELEGATION_PRODUCT_REVIEW_FAILED"], attestation.product_verdict);
    }
    if (gate.review_requirement === "technical_only" && attestation.product_verdict !== "not_applicable") {
      return runDecision(input, mode, "failed", "valid", ["DELEGATION_TECHNICAL_REVIEW_INVALID"], attestation.product_verdict);
    }
    return runDecision(input, mode, "passed", "valid", [], attestation.product_verdict);
  }
}

export function buildDelegationReviewGate(manifestInput: DelegationRunManifestV3): DelegationReviewGate {
  const manifest = parseDelegationManifestV3(manifestInput);
  const paths = codexRunPaths(manifest.run_id);
  const unsigned = {
    schema_version: 1 as const,
    repo_id: manifest.repo_id,
    run_id: manifest.run_id,
    manifest_path: manifest.manifest_path,
    review_path: paths.reviewPath,
    manifest_sha256: delegationManifestSha256V3(manifest),
    prompt_sha256: manifest.prompt_sha256,
    baseline_sha256: manifest.baseline_sha256,
    baseline_head_sha: manifest.baseline.head_sha,
    initial_changed_paths: [...manifest.baseline.initial_changed_paths],
    authorization_scope: [...manifest.authorization.effective_scope],
    review_requirement: manifest.review_requirement,
    governance_mode: manifest.delegation_audit.mode,
    created_at: manifest.created_at,
    gate_sha256: "0".repeat(64)
  };
  const placeholder = DelegationReviewGateSchema.parse(unsigned);
  return DelegationReviewGateSchema.parse({
    ...unsigned,
    gate_sha256: delegationReviewGateSha256(placeholder)
  });
}

export function delegationReviewGateSha256(gate: DelegationReviewGate): string {
  const unsigned = { ...gate } as Partial<DelegationReviewGate>;
  delete unsigned.gate_sha256;
  return hashCanonical(unsigned);
}

function runDecision(
  input: { manifest: DelegationRunManifestV3; applicable_paths: string[] },
  governanceMode: "advisory" | "enforce",
  status: DelegationGateRunDecision["status"],
  reviewStatus: DelegationGateRunDecision["review_status"],
  reasons: string[],
  productVerdict?: DelegationGateRunDecision["product_verdict"]
): DelegationGateRunDecision {
  return {
    run_id: input.manifest.run_id,
    governance_mode: governanceMode,
    applicable_paths: input.applicable_paths,
    status,
    review_status: reviewStatus,
    ...(productVerdict ? { product_verdict: productVerdict } : {}),
    reasons
  };
}

function pathStateChanged(
  baseline: GitPathState | undefined,
  current: GitPathState | undefined
): boolean {
  if (!baseline || !current) return false;
  return baseline.exists !== current.exists
    || baseline.kind !== current.kind
    || baseline.content_sha256 !== current.content_sha256;
}

function emptyDecision(paths: string[]): DelegationGateDecision {
  return {
    status: "not_applicable",
    requested_paths: paths,
    applicable_runs: [],
    blocking_reasons: [],
    warnings: [],
    truncated: false
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
