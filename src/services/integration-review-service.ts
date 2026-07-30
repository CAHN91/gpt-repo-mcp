import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IntegrationReviewArtifactSchema,
  IntegrationReviewWriteInputSchema,
  IntegrationReviewWriteResultSchema,
  type IntegrationReviewArtifact,
  type IntegrationReviewWriteInput,
  type IntegrationReviewWriteResult
} from "../contracts/integration-review.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { CodexResultService } from "./codex-result-service.js";
import { DelegationGateService } from "./delegation-gate-service.js";
import { FileWriter } from "./file-writer.js";
import { GitOperationsService } from "./git-operations-service.js";
import { GitReviewService } from "./git-review-service.js";
import { GitService } from "./git-service.js";
import { OperationsPolicy } from "./operations-policy.js";
import { PathSandbox } from "./path-sandbox.js";
import { hashCanonical } from "./product-contract-service.js";
import { SemanticReviewService } from "./semantic-review-service.js";
import { WritePolicy } from "./write-policy.js";

const INTEGRATION_ROOT = ".chatgpt/integration-reviews";
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export class IntegrationReviewService {
  private readonly git: GitService;
  private readonly gate: DelegationGateService;

  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    private readonly operationsPolicy: OperationsPolicy,
    private readonly writePolicy?: WritePolicy,
    private readonly now: () => Date = () => new Date()
  ) {
    this.git = new GitService(root);
    this.gate = new DelegationGateService(root);
  }

  async write(rawInput: IntegrationReviewWriteInput): Promise<IntegrationReviewWriteResult> {
    const input = IntegrationReviewWriteInputSchema.parse(rawInput);
    const status = await this.git.status();
    if (status.head_sha !== input.expected_head_sha) {
      throw new RepoReaderError("GIT_HEAD_MISMATCH", "Current HEAD does not match expected_head_sha for integration review.");
    }
    const gitReview = new GitReviewService(this.root, this.operationsPolicy);
    const codexReview = new CodexResultService(this.sandbox, gitReview, this.root);
    const runBindings: IntegrationReviewArtifact["run_bindings"] = [];
    for (const runId of input.run_ids) {
      const review = await codexReview.review({ repo_id: input.repo_id, run_id: runId });
      if (review.technical_readiness.status !== "passed" || review.review_attestation.status !== "valid") {
        throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", `Run ${runId} does not have a current passing review attestation.`);
      }
      const verdict = review.review_attestation.verdict;
      if (verdict !== "passed" && verdict !== "not_applicable") {
        throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", `Run ${runId} has a failed or missing product verdict.`);
      }
      const scope = review.scope_evidence;
      if (
        scope.attributed_paths.length === 0
        || scope.out_of_scope_paths.length > 0
        || scope.forbidden_paths.length > 0
        || scope.claimed_but_not_observed.length > 0
        || scope.attribution_ambiguous_paths.length > 0
      ) {
        throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", `Run ${runId} has unresolved scope or attribution evidence.`);
      }
      if (!review.review_attestation.review_sha256) {
        throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", `Run ${runId} review hash is unavailable.`);
      }
      runBindings.push({
        run_id: runId,
        review_sha256: review.review_attestation.review_sha256,
        product_verdict: verdict,
        paths: [...scope.attributed_paths].sort()
      });
    }

    const reviewedPaths = uniqueSorted(runBindings.flatMap((entry) => entry.paths));
    const currentPaths = uniqueSorted(status.files.flatMap((entry) => [entry.original_path, entry.path])
      .filter((path): path is string => typeof path === "string" && !path.startsWith(".chatgpt/")));
    if (!samePathSet(currentPaths, reviewedPaths)) {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Integration review requires exact coverage of every current changed path.", {
        diagnostics: {
          unreviewed_paths: currentPaths.filter((path) => !reviewedPaths.includes(path)),
          missing_paths: reviewedPaths.filter((path) => !currentPaths.includes(path))
        }
      });
    }

    await new GitOperationsService(this.root, this.operationsPolicy).validateReviewBoundPaths(reviewedPaths);
    const gate = await this.gate.evaluate({
      repo_id: input.repo_id,
      paths: reviewedPaths,
      operation: "ship",
      head_sha: status.head_sha
    });
    if (gate.status === "blocked") {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "One or more applicable Delegation reviews block integration.", {
        diagnostics: { blocking_reasons: gate.blocking_reasons }
      });
    }
    const included = new Set(input.run_ids);
    const missingIncludedRuns = input.run_ids.filter((runId) => !gate.applicable_runs.some((entry) => entry.run_id === runId && entry.status === "passed"));
    if (missingIncludedRuns.length > 0) {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Integration review could not prove every selected run is applicable and passed.", {
        diagnostics: { run_ids: missingIncludedRuns }
      });
    }
    const failedApplicable = gate.applicable_runs.filter((entry) => !included.has(entry.run_id) && entry.governance_mode === "enforce" && entry.status !== "passed");
    if (failedApplicable.length > 0) {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Another applicable enforce run is unresolved.");
    }

    const validation = await this.readValidation(input.validation_id, status.head_sha, await this.git.worktreeFingerprint());
    const semantic = await new SemanticReviewService(this.root, this.sandbox).review({
      repo_id: input.repo_id,
      paths: reviewedPaths,
      max_files: 500,
      max_findings: 100
    });
    if (semantic.truncated || semantic.ship_readiness.status !== "ready") {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", semantic.truncated
        ? "Semantic integration review was truncated and is incomplete."
        : "Semantic review has blocking findings.", {
        diagnostics: {
          truncated: semantic.truncated,
          blocking_finding_ids: semantic.ship_readiness.blocking_finding_ids
        }
      });
    }

    const pathsetFingerprint = await this.git.contentFingerprint(reviewedPaths);
    const integrationId = createIntegrationId(this.now());
    const integrationPath = `${INTEGRATION_ROOT}/${integrationId}.json`;
    const unsigned = {
      schema_version: 1 as const,
      integration_id: integrationId,
      repo_id: input.repo_id,
      head_sha: status.head_sha,
      run_bindings: runBindings,
      reviewed_paths: reviewedPaths,
      pathset_fingerprint: pathsetFingerprint,
      validation: {
        validation_id: input.validation_id,
        profile: "all" as const,
        artifact_sha256: validation.artifact_sha256
      },
      semantic_review: {
        status: "ready" as const,
        blocking_finding_ids: semantic.ship_readiness.blocking_finding_ids
      },
      commit_message: input.commit_message,
      created_at: this.now().toISOString(),
      artifact_sha256: "0".repeat(64)
    };
    const placeholder = IntegrationReviewArtifactSchema.parse(unsigned);
    const artifact = IntegrationReviewArtifactSchema.parse({
      ...unsigned,
      artifact_sha256: integrationArtifactSha256(placeholder)
    });
    const dryRun = input.dry_run ?? false;
    if (!dryRun && !this.writePolicy) {
      throw new RepoReaderError("WRITE_DISABLED", "Integration review writing requires repository write policy.");
    }
    if (!dryRun) {
      await new FileWriter(this.root, this.sandbox, this.writePolicy!).write({
        path: integrationPath,
        action: "write",
        content: `${JSON.stringify(artifact, null, 2)}\n`,
        create_dirs: true,
        expected_missing: true,
        reason: input.reason
      });
    }
    return IntegrationReviewWriteResultSchema.parse({
      ok: true,
      repo_id: input.repo_id,
      integration_id: integrationId,
      integration_path: integrationPath,
      review_pathset_id: integrationId,
      dry_run: dryRun,
      written_paths: dryRun ? [] : [integrationPath],
      head_sha: status.head_sha,
      run_ids: input.run_ids,
      reviewed_paths: reviewedPaths,
      path_count: reviewedPaths.length,
      pathset_fingerprint: pathsetFingerprint,
      validation_id: input.validation_id,
      warnings: gate.warnings,
      next_tool_payloads: {
        repo_write_stage_commit: {
          repo_id: input.repo_id,
          review_pathset_id: integrationId,
          message: input.commit_message,
          expected_head_sha: status.head_sha,
          dry_run: false
        }
      }
    });
  }

  async resolvePathset(input: { repo_id: string; integration_id: string; expected_head_sha: string }): Promise<IntegrationReviewArtifact> {
    const path = `${INTEGRATION_ROOT}/${input.integration_id}.json`;
    const text = await readBounded(join(this.root, path), MAX_ARTIFACT_BYTES);
    let artifact: IntegrationReviewArtifact;
    try {
      artifact = IntegrationReviewArtifactSchema.parse(JSON.parse(text) as unknown);
    } catch {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Integration review artifact is invalid or tampered.");
    }
    if (
      artifact.repo_id !== input.repo_id
      || artifact.integration_id !== input.integration_id
      || artifact.artifact_sha256 !== integrationArtifactSha256(artifact)
    ) {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Integration review identity or hash does not match.");
    }
    const status = await this.git.status();
    if (status.head_sha !== input.expected_head_sha || artifact.head_sha !== status.head_sha) {
      throw new RepoReaderError("GIT_HEAD_MISMATCH", "Integration review HEAD is stale.");
    }
    const currentPaths = uniqueSorted(status.files.flatMap((entry) => [entry.original_path, entry.path])
      .filter((value): value is string => typeof value === "string" && !value.startsWith(".chatgpt/")));
    if (!samePathSet(currentPaths, artifact.reviewed_paths)) {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Integration pathset no longer matches the worktree.");
    }
    if (await this.git.contentFingerprint(artifact.reviewed_paths) !== artifact.pathset_fingerprint) {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Integration path content changed after review.");
    }
    await new GitOperationsService(this.root, this.operationsPolicy).validateReviewBoundPaths(artifact.reviewed_paths);
    const gate = await this.gate.evaluate({ repo_id: input.repo_id, paths: artifact.reviewed_paths, operation: "stage_commit", head_sha: status.head_sha });
    if (gate.status === "blocked") {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Delegation state changed after integration review.", {
        diagnostics: { blocking_reasons: gate.blocking_reasons }
      });
    }
    return artifact;
  }

  private async readValidation(validationId: string, headSha: string, worktreeFingerprint: string): Promise<{ artifact_sha256: string }> {
    const path = join(this.root, ".chatgpt", "validation", validationId, "result.json");
    const text = await readBounded(path, MAX_ARTIFACT_BYTES);
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value.validation_id !== validationId
      || value.profile !== "all"
      || value.status !== "passed"
      || value.focused === true
      || value.head_sha !== headSha
      || value.worktree_fingerprint !== worktreeFingerprint
    ) {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Integration requires a current non-focused all-profile validation.");
    }
    return { artifact_sha256: createHash("sha256").update(text).digest("hex") };
  }
}

export function integrationArtifactSha256(artifact: IntegrationReviewArtifact): string {
  const unsigned = { ...artifact } as Partial<IntegrationReviewArtifact>;
  delete unsigned.artifact_sha256;
  return hashCanonical(unsigned);
}

function createIntegrationId(now: Date): string {
  return `integration-${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

async function readBounded(path: string, maxBytes: number): Promise<string> {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", "Integration artifact exceeds the bounded read limit.");
  }
  return text;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
