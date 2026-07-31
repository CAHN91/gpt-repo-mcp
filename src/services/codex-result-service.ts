import {
  CodexReviewInputSchema,
  type CodexParsedResult,
  type CodexProductReview,
  type CodexReviewAttestationStatus,
  type CodexReviewInput,
  type CodexReviewResult
} from "../contracts/codex-task.contract.js";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { readFilePrefix } from "./bounded-read.js";
import {
  correlateCodexAcceptance,
  correlateCodexReviewPaths,
  correlateProductAcceptance,
  correlateTechnicalAcceptance
} from "./codex-review-evidence.js";
import { applyCodexReviewReadiness, evaluateCodexTechnicalReadiness } from "./codex-review-readiness.js";
import { parseJson, parseLegacyCodexResult, parseStructuredCodexResult } from "./codex-result-parser.js";
import { delegationConnectedChangePaths, parseDelegationResultV3 } from "./delegation-v3-normalizer.js";
import type { DelegationResultV3 } from "../contracts/delegation-v3.contract.js";
import { parseCodexRunManifest, type CodexRunManifest } from "./codex-run-manifest.js";
import { evaluateCodexRunIntegrity } from "./codex-run-integrity.js";
import type { GitReviewService } from "./git-review-service.js";
import { PathSandbox } from "./path-sandbox.js";
import { SecretScanner } from "./secret-scanner.js";
import { codexRunPaths } from "./codex-run-paths.js";
import { reviewLoopContext } from "./codex-lineage-service.js";
import { GitService } from "./git-service.js";
import { buildCodexReviewState, inspectCodexReviewAttestation } from "./codex-review-state.js";
import {
  buildDelegationV3ProductEvidence,
  deriveCodexProductReview
} from "./delegation-v3-product-evidence.js";

const EMPTY_SCOPE: CodexReviewResult["scope_evidence"] = {
  newly_observed_paths: [],
  pre_existing_paths: [],
  attributed_paths: [],
  dirty_baseline_attributed_paths: [],
  unattributed_paths: [],
  out_of_scope_paths: [],
  forbidden_paths: [],
  claimed_but_not_observed: [],
  observed_but_unreported: [],
  attribution_ambiguous_paths: []
};

const EMPTY_RESULT: CodexParsedResult = {
  status: "unknown",
  summary: "",
  changed_files: [],
  commands_run: [],
  tests: [],
  acceptance_criteria: [],
  blockers: [],
  followups: [],
  source: "RESULT.json",
  raw_text: ""
};

export class CodexResultService {
  private readonly secretScanner = new SecretScanner();

  constructor(
    private readonly sandbox: PathSandbox,
    private readonly gitReviewService: GitReviewService,
    private readonly root?: string
  ) {}

