import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore from "ignore";
import type { GitReviewInput, GitReviewResult } from "../contracts/git-review.contract.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { GitService } from "./git-service.js";
import { OperationsPolicy } from "./operations-policy.js";
import { validateRepoPath } from "./path-sandbox.js";
import { DelegationGateService } from "./delegation-gate-service.js";

type StatusFile = GitReviewResult["changed_paths"][number];

const STAGED_RECOVERY_WARNING = "STAGED_RECOVERY_REQUIRES_UNSTAGE_FIRST";
const STAGED_RECOVERY_GUIDANCE = [
  "Staged paths cannot be restored directly with repo_git_restore_paths because restore is worktree-only.",
  "For bad staged changes, use repo_write_recover with the review-provided unstage_paths and restore_paths, or use repo_write_unstage first when granular control is needed.",
  "If the staged diff is good, call repo_write_commit with the review-provided repo_write_commit_dry_run payload; it sets dry_run=true."
];

export class GitReviewService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(
    private readonly root: string,
    private readonly operationsPolicy: OperationsPolicy = new OperationsPolicy(),
    private readonly delegationGate: DelegationGateService = new DelegationGateService(root)
  ) {}

  async review(input: GitReviewInput): Promise<GitReviewResult> {
    const git = new GitService(this.root);
    const detail = input.detail ?? "compact";
    const scopePaths = input.paths ? [...new Set(input.paths.map((path) => validateRepoPath(path)))].sort() : undefined;
    const scopeSet = scopePaths ? new Set(scopePaths) : undefined;
    const status = await git.status();
    const changedPathsAll = status.files.map((file) => ({
      ...file,
      status: classifyStatus(file.index, file.worktree),
      staged: file.index !== " " && file.index !== "?",
      unstaged: file.worktree !== " " || file.index === "?"
    }));
    const changedPaths = scopeSet ? changedPathsAll.filter((path) => scopeSet.has(path.path)) : changedPathsAll;
    const diffCandidatePaths = [...new Set(changedPaths
      .filter((path) => path.status !== "untracked")
      .map((path) => path.path))].sort();
    const maxFiles = input.max_files ?? diffCandidatePaths.length;
    const selectedDiffPaths = diffCandidatePaths.slice(0, maxFiles);
    const [unstagedDiff, stagedDiff, worktreeFingerprint, reviewStateFingerprint] = await Promise.all([
      git.diff({ paths: selectedDiffPaths }),
      git.diff({ staged: true, paths: selectedDiffPaths }),
      git.worktreeFingerprint(),
      git.reviewStateFingerprint()
    ]);
    const diff = mergeDiffs(stagedDiff, unstagedDiff);
    const diffSummaryTruncated = diff.truncated || selectedDiffPaths.length < diffCandidatePaths.length;
    const warnings = [...diff.warnings];
    if (scopeSet) {
      warnings.push("REVIEW_SCOPE_APPLIED");
      const omittedChangedPaths = changedPathsAll.filter((path) => !scopeSet.has(path.path));
      if (omittedChangedPaths.length > 0) {
        warnings.push("REVIEW_SCOPE_OMITTED_CHANGED_PATHS");
      }
      const missingScopePaths = (scopePaths ?? []).filter((path) => !changedPathsAll.some((changed) => changed.path === path));
      if (missingScopePaths.length > 0) {
        warnings.push("REVIEW_SCOPE_PATHS_NOT_CHANGED");
      }
    }
    if (diffSummaryTruncated) {
      warnings.push("DIFF_SUMMARY_TRUNCATED");
    }
    if (status.clean) {
      warnings.push("NO_CHANGES");
    }
    if (changedPaths.some((path) => path.status === "untracked")) {
      warnings.push("UNTRACKED_PATHS_REVIEWED_FOR_STAGING");
    }

    const excludedPaths: Array<{ path: string; reason: string }> = [];
    const recommendedStagePaths: string[] = [];
    for (const path of changedPaths) {
      const exclusion = this.exclusionReason(path);
      if (exclusion) {
        excludedPaths.push({ path: path.path, reason: exclusion });
        continue;
      }
      if (path.unstaged && !path.staged) {
        recommendedStagePaths.push(path.path);
      }
    }
    if (changedPaths.some((path) =>
      path.status === "untracked" && excludedPaths.some((excluded) => excluded.path === path.path)
    )) {
      warnings.push("UNTRACKED_PATHS_EXCLUDED");
    }
    const shipReadiness = await this.readShipReadiness(status.head_sha, worktreeFingerprint);
    if (shipReadiness.validation.status === "stale") {
      warnings.push("VALIDATION_STALE");
    }
    if (shipReadiness.validation.status === "failed") {
      warnings.push("VALIDATION_FAILED");
    }
    if (shipReadiness.validation.status === "missing" && !status.clean) {
      warnings.push("VALIDATION_MISSING");
    }
    if (shipReadiness.validation.focused) {
      warnings.push("VALIDATION_FOCUSED");
    }

    const stagedPaths = changedPaths
      .filter((path) => path.staged && !this.exclusionReason(path))
      .map((path) => path.path)
      .sort();
    const hasStagedExcludedPaths = changedPaths.some((path) => path.staged && this.exclusionReason(path));
    const stagedRecoveryPaths = changedPaths
      .filter((path) => path.staged && this.isRecoverableWorktreePath(path))
      .map((path) => path.path)
      .sort();
    if (stagedRecoveryPaths.length > 0) {
      warnings.push(STAGED_RECOVERY_WARNING);
    }
    const recoverableWorktreePaths = changedPaths
      .filter((path) => path.unstaged && !path.staged && this.isRecoverableWorktreePath(path))
      .map((path) => path.path)
      .sort();
    const cleanupPaths = changedPaths
      .filter((path) => path.status === "untracked" && this.isCleanupEligible(path.path))
      .map((path) => path.path)
      .sort();
    const discardPaths = changedPaths
      .filter((path) => path.status === "untracked" && !this.exclusionReason(path) && !this.isCleanupEligible(path.path))
      .map((path) => path.path)
      .sort();
    const stagePaths = [...new Set(recommendedStagePaths)].sort();
    const expectedCommitPaths = [...new Set([...stagedPaths, ...stagePaths])].sort();
    const delegationGate = await this.delegationGate.evaluate({
      repo_id: input.repo_id,
      paths: expectedCommitPaths,
      operation: "review",
      head_sha: status.head_sha,
      review_state_fingerprint: reviewStateFingerprint
    });
    const happyPathAllowed = delegationGate.status !== "blocked";
    if (delegationGate.status === "blocked") {
      warnings.push("DELEGATION_REVIEW_GATE_BLOCKED", ...delegationGate.blocking_reasons);
    } else if (delegationGate.status === "advisory") {
      warnings.push("DELEGATION_REVIEW_GATE_ADVISORY", ...delegationGate.warnings);
    }
    const recoverRestorePaths = [...new Set([...recoverableWorktreePaths, ...stagedRecoveryPaths])].sort();
    const suggestedCommitMessage = suggestCommitMessage(expectedCommitPaths);
    const nextToolPayloads: GitReviewResult["next_tool_payloads"] = {};

    if (recoverableWorktreePaths.length > 0) {
      nextToolPayloads.repo_git_restore_paths_dry_run = {
        repo_id: input.repo_id,
        paths: recoverableWorktreePaths,
        expected_head_sha: status.head_sha,
        dry_run: true
      };
      nextToolPayloads.repo_git_restore_paths_actual = {
        repo_id: input.repo_id,
        paths: recoverableWorktreePaths,
        expected_head_sha: status.head_sha,
        dry_run: false
      };
    }

    if (cleanupPaths.length > 0) {
      nextToolPayloads.repo_cleanup_paths_dry_run = {
        repo_id: input.repo_id,
        paths: cleanupPaths,
        dry_run: true
      };
      nextToolPayloads.repo_cleanup_paths_actual = {
        repo_id: input.repo_id,
        paths: cleanupPaths,
        dry_run: false
      };
    }

    if (stagedPaths.length > 0) {
      nextToolPayloads.repo_write_unstage_dry_run = {
        repo_id: input.repo_id,
        paths: stagedPaths,
        expected_head_sha: status.head_sha,
        dry_run: true
      };
      nextToolPayloads.repo_write_unstage_actual = {
        repo_id: input.repo_id,
        paths: stagedPaths,
        expected_head_sha: status.head_sha,
        dry_run: false
      };
    }

    if (stagedRecoveryPaths.length > 0 || recoverRestorePaths.length > 0 || cleanupPaths.length > 0 || discardPaths.length > 0) {
      nextToolPayloads.repo_write_recover_dry_run = {
        repo_id: input.repo_id,
        expected_head_sha: status.head_sha,
        ...(stagedRecoveryPaths.length > 0 ? { unstage_paths: stagedRecoveryPaths } : {}),
        ...(recoverRestorePaths.length > 0 ? { restore_paths: recoverRestorePaths } : {}),
        ...(cleanupPaths.length > 0 ? { cleanup_paths: cleanupPaths } : {}),
        ...(discardPaths.length > 0 ? { discard_paths: discardPaths } : {}),
        dry_run: true
      };
      nextToolPayloads.repo_write_recover_actual = {
        repo_id: input.repo_id,
        expected_head_sha: status.head_sha,
        ...(stagedRecoveryPaths.length > 0 ? { unstage_paths: stagedRecoveryPaths } : {}),
        ...(recoverRestorePaths.length > 0 ? { restore_paths: recoverRestorePaths } : {}),
        ...(cleanupPaths.length > 0 ? { cleanup_paths: cleanupPaths } : {}),
        ...(discardPaths.length > 0 ? { discard_paths: discardPaths } : {}),
        dry_run: false
      };
    }

    if (stagePaths.length > 0 && happyPathAllowed) {
      nextToolPayloads.repo_write_stage_dry_run = {
        repo_id: input.repo_id,
        paths: stagePaths,
        expected_head_sha: status.head_sha,
        dry_run: true
      };
      nextToolPayloads.repo_write_stage_actual = {
        repo_id: input.repo_id,
        paths: stagePaths,
        expected_head_sha: status.head_sha,
        dry_run: false
      };
      if (stagedPaths.length === 0 && !hasStagedExcludedPaths) {
        nextToolPayloads.repo_write_stage_commit_dry_run = {
          repo_id: input.repo_id,
          paths: stagePaths,
          message: suggestedCommitMessage,
          expected_head_sha: status.head_sha,
          dry_run: true
        };
        nextToolPayloads.repo_write_stage_commit_actual = {
          repo_id: input.repo_id,
          paths: stagePaths,
          message: suggestedCommitMessage,
          expected_head_sha: status.head_sha,
          dry_run: false
        };
      }
    }

    if (expectedCommitPaths.length > 0 && happyPathAllowed) {
      nextToolPayloads.repo_write_commit_dry_run = {
        repo_id: input.repo_id,
        message: suggestedCommitMessage,
        expected_head_sha: status.head_sha,
        expected_staged_paths: expectedCommitPaths,
        dry_run: true
      };
    }

    const canonicalNextToolPayloads: GitReviewResult["next_tool_payloads"] = {};
    if (nextToolPayloads.repo_write_stage_commit_actual) {
      canonicalNextToolPayloads.repo_write_stage_commit = nextToolPayloads.repo_write_stage_commit_actual;
    }
    if (nextToolPayloads.repo_write_recover_actual) {
      canonicalNextToolPayloads.repo_write_recover = nextToolPayloads.repo_write_recover_actual;
    }
    if (stagePaths.length === 0 && stagedPaths.length > 0 && !hasStagedExcludedPaths && happyPathAllowed) {
      canonicalNextToolPayloads.repo_write_commit = {
        repo_id: input.repo_id,
        message: suggestedCommitMessage,
        expected_head_sha: status.head_sha,
        expected_staged_paths: expectedCommitPaths,
        dry_run: false
      };
    }
    const selectedNextToolPayloads = detail === "full"
      ? { ...nextToolPayloads, ...canonicalNextToolPayloads }
      : canonicalNextToolPayloads;

    return {
      ok: true,
      detail,
      branch: status.branch,
      head_sha: status.head_sha,
      clean: status.clean,
      changed_paths: changedPaths,
      diff_summary: {
        file_count: diffCandidatePaths.length,
        truncated: diffSummaryTruncated,
        files: diff.files.map((file) => ({
          path: file.path,
          status: file.status,
          hunk_count: file.hunks.length,
          summary: summarizeDiffFile(file.path, file.status, file.hunks.length)
        }))
      },
      recommendation: {
        ready_to_stage: stagePaths.length > 0 && happyPathAllowed,
        recommended_stage_paths: stagePaths,
        excluded_paths: excludedPaths,
        suggested_commit_message: suggestedCommitMessage,
        risk_level: riskLevel(warnings, excludedPaths),
        warnings,
        ...(stagedRecoveryPaths.length > 0 ? { recovery_guidance: STAGED_RECOVERY_GUIDANCE } : {})
      },
      delegation_gate: delegationGate,
      ship_readiness: shipReadiness,
      next_tool_payloads: status.clean ? {} : selectedNextToolPayloads
    };
  }

  private exclusionReason(path: StatusFile): string | undefined {
    if (isLocalCodexArtifactPath(path.path)) {
      return "LOCAL_CODEX_ARTIFACT_EXCLUDED";
    }
    if (this.ignoreEngine.isSensitiveCandidate(path.path)) {
      return "SECRET_CANDIDATE_REQUIRES_MANUAL_REVIEW";
    }
    if (this.ignoreEngine.isIgnored(path.path) || isGeneratedPath(path.path)) {
      return "GENERATED_PATH_EXCLUDED";
    }
    if (path.status === "deleted") {
      return "DELETED_PATH_REQUIRES_EXPLICIT_REVIEW";
    }
    if (path.status === "renamed") {
      return "RENAMED_PATH_REQUIRES_EXPLICIT_REVIEW";
    }
    return undefined;
  }

  private isCleanupEligible(path: string): boolean {
    if (!this.operationsPolicy.config.enabled || !this.operationsPolicy.config.cleanup_enabled) {
      return false;
    }
    if (this.ignoreEngine.isSensitiveCandidate(path)) {
      return false;
    }
    const matcher = ignore().add(this.operationsPolicy.config.cleanup_allowed_globs);
    return matcher.ignores(path) || matcher.ignores(`${path}/placeholder`);
  }

  private isRecoverableWorktreePath(path: StatusFile): boolean {
    if (path.status === "untracked" || path.status === "renamed") {
      return false;
    }
    return !this.ignoreEngine.isSensitiveCandidate(path.path);
  }

  private async readShipReadiness(headSha: string, worktreeFingerprint: string): Promise<NonNullable<GitReviewResult["ship_readiness"]>> {
    try {
      const raw = await readFile(join(this.root, ".chatgpt", "validation", "latest.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        validation_id?: unknown;
        profile?: unknown;
        focused?: unknown;
        test_paths?: unknown;
        status?: unknown;
        head_sha?: unknown;
        worktree_fingerprint?: unknown;
        artifact_path?: unknown;
      };
      const validationStatus = parsed.status === "passed" || parsed.status === "failed" || parsed.status === "skipped"
        ? parsed.status
        : undefined;
      const validationHead = typeof parsed.head_sha === "string" ? parsed.head_sha : undefined;
      const validationFingerprint = typeof parsed.worktree_fingerprint === "string" ? parsed.worktree_fingerprint : undefined;
      const fingerprintStale = validationFingerprint ? validationFingerprint !== worktreeFingerprint : worktreeFingerprint !== "clean";
      const status = validationHead && validationHead !== headSha
        ? "stale"
        : fingerprintStale
          ? "stale"
        : validationStatus === "passed"
          ? "passed"
          : validationStatus === "failed"
            ? "failed"
            : "missing";
      return {
        validation: {
          status,
          ...(typeof parsed.validation_id === "string" ? { validation_id: parsed.validation_id } : {}),
          ...(validationStatus ? { validation_status: validationStatus } : {}),
          ...(typeof parsed.profile === "string" ? { profile: parsed.profile } : {}),
          ...(parsed.focused === true ? { focused: true } : {}),
          ...(Array.isArray(parsed.test_paths) && parsed.test_paths.every((path) => typeof path === "string") ? { test_paths: parsed.test_paths as string[] } : {}),
          ...(validationHead ? { head_sha: validationHead } : {}),
          ...(validationFingerprint ? { worktree_fingerprint: validationFingerprint } : {}),
          ...(typeof parsed.artifact_path === "string" ? { artifact_path: parsed.artifact_path } : {})
        }
      };
    } catch {
      return { validation: { status: "missing" } };
    }
  }
}

