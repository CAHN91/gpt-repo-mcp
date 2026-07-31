import {
  CodexReviewAttestationV2Schema,
  CodexReviewWriteInputSchema,
  type CodexReviewWriteInput,
  type CodexReviewWriteResult
} from "../contracts/codex-review-attestation.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { readSafeRunArtifact, writeSafeRunJson } from "../delegation/safe-artifact.js";
import { codexRunPaths } from "./codex-run-paths.js";
import { CodexResultService } from "./codex-result-service.js";
import { codexReviewAttestationAnySha256 } from "./codex-review-state.js";
import { redactCodexReviewText } from "./codex-review-text.js";
import { DelegationGateService } from "./delegation-gate-service.js";
import { parseCodexRunManifest } from "./codex-run-manifest.js";
import type { GitReviewService } from "./git-review-service.js";
import type { PathSandbox } from "./path-sandbox.js";
import type { WritePolicy } from "./write-policy.js";

const reviewLocks = new Map<string, Promise<void>>();

export class CodexReviewAttestationService {
  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    private readonly gitReviewService: GitReviewService,
    private readonly writePolicy: WritePolicy,
    private readonly now: () => Date = () => new Date()
  ) {}

  async write(rawInput: CodexReviewWriteInput): Promise<CodexReviewWriteResult> {
    const input = CodexReviewWriteInputSchema.parse(rawInput);
    return withReviewLock(this.root, input.run_id, async () => this.writeLocked(input));
  }

  private async writeLocked(
    input: ReturnType<typeof CodexReviewWriteInputSchema.parse>
  ): Promise<CodexReviewWriteResult> {
    const review = await new CodexResultService(
      this.sandbox,
      this.gitReviewService,
      this.root
    ).review({ repo_id: input.repo_id, run_id: input.run_id });

    if (review.review_state.status !== "available") {
      throw reviewError("CODEX_REVIEW_NOT_ELIGIBLE", "Delegation v3 review state is unavailable for attestation.", {
        review_state: review.review_state
      });
    }
    if (review.review_state.state_sha256 !== input.expected_review_state_sha256) {
      throw reviewError("CODEX_REVIEW_STATE_MISMATCH", "Current review state does not match expected_review_state_sha256.", {
        expected_review_state_sha256: input.expected_review_state_sha256,
        review_state_sha256: review.review_state.state_sha256
      });
    }
    if (review.technical_readiness.status !== "passed") {
      throw reviewError("CODEX_REVIEW_NOT_ELIGIBLE", "Technical readiness must pass before review attestation can be written.", {
        technical_readiness: review.technical_readiness
      });
    }

    const reviewRequirement = review.product_review.requirement === "required"
      ? "product_required" as const
      : review.product_review.requirement === "not_applicable"
        ? "technical_only" as const
        : undefined;
    if (!reviewRequirement) {
      throw reviewError("CODEX_REVIEW_NOT_ELIGIBLE", "Historical or unbound runs cannot receive new review attestation.");
    }
    this.assertVerdictEvidence(input, reviewRequirement, review);

    const paths = codexRunPaths(input.run_id);
    const manifestText = await readSafeRunArtifact(this.root, paths.manifestPath, 512 * 1024);
    if (manifestText === undefined) {
      throw reviewError("CODEX_REVIEW_NOT_ELIGIBLE", "Delegation v3 manifest is unavailable for gate binding.");
    }
    const manifest = parseCodexRunManifest(JSON.parse(manifestText) as unknown);
    if (manifest.schema_version !== 3 || manifest.repo_id !== input.repo_id || manifest.run_id !== input.run_id) {
      throw reviewError("CODEX_REVIEW_NOT_ELIGIBLE", "Delegation v3 manifest identity is invalid for gate binding.");
    }
    const dryRun = input.dry_run ?? false;
    const gateResult = await new DelegationGateService(this.root).ensureGate({
      manifest,
      write_policy: this.writePolicy,
      dry_run: dryRun
    });

    const rationale = redactCodexReviewText(input.rationale);
    const evidence = input.evidence.map((entry) => ({
      criterion_id: entry.criterion_id,
      verdict: entry.verdict,
      evidence: redactCodexReviewText(entry.evidence)
    }));
    const warnings = rationale !== input.rationale.trim()
      || evidence.some((entry, index) => entry.evidence !== input.evidence[index]?.evidence.trim())
      ? ["CODEX_REVIEW_EVIDENCE_REDACTED"]
      : [];
    const reviewedAt = this.now().toISOString();
    const unsigned = {
      schema_version: 2 as const,
      review_gate_sha256: gateResult.gate.gate_sha256,
      repo_id: input.repo_id,
      run_id: input.run_id,
      reviewer: "chatgpt" as const,
      review_requirement: reviewRequirement,
      product_verdict: input.product_verdict,
      rationale,
      evidence,
      reviewed_at: reviewedAt,
      binding: review.review_state,
      technical_readiness: review.technical_readiness,
      product_review: review.product_review,
      review_sha256: "0".repeat(64)
    };
    const placeholder = CodexReviewAttestationV2Schema.parse(unsigned);
    const attestation = CodexReviewAttestationV2Schema.parse({
      ...unsigned,
      review_sha256: codexReviewAttestationAnySha256(placeholder)
    });
    const bytes = Buffer.byteLength(`${JSON.stringify(attestation, null, 2)}\n`, "utf8");
    this.writePolicy.assertAllowed({ path: paths.reviewPath, bytes, action: "write" });
    if (!dryRun) await writeSafeRunJson(this.root, paths.reviewPath, attestation);

    return {
      ok: true,
      repo_id: input.repo_id,
      run_id: input.run_id,
      review_path: paths.reviewPath,
      review_gate_path: paths.reviewGatePath,
      dry_run: dryRun,
      written_paths: dryRun ? [] : [
        ...(gateResult.written ? [paths.reviewGatePath] : []),
        paths.reviewPath
      ],
      review_requirement: reviewRequirement,
      product_verdict: input.product_verdict,
      technical_readiness_status: "passed",
      review_state_sha256: review.review_state.state_sha256,
      review_gate_sha256: gateResult.gate.gate_sha256,
      review_sha256: attestation.review_sha256,
      reviewed_at: reviewedAt,
      warnings,
      next_steps: input.product_verdict === "failed"
        ? [
            "Product review failed and is durably bound to the current state.",
            "Call repo_codex_review again to obtain a bounded corrective child when lineage capacity remains.",
            "The shared Git gate remains blocked until a corrective child receives a passing state-bound review."
          ]
        : [
            "State-bound review attestation and review gate are recorded for the current run state.",
            "Run repo_ship_review for final semantic, validation, and delegation-gate readiness."
          ]
    };
  }

  private assertVerdictEvidence(
    input: ReturnType<typeof CodexReviewWriteInputSchema.parse>,
    reviewRequirement: "product_required" | "technical_only",
    review: Awaited<ReturnType<CodexResultService["review"]>>
  ): void {
    if (reviewRequirement === "technical_only") {
      if (input.product_verdict !== "not_applicable" || input.evidence.length !== 0) {
        throw reviewError("CODEX_REVIEW_EVIDENCE_INVALID", "Technical-only runs require not_applicable verdict and no PAC evidence.");
      }
      return;
    }
    if (input.product_verdict === "not_applicable") {
      throw reviewError("CODEX_REVIEW_EVIDENCE_INVALID", "Product-required runs require passed or failed verdict.");
    }
    if (review.product_evidence.status !== "available") {
      throw reviewError("CODEX_REVIEW_NOT_ELIGIBLE", "Bounded product evidence is unavailable for this product-required run.");
    }
    const expectedIds = review.product_evidence.product_acceptance_criteria.map(({ id }) => id).sort();
    const reportedIds = input.evidence.map(({ criterion_id }) => criterion_id).sort();
    const missing = expectedIds.filter((id) => !reportedIds.includes(id));
    const unknown = reportedIds.filter((id) => !expectedIds.includes(id));
    if (missing.length > 0 || unknown.length > 0 || reportedIds.length !== expectedIds.length) {
      throw reviewError("CODEX_REVIEW_EVIDENCE_INVALID", "Product review evidence must cover every manifest PAC exactly once.", {
        expected_ids: expectedIds,
        reported_ids: reportedIds,
        missing_ids: missing,
        unknown_ids: unknown
      });
    }
    const failed = input.evidence.filter(({ verdict }) => verdict === "failed");
    if (input.product_verdict === "passed" && failed.length > 0) {
      throw reviewError("CODEX_REVIEW_EVIDENCE_INVALID", "Passed product verdict requires every PAC verdict to pass.", {
        failed_ids: failed.map(({ criterion_id }) => criterion_id)
      });
    }
    if (input.product_verdict === "failed" && failed.length === 0) {
      throw reviewError("CODEX_REVIEW_EVIDENCE_INVALID", "Failed product verdict requires at least one failed PAC verdict.");
    }
  }
}

async function withReviewLock<T>(root: string, runId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${root}\0${runId}`;
  const previous = reviewLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  reviewLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (reviewLocks.get(key) === queued) reviewLocks.delete(key);
  }
}

function reviewError(
  code: "CODEX_REVIEW_NOT_ELIGIBLE" | "CODEX_REVIEW_STATE_MISMATCH" | "CODEX_REVIEW_EVIDENCE_INVALID",
  message: string,
  diagnostics: Record<string, unknown> = {}
): RepoReaderError {
  return new RepoReaderError(code, message, { diagnostics });
}