  async review(rawInput: CodexReviewInput): Promise<CodexReviewResult> {
    const input = CodexReviewInputSchema.parse(rawInput);
    const paths = codexRunPaths(input.run_id);
    const warnings: string[] = [];
    const manifest = await this.readManifest(paths.manifestPath, input.repo_id, input.run_id, paths, warnings);
    const prompt = await this.readOptionalText(paths.promptPath, false);
    const integrityResult = evaluateCodexRunIntegrity(manifest, prompt, paths);
    const integrity = integrityResult.integrity;
    warnings.push(...integrityResult.warnings);

    const structuredText = await this.readOptionalText(paths.resultJsonPath);
    const legacyText = structuredText === undefined && manifest?.schema_version !== 3
      ? await this.readOptionalText(paths.resultPath)
      : undefined;
    if (structuredText === undefined && manifest?.schema_version === 3) {
      if (await this.readOptionalText(paths.resultPath) !== undefined) warnings.push("DELEGATION_V3_RESULT_JSON_REQUIRED");
    }
    if (structuredText === undefined && legacyText === undefined) {
      const reviewLoop = await reviewLoopContext(this.root, this.sandbox, input.repo_id, manifest);
      const acceptanceEvidence = correlateCodexAcceptance(manifest, EMPTY_RESULT);
      const technicalAcceptanceEvidence = correlateTechnicalAcceptance(manifest, EMPTY_RESULT);
      const productAcceptanceEvidence = correlateProductAcceptance(manifest, EMPTY_RESULT);
      const technicalReadiness = evaluateCodexTechnicalReadiness({
        integrity,
        scope: EMPTY_SCOPE,
        technicalAcceptance: technicalAcceptanceEvidence,
        status: undefined,
        resultFound: false,
        connectedChangesComplete: false,
        manifest
      });
      const productReview = deriveCodexProductReview(manifest);
      const productEvidence = buildDelegationV3ProductEvidence({
        manifest,
        integrity,
        scope: EMPTY_SCOPE
      });
      const reviewState = buildCodexReviewState({
        manifest: manifest?.schema_version === 3 ? manifest : undefined,
        promptText: prompt,
        resultFound: false,
        technicalReadiness,
        productReview,
        productEvidence,
        scopeEvidence: EMPTY_SCOPE,
        technicalAcceptance: technicalAcceptanceEvidence,
        productAcceptance: productAcceptanceEvidence
      });
      const reviewAttestation = this.root
        ? await inspectCodexReviewAttestation({
            root: this.root,
            reviewPath: paths.reviewPath,
            repoId: input.repo_id,
            runId: input.run_id,
            currentState: reviewState
          })
        : { status: "unavailable" as const, review_path: paths.reviewPath, reasons: ["REVIEW_STATE_UNAVAILABLE"] };
      return {
        ok: true,
        repo_id: input.repo_id,
        run_id: input.run_id,
        ...(manifest?.schema_version === 3 ? {} : { legacy_result_path: paths.resultPath }),
        result_json_path: paths.resultJsonPath,
        result_found: false,
        integrity,
        scope_evidence: EMPTY_SCOPE,
        acceptance_evidence: acceptanceEvidence,
        technical_acceptance_evidence: technicalAcceptanceEvidence,
        product_acceptance_evidence: productAcceptanceEvidence,
        technical_readiness: technicalReadiness,
        product_review: productReview,
        product_evidence: productEvidence,
        review_state: reviewState,
        review_attestation: reviewAttestation,
        review_loop: reviewLoop.metadata,
        next_steps: [
          manifest?.schema_version === 3
            ? "Strict RESULT.json is missing, so technical readiness is incomplete. Complete the result contract and call repo_codex_review again."
            : "Paste Codex output into ChatGPT, or rerun Codex with the prompt completion contract.",
          productReview.requirement === "required"
            ? "Product review remains pending and cannot be completed from agent claims alone."
            : "No product verdict is available for this run."
        ],
        warnings: [...new Set([
          ...warnings,
          ...productReviewWarnings(productReview),
          "CODEX_RESULT_MISSING",
          technicalReadiness.status === "unavailable"
            ? "CODEX_TECHNICAL_READINESS_UNAVAILABLE"
            : "CODEX_TECHNICAL_READINESS_INCOMPLETE",
          "CODEX_HAPPY_PATH_PAYLOADS_SUPPRESSED"
        ])]
      };
    }

    let codexResult: CodexParsedResult;
    let resultSource: "RESULT.json" | "RESULT.md";
    let delegationResultV3: DelegationResultV3 | undefined;
    if (structuredText !== undefined) {
      resultSource = "RESULT.json";
      if (manifest?.schema_version === 3) {
        delegationResultV3 = parseDelegationResultV3(structuredText, input.repo_id, input.run_id);
      }
      const parsed = parseStructuredCodexResult(structuredText, input.repo_id, input.run_id);
      codexResult = parsed.result;
      warnings.push(...parsed.warnings);
    } else {
      resultSource = "RESULT.md";
      warnings.push("CODEX_RESULT_MD_LEGACY_FALLBACK");
      codexResult = parseLegacyCodexResult(legacyText ?? "");
    }

    const modernBinding = manifest?.schema_version === 3 && manifest.baseline.initial_path_states !== undefined;
    const git = this.root ? new GitService(this.root) : undefined;
    const status = git ? await git.status() : undefined;
    const gitReview = await this.gitReviewService.review({
      repo_id: input.repo_id,
      detail: "compact",
      ...(modernBinding ? { paths: codexResult.changed_files } : {}),
      ...(input.max_files ? { max_files: input.max_files } : {})
    });
    if (manifest?.schema_version === 2 || manifest?.schema_version === 3) {
      integrity.head_matches_baseline = gitReview.head_sha === manifest.baseline.head_sha;
      if (!integrity.head_matches_baseline) warnings.push("CODEX_BASELINE_HEAD_MISMATCH");
    }
    const currentPaths = status
      ? status.files.flatMap((entry) => [entry.original_path, entry.path]).filter((path): path is string => Boolean(path))
      : gitReview.changed_paths.flatMap((entry) => [entry.original_path, entry.path]).filter((path): path is string => Boolean(path));
    const currentClaimedPaths = codexResult.changed_files.filter((path) => currentPaths.includes(path));
    const currentPathStates = git && modernBinding ? await git.pathStates(currentClaimedPaths) : undefined;
    const scopeEvidence = correlateCodexReviewPaths({
      runId: input.run_id,
      manifest,
      currentPaths,
      claimedPaths: codexResult.changed_files,
      currentPathStates
    });
    const acceptanceEvidence = correlateCodexAcceptance(manifest, codexResult);
    const technicalAcceptanceEvidence = correlateTechnicalAcceptance(manifest, codexResult);
    const productAcceptanceEvidence = correlateProductAcceptance(manifest, codexResult);
    const readiness = applyCodexReviewReadiness({
      integrity,
      scope: scopeEvidence,
      acceptance: acceptanceEvidence,
      technicalAcceptance: technicalAcceptanceEvidence,
      status: codexResult.status,
      resultFound: true,
      connectedChangesComplete: connectedChangesAreComplete(manifest, delegationResultV3),
      manifest,
      gitReview
    });
    const productReview = deriveCodexProductReview(manifest);
    const productEvidence = buildDelegationV3ProductEvidence({
      manifest,
      integrity,
      scope: scopeEvidence,
      result: delegationResultV3,
      gitReview
    });
    const worktreeFingerprint = git
      ? modernBinding
        ? await git.contentFingerprint(scopeEvidence.attributed_paths)
        : await git.reviewStateFingerprint()
      : undefined;
    const reviewState = buildCodexReviewState({
      manifest: manifest?.schema_version === 3 ? manifest : undefined,
      promptText: prompt,
      resultText: structuredText,
      resultFound: true,
      gitReview,
      technicalReadiness: readiness.technicalReadiness,
      productReview,
      productEvidence,
      scopeEvidence,
      technicalAcceptance: technicalAcceptanceEvidence,
      productAcceptance: productAcceptanceEvidence,
      worktreeFingerprint
    });
    const reviewAttestation = this.root
      ? await inspectCodexReviewAttestation({
          root: this.root,
          reviewPath: paths.reviewPath,
          repoId: input.repo_id,
          runId: input.run_id,
          currentState: reviewState
        })
      : { status: "unavailable" as const, review_path: paths.reviewPath, reasons: ["REVIEW_STATE_UNAVAILABLE"] };
    warnings.push(
      ...readiness.warnings.filter((warning) => warning !== "DELEGATION_V3_REVIEW_ATTESTATION_REQUIRED"),
      ...reviewAttestationWarnings(reviewAttestation),
      ...productAcceptanceWarnings(productAcceptanceEvidence),
      ...productReviewWarnings(productReview),
      ...gitReview.recommendation.warnings
    );
    const { suppressHappyPath, gitReview: safeGitReview, technicalReadiness } = readiness;
    const reviewLoop = await reviewLoopContext(
      this.root,
      this.sandbox,
      input.repo_id,
      manifest,
      delegationResultV3,
      reviewAttestation.status === "valid" && reviewAttestation.verdict === "failed"
        ? {
            rationale: reviewAttestation.rationale ?? "Product review failed.",
            evidence: reviewAttestation.evidence ?? []
          }
        : undefined
    );
    const nextToolPayloads = {
      ...safeGitReview.next_tool_payloads,
      ...(reviewAttestation.status === "valid"
        && (reviewAttestation.verdict === "passed" || reviewAttestation.verdict === "not_applicable")
        && reviewState.status === "available"
        ? {
            repo_ship_review: {
              repo_id: input.repo_id,
              run_id: input.run_id,
              paths: scopeEvidence.newly_observed_paths
            }
          }
        : {}),
      ...(reviewLoop.next_task_payload
        ? { repo_write_codex_task: reviewLoop.next_task_payload }
        : {})
    };

    return {
      ok: true,
      repo_id: input.repo_id,
      run_id: input.run_id,
      ...(manifest?.schema_version === 3 ? {} : { legacy_result_path: paths.resultPath }),
      result_json_path: paths.resultJsonPath,
      result_source: resultSource,
      result_found: true,
      integrity,
      scope_evidence: scopeEvidence,
      acceptance_evidence: acceptanceEvidence,
      technical_acceptance_evidence: technicalAcceptanceEvidence,
      product_acceptance_evidence: productAcceptanceEvidence,
      technical_readiness: technicalReadiness,
      product_review: productReview,
      product_evidence: productEvidence,
      review_state: reviewState,
      review_attestation: reviewAttestation,
      review_loop: reviewLoop.metadata,
      codex_result: codexResult,
      git_review: { ...safeGitReview, next_tool_payloads: {} },
      next_tool_payloads: nextToolPayloads,
      next_steps: suppressHappyPath ? [
        `Technical readiness is ${technicalReadiness.status}; inspect its deterministic checks together with scope, TAC, and Git evidence.`,
        reviewAttestation.status === "valid"
          ? `State-bound review attestation is valid with verdict ${reviewAttestation.verdict}; run repo_ship_review with the provided payload for final gate, semantic, validation, and Git readiness.`
          : productReview.requirement === "required"
            ? "Product review remains pending; use the bounded product_evidence pack and review_state token with repo_write_codex_review."
            : productReview.requirement === "not_applicable"
              ? "Technical-only review requires a state-bound not_applicable attestation through repo_write_codex_review."
              : "Product review is unavailable for this run.",
        ...(reviewLoop.next_task_payload
          ? [`A bounded ${reviewLoop.metadata.next_child_kind} child payload is available in next_tool_payloads.repo_write_codex_task.`]
          : []),
        "Direct stage and commit payloads remain suppressed here; the shared gate is enforced through repo_ship_review and every Git mutation path."
      ] : [
        "Technical readiness passed for this historical technical review.",
        "Product review is unavailable for legacy runs.",
        "If the diff is good, use the review-provided Git payload through the host approval UI."
      ],
      warnings: [...new Set(warnings)]
    };
  }