function classifyStatus(index: string, worktree: string): StatusFile["status"] {
  if (index === "?" && worktree === "?") {
    return "untracked";
  }
  if (index === "R" || worktree === "R") {
    return "renamed";
  }
  if (index === "D" || worktree === "D") {
    return "deleted";
  }
  if (index === "A" || worktree === "A") {
    return "added";
  }
  if (index === "M" || worktree === "M") {
    return "modified";
  }
  return "unknown";
}

function isGeneratedPath(path: string): boolean {
  return /^(dist|coverage|test-results|node_modules)\//.test(path);
}

function isLocalCodexArtifactPath(path: string): boolean {
  return path.startsWith(".chatgpt/codex-runs/");
}

type GitDiff = Awaited<ReturnType<GitService["diff"]>>;

function mergeDiffs(stagedDiff: GitDiff, unstagedDiff: GitDiff): GitDiff {
  const filesByPath = new Map<string, GitDiff["files"][number]>();
  for (const file of [...stagedDiff.files, ...unstagedDiff.files]) {
    const existing = filesByPath.get(file.path);
    if (!existing) {
      filesByPath.set(file.path, { ...file, hunks: [...file.hunks] });
      continue;
    }
    filesByPath.set(file.path, {
      ...existing,
      status: existing.status ?? file.status,
      original_path: existing.original_path ?? file.original_path,
      hunks: [...existing.hunks, ...file.hunks]
    });
  }

  const truncationReasons = [stagedDiff.truncation_reason, unstagedDiff.truncation_reason]
    .filter((value): value is NonNullable<GitDiff["truncation_reason"]> => Boolean(value));
  const hasMaxFiles = truncationReasons.some((value) => value.includes("max_files"));
  const hasMaxBytes = truncationReasons.some((value) => value.includes("max_bytes"));
  return {
    base: stagedDiff.base ?? unstagedDiff.base,
    compare: stagedDiff.compare ?? unstagedDiff.compare,
    staged: stagedDiff.staged,
    unstaged: unstagedDiff.unstaged,
    files: [...filesByPath.values()],
    total_file_count: new Set([
      ...stagedDiff.files.map((file) => file.path),
      ...unstagedDiff.files.map((file) => file.path)
    ]).size,
    truncated: stagedDiff.truncated || unstagedDiff.truncated,
    truncation_reason: hasMaxFiles && hasMaxBytes
      ? "max_files+max_bytes"
      : hasMaxFiles ? "max_files" : hasMaxBytes ? "max_bytes" : undefined,
    warnings: [...stagedDiff.warnings, ...unstagedDiff.warnings]
  };
}


function summarizeDiffFile(path: string, status: string | undefined, hunkCount: number): string {
  return `${status ?? "modified"} ${path} (${hunkCount} hunks)`;
}

function suggestCommitMessage(paths: string[]): string {
  if (paths.length === 0) {
    return "No changes to commit";
  }
  if (paths.every((path) => path.startsWith("docs/") || path.startsWith(".chatgpt/"))) {
    return "Update docs";
  }
  if (paths.some((path) => path.startsWith("src/tools/"))) {
    return "Update tool surface";
  }
  if (paths.some((path) => path.startsWith("src/services/") || path.startsWith("src/contracts/"))) {
    return "Update write tooling";
  }
  if (paths.some((path) => path.startsWith("tests/"))) {
    return "Update tests";
  }
  return "Update reviewed files";
}

function riskLevel(warnings: string[], excludedPaths: Array<{ path: string; reason: string }>): "low" | "medium" | "high" {
  if (excludedPaths.some((path) => path.reason.includes("SECRET"))) {
    return "high";
  }
  if (warnings.length === 1 && warnings[0] === "NO_CHANGES") {
    return "low";
  }
  if (warnings.length > 0 || excludedPaths.length > 0) {
    return "medium";
  }
  return "low";
}