  private async readManifest(
    manifestPath: string,
    repoId: string,
    runId: string,
    expectedPaths: ReturnType<typeof codexRunPaths>,
    warnings: string[]
  ): Promise<CodexRunManifest | undefined> {
    const text = await this.readOptionalText(manifestPath, false);
    if (text === undefined) {
      warnings.push("CODEX_MANIFEST_MISSING_LEGACY_REVIEW");
      return undefined;
    }
    const manifest = parseCodexRunManifest(parseJson(text, manifestPath));
    if (manifest.repo_id !== repoId || manifest.run_id !== runId) {
      throw new RepoReaderError("VALIDATION_ERROR", "Codex manifest repo_id or run_id does not match the review request.");
    }
    if (manifest.prompt_path !== expectedPaths.promptPath) {
      throw new RepoReaderError("VALIDATION_ERROR", "Codex manifest prompt path does not match the requested run.");
    }
    if (manifest.schema_version === 3) {
      if (manifest.result_json_path !== expectedPaths.resultJsonPath || manifest.manifest_path !== expectedPaths.manifestPath) {
        throw new RepoReaderError("VALIDATION_ERROR", "Delegation v3 manifest artifact paths do not match the requested run.");
      }
    } else if (manifest.schema_version === 2) {
      if (manifest.result_path !== expectedPaths.resultPath || manifest.result_json_path !== expectedPaths.resultJsonPath || manifest.manifest_path !== expectedPaths.manifestPath) {
        throw new RepoReaderError("VALIDATION_ERROR", "Codex v2 manifest artifact paths do not match the requested run.");
      }
    } else {
      if (manifest.result_path !== expectedPaths.resultPath) {
        throw new RepoReaderError("VALIDATION_ERROR", "Codex v1 manifest result path does not match the requested run.");
      }
      warnings.push("CODEX_LEGACY_MANIFEST_V1");
    }
    return manifest;
  }

  private async readOptionalText(repoPath: string, redact = true): Promise<string | undefined> {
    try {
      const resolved = await this.sandbox.resolve(repoPath);
      if (!resolved.stat.isFile()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Not a regular file: ${resolved.repoPath}`);
      }
      const { buffer, truncated } = await readFilePrefix(resolved.absolutePath, DEFAULT_LIMITS.max_bytes_per_file);
      if (truncated) throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `File exceeds max_bytes: ${resolved.repoPath}`);
      const text = decodeSafeText(buffer, resolved.repoPath);
      return redact ? this.secretScanner.redact(text) : text;
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }
}

function connectedChangesAreComplete(
  manifest: CodexRunManifest | undefined,
  result: DelegationResultV3 | undefined
): boolean {
  if (manifest?.schema_version !== 3) return true;
  if (!result) return false;
  const changed = [...result.changed_files].sort();
  const connected = delegationConnectedChangePaths(result).sort();
  return changed.length === connected.length
    && changed.every((path, index) => path === connected[index]);
}

function reviewAttestationWarnings(attestation: CodexReviewAttestationStatus): string[] {
  if (attestation.status === "valid") {
    return attestation.verdict === "failed"
      ? ["DELEGATION_V3_PRODUCT_REVIEW_FAILED"]
      : ["DELEGATION_V3_REVIEW_ATTESTED"];
  }
  if (attestation.status === "stale") return ["DELEGATION_V3_REVIEW_ATTESTATION_STALE"];
  if (attestation.status === "tampered") return ["DELEGATION_V3_REVIEW_ATTESTATION_TAMPERED"];
  if (attestation.status === "missing") return ["DELEGATION_V3_REVIEW_ATTESTATION_REQUIRED"];
  return [];
}

function productAcceptanceWarnings(
  evidence: CodexReviewResult["product_acceptance_evidence"]
): string[] {
  if (!evidence.binding_available) return [];
  const warnings: string[] = [];
  if (evidence.unknown_ids.length > 0) warnings.push("CODEX_PRODUCT_ACCEPTANCE_UNKNOWN_IDS");
  if (evidence.duplicate_ids.length > 0) warnings.push("CODEX_PRODUCT_ACCEPTANCE_DUPLICATE_IDS");
  if (evidence.missing_ids.length > 0) warnings.push("CODEX_PRODUCT_ACCEPTANCE_MISSING_IDS");
  if (evidence.failed_ids.length > 0) warnings.push("CODEX_PRODUCT_ACCEPTANCE_FAILED");
  if (evidence.unverified_ids.length > 0) warnings.push("CODEX_PRODUCT_ACCEPTANCE_UNVERIFIED");
  return warnings;
}

function productReviewWarnings(productReview: CodexProductReview): string[] {
  if (productReview.requirement === "required") return ["DELEGATION_V3_PRODUCT_REVIEW_REQUIRED"];
  if (productReview.requirement === "unavailable") return ["CODEX_PRODUCT_REVIEW_UNAVAILABLE_LEGACY"];
  return [];
}

function decodeSafeText(buffer: Buffer, repoPath: string): string {
  if (buffer.includes(0)) throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file blocked: ${repoPath}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new RepoReaderError("BINARY_FILE_REJECTED", `Invalid UTF-8 file blocked: ${repoPath}`);
  }
}
