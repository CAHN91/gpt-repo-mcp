import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  GitCommitResult,
  GitRecoverResult,
  GitRestorePathsResult,
  GitStageCommitResult,
  GitStageResult,
  GitUnstageResult
} from "../contracts/git-operations.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { CleanupService } from "./cleanup-service.js";
import { validateRepoPath } from "./path-sandbox.js";
import { OperationsPolicy } from "./operations-policy.js";
import { SecretScanner } from "./secret-scanner.js";
import { DelegationGateService } from "./delegation-gate-service.js";
import { GitService } from "./git-service.js";
import { IntegrationReviewService } from "./integration-review-service.js";
import { PathSandbox } from "./path-sandbox.js";
import { runGitBounded } from "./git-exec.js";
import {
  assertExistingParentWithinRoot,
  assertNoDuplicateDeletionPaths,
  assertRealPathWithinRoot,
  gitOperationEnv,
  isAllowedEnvTemplatePath,
  isGeneratedOrDependencyPath,
  isHardSecretPath,
  samePathSet
} from "./git-operation-safety.js";

type StageInput = {
  repo_id?: string;
  paths: string[];
  expected_head_sha: string;
  dry_run?: boolean;
};

type RestorePathsInput = StageInput;

type CommitInput = {
  repo_id?: string;
  message: string;
  expected_head_sha: string;
  expected_staged_paths: string[];
  dry_run?: boolean;
};

type StageCommitInput = {
  repo_id?: string;
  paths?: string[];
  review_pathset_id?: string;
  message: string;
  expected_head_sha: string;
  dry_run?: boolean;
};

type RecoverInput = {
  expected_head_sha: string;
  unstage_paths?: string[];
  restore_paths?: string[];
  cleanup_paths?: string[];
  discard_paths?: string[];
  dry_run?: boolean;
};

export class GitOperationsService {
  private readonly secretScanner = new SecretScanner();

  constructor(
    private readonly root: string,
    private readonly policy: OperationsPolicy,
    private readonly delegationGate: DelegationGateService = new DelegationGateService(root)
  ) {}

  async validateReviewBoundPaths(paths: string[]): Promise<string[]> {
    this.policy.assertReviewBoundStageCommitAllowed(paths);
    return this.validateExplicitPaths(paths);
  }

  async stage(input: StageInput): Promise<GitStageResult> {
    this.policy.assertStageAllowed(input.paths);
    const headSha = await this.assertExpectedHead(input.expected_head_sha);
    const paths = await this.validateExplicitPaths(input.paths);
    const gate = await this.delegationGate.assertAllowed({
      repo_id: input.repo_id ?? "unknown",
      paths,
      operation: "stage",
      head_sha: headSha,
      review_state_fingerprint: await new GitService(this.root).reviewStateFingerprint()
    });

    if (!input.dry_run) {
      await this.git(["add", "--", ...paths]);
    }
    return {
      ok: true,
      dry_run: input.dry_run ?? false,
      head_sha: headSha,
      staged_paths: paths,
      skipped: [],
      warnings: gate.warnings
    };
  }

  async unstage(input: StageInput): Promise<GitUnstageResult> {
    this.policy.assertStageAllowed(input.paths);
    const headSha = await this.assertExpectedHead(input.expected_head_sha);
    const paths = await this.validateExplicitPaths(input.paths);

    if (!input.dry_run) {
      await this.git(["restore", "--staged", "--", ...paths]);
    }
    return {
      ok: true,
      dry_run: input.dry_run ?? false,
      head_sha: headSha,
      unstaged_paths: paths,
      skipped: [],
      warnings: []
    };
  }

  async restorePaths(input: RestorePathsInput): Promise<GitRestorePathsResult> {
    this.policy.assertRestoreAllowed(input.paths);
    const headSha = await this.assertExpectedHead(input.expected_head_sha);
    const paths = await this.validateExplicitPaths(input.paths, { scanEnvTemplateContent: false });

    if (!input.dry_run) {
      await this.git(["restore", "--", ...paths]);
    }
    return {
      ok: true,
      dry_run: input.dry_run ?? false,
      head_sha: headSha,
      restored_paths: paths,
      skipped: [],
      warnings: []
    };
  }

  async commit(input: CommitInput): Promise<GitCommitResult> {
    this.policy.assertCommitAllowed(input.expected_staged_paths);
    const headBefore = await this.assertExpectedHead(input.expected_head_sha);
    this.validateCommitMessage(input.message);
    const expectedPaths = await this.validateExplicitPaths(input.expected_staged_paths);
    const actualPaths = await this.stagedPaths();
    if (actualPaths.length === 0) {
      throw new RepoReaderError("GIT_NOTHING_STAGED", "No staged changes are available to commit.");
    }
    await this.validateExplicitPaths(actualPaths);
    if (!samePathSet(actualPaths, expectedPaths)) {
      throw new RepoReaderError("GIT_STAGED_PATHS_MISMATCH", "Actual staged paths do not match expected_staged_paths.", {
        diagnostics: { actual_paths: actualPaths, expected_paths: expectedPaths }
      });
    }
    const gate = await this.delegationGate.assertAllowed({
      repo_id: input.repo_id ?? "unknown",
      paths: actualPaths,
      operation: "commit",
      head_sha: headBefore,
      review_state_fingerprint: await new GitService(this.root).reviewStateFingerprint()
    });

    if (input.dry_run) {
      return {
        ok: true,
        dry_run: true,
        head_before: headBefore,
        committed_paths: actualPaths,
        warnings: gate.warnings
      };
    }

    await this.git(["commit", "-m", input.message]);
    const headAfter = await this.headSha();
    return {
      ok: true,
      dry_run: false,
      head_before: headBefore,
      head_after: headAfter,
      commit_sha: headAfter,
      committed_paths: actualPaths,
      warnings: gate.warnings
    };
  }

  async stageCommit(input: StageCommitInput): Promise<GitStageCommitResult> {
    const headBefore = await this.assertExpectedHead(input.expected_head_sha);
    this.validateCommitMessage(input.message);
    const integration = input.review_pathset_id
      ? await new IntegrationReviewService(this.root, new PathSandbox(this.root), this.policy).resolvePathset({
          repo_id: input.repo_id ?? "unknown",
          integration_id: input.review_pathset_id,
          expected_head_sha: headBefore
        })
      : undefined;
    if (integration && integration.commit_message !== input.message) {
      throw new RepoReaderError("DELEGATION_REVIEW_GATE_BLOCKED", "Commit message does not match the integration review.");
    }
    const requestedPaths = integration?.reviewed_paths ?? input.paths ?? [];
    if (integration) this.policy.assertReviewBoundStageCommitAllowed(requestedPaths);
    else {
      this.policy.assertStageAllowed(requestedPaths);
      this.policy.assertCommitAllowed(requestedPaths);
    }
    const paths = await this.validateExplicitPaths(requestedPaths);
    const preStagedPaths = await this.stagedPaths();
    if (preStagedPaths.length > 0 && !samePathSet(preStagedPaths, paths)) {
      throw new RepoReaderError("GIT_STAGED_PATHS_MISMATCH", "Actual staged paths do not match requested stage-and-commit paths.", {
        diagnostics: { actual_paths: preStagedPaths, expected_paths: paths }
      });
    }
    const preGate = await this.delegationGate.assertAllowed({
      repo_id: input.repo_id ?? "unknown",
      paths,
      operation: "stage_commit",
      head_sha: headBefore,
      review_state_fingerprint: await new GitService(this.root).reviewStateFingerprint()
    });

    if (input.dry_run) {
      return {
        ok: true,
        dry_run: true,
        head_before: headBefore,
        staged_paths: paths,
        committed_paths: paths,
        warnings: preGate.warnings
      };
    }

    await this.git(["add", "--", ...paths]);
    if (integration) {
      await new IntegrationReviewService(this.root, new PathSandbox(this.root), this.policy).resolvePathset({
        repo_id: input.repo_id ?? "unknown",
        integration_id: integration.integration_id,
        expected_head_sha: headBefore
      });
    }
    const actualPaths = await this.stagedPaths();
    await this.validateExplicitPaths(actualPaths);
    if (actualPaths.length === 0) {
      throw new RepoReaderError("GIT_NOTHING_STAGED", "No staged changes are available to commit.");
    }
    if (!samePathSet(actualPaths, paths)) {
      if (preStagedPaths.length === 0) {
        await this.git(["restore", "--staged", "--", ...actualPaths]).catch(() => undefined);
      }
      throw new RepoReaderError("GIT_STAGED_PATHS_MISMATCH", "Actual staged paths do not match requested stage-and-commit paths.", {
        diagnostics: { actual_paths: actualPaths, expected_paths: paths }
      });
    }

    let postGate;
    try {
      postGate = await this.delegationGate.assertAllowed({
        repo_id: input.repo_id ?? "unknown",
        paths: actualPaths,
        operation: "stage_commit",
        head_sha: headBefore,
        review_state_fingerprint: await new GitService(this.root).reviewStateFingerprint()
      });
    } catch (error) {
      if (preStagedPaths.length === 0) {
        await this.git(["restore", "--staged", "--", ...actualPaths]).catch(() => undefined);
      }
      throw error;
    }

    await this.git(["commit", "-m", input.message]);
    const headAfter = await this.headSha();
    const status = await this.statusSummary();
    return {
      ok: true,
      dry_run: false,
      head_before: headBefore,
      head_after: headAfter,
      commit_sha: headAfter,
      ...(integration ? { review_pathset_id: integration.integration_id } : {}),
      staged_paths: paths,
      committed_paths: actualPaths,
      remaining_changes: status.remaining_changes,
      clean_after: status.clean_after,
      warnings: [...new Set([...preGate.warnings, ...postGate.warnings])]
    };
  }

  async recover(input: RecoverInput): Promise<GitRecoverResult> {
    const unstagePathsInput = input.unstage_paths ?? [];
    const restorePathsInput = input.restore_paths ?? [];
    const cleanupPathsInput = input.cleanup_paths ?? [];
    const discardPathsInput = input.discard_paths ?? [];
    if (unstagePathsInput.length === 0 && restorePathsInput.length === 0 && cleanupPathsInput.length === 0 && discardPathsInput.length === 0) {
      throw new RepoReaderError("GIT_OPERATION_PATHS_REQUIRED", "At least one explicit recovery path is required.");
    }

    const headSha = await this.assertExpectedHead(input.expected_head_sha);
    if (unstagePathsInput.length > 0) {
      this.policy.assertStageAllowed(unstagePathsInput);
    }
    if (restorePathsInput.length > 0) {
      this.policy.assertRestoreAllowed(restorePathsInput);
    }

    const unstagePaths = unstagePathsInput.length > 0 ? await this.validateExplicitPaths(unstagePathsInput) : [];
    const restorePaths = restorePathsInput.length > 0 ? await this.validateExplicitPaths(restorePathsInput, { scanEnvTemplateContent: false }) : [];
    const discardPreview = discardPathsInput.length > 0 ? await this.validateDiscardPaths(discardPathsInput) : [];
    const cleanupService = new CleanupService(this.root, this.policy);
    const cleanupPreview = cleanupPathsInput.length > 0
      ? await cleanupService.cleanup({ paths: cleanupPathsInput, dry_run: true })
      : { deleted: [], skipped: [], warnings: [] };
    assertNoDuplicateDeletionPaths(cleanupPreview.deleted, discardPreview);

    if (!input.dry_run) {
      if (unstagePaths.length > 0) {
        await this.git(["restore", "--staged", "--", ...unstagePaths]);
      }
      if (restorePaths.length > 0) {
        await this.git(["restore", "--", ...restorePaths]);
      }
      if (cleanupPathsInput.length > 0) {
        await cleanupService.cleanup({ paths: cleanupPathsInput });
      }
      for (const entry of discardPreview) {
        await rm(join(this.root, entry.path));
      }
    }

    const status = await this.statusSummary();
    return {
      ok: true,
      dry_run: input.dry_run ?? false,
      head_sha: headSha,
      unstaged_paths: unstagePaths,
      restored_paths: restorePaths,
      deleted: cleanupPreview.deleted,
      discarded: discardPreview,
      skipped: cleanupPreview.skipped,
      remaining_changes: status.remaining_changes,
      clean_after: status.clean_after,
      warnings: cleanupPreview.warnings
    };
  }

  private async assertExpectedHead(expectedHeadSha: string): Promise<string> {
    const headSha = await this.headSha();
    if (headSha !== expectedHeadSha) {
      throw new RepoReaderError("GIT_HEAD_MISMATCH", "Current HEAD does not match expected_head_sha.", {
        diagnostics: { head_sha: headSha, expected_head_sha: expectedHeadSha }
      });
    }
    return headSha;
  }

  private async headSha(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  private async stagedPaths(): Promise<string[]> {
    return (await this.git(["diff", "--name-only", "--cached"]))
      .split("\n")
      .filter(Boolean)
      .sort();
  }

  private async statusSummary(): Promise<{ remaining_changes: number; clean_after: boolean }> {
    const output = await this.git(["status", "--porcelain=v1", "--untracked-files=all"]);
    const remainingChanges = output.split("\n").filter(Boolean).length;
    return {
      remaining_changes: remainingChanges,
      clean_after: remainingChanges === 0
    };
  }

  private async validateExplicitPaths(paths: string[], options: { scanEnvTemplateContent?: boolean } = {}): Promise<string[]> {
    const normalized = paths.map((path) => this.validateExplicitPath(path));
    for (const path of normalized) {
      await this.assertWithinRoot(path);
      if (options.scanEnvTemplateContent ?? true) {
        await this.assertSafeEnvTemplateContent(path);
      }
    }
    return normalized;
  }

  private async validateDiscardPaths(paths: string[]): Promise<Array<{ path: string; type: "file" | "directory" }>> {
    this.policy.assertRestoreAllowed(paths);
    const normalized = await this.validateExplicitPaths(paths, { scanEnvTemplateContent: false });
    const discarded: Array<{ path: string; type: "file" | "directory" }> = [];
    for (const path of normalized) {
      if (isGeneratedOrDependencyPath(path)) {
        throw new RepoReaderError("DISCARD_PATH_NOT_ALLOWED", `Discard path is generated, cached, or dependency-owned: ${path}`);
      }
      const tracked = (await this.git(["ls-files", "--", path])).trim();
      if (tracked.length > 0) {
        throw new RepoReaderError("DISCARD_TRACKED_PATH_REJECTED", `Discard refuses tracked files: ${path}`);
      }
      const stat = await lstat(join(this.root, path));
      if (stat.isSymbolicLink()) {
        throw new RepoReaderError("DISCARD_UNSUPPORTED_FILE_TYPE", `Discard refuses symlinks: ${path}`);
      }
      if (!stat.isFile()) {
        throw new RepoReaderError("DISCARD_UNSUPPORTED_FILE_TYPE", `Discard supports regular untracked files only: ${path}`);
      }
      discarded.push({ path, type: "file" });
    }
    return discarded;
  }

  private validateExplicitPath(path: string): string {
    const normalized = validateRepoPath(path);
    if (normalized === "." || normalized === "*" || /[*?[\]{}]/.test(normalized) || /(?:^|\/)\.\.(?:\/|$)/.test(normalized)) {
      throw new RepoReaderError("GIT_OPERATION_UNSAFE_PATHSPEC", `Unsafe git pathspec rejected: ${path}`);
    }
    if (/[\0\r\n;&|`$<>]/.test(normalized) || normalized.startsWith(":") || normalized.startsWith("-")) {
      throw new RepoReaderError("GIT_OPERATION_UNSAFE_PATHSPEC", `Unsafe git pathspec rejected: ${path}`);
    }
    if (normalized === ".git" || normalized.startsWith(".git/")) {
      throw new RepoReaderError("GIT_OPERATION_UNSAFE_PATHSPEC", `Git internals cannot be staged: ${path}`);
    }
    if (isHardSecretPath(normalized) && !isAllowedEnvTemplatePath(normalized)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret candidate blocked: ${normalized}`);
    }
    return normalized;
  }

  private async assertSafeEnvTemplateContent(repoPath: string): Promise<void> {
    if (!isAllowedEnvTemplatePath(repoPath)) {
      return;
    }

    const content = await readFile(join(this.root, repoPath), "utf8");
    if (this.secretScanner.hasSecretValue(content)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret content blocked: ${repoPath}`);
    }
  }

  private validateCommitMessage(message: string): void {
    const trimmed = message.trim();
    if (trimmed.length === 0 || /[\0\r\n]/.test(message) || /(?:&&|\|\||;|`|\$\(|<|>)/.test(message)) {
      throw new RepoReaderError("GIT_COMMIT_MESSAGE_INVALID", "Commit message is empty or contains command-like syntax.");
    }
  }

  private async assertWithinRoot(repoPath: string): Promise<void> {
    const absolutePath = join(this.root, repoPath);
    try {
      const stat = await lstat(absolutePath);
      if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Unsupported file type: ${repoPath}`);
      }
      await assertRealPathWithinRoot(this.root, absolutePath);
      return;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    await assertExistingParentWithinRoot(this.root, repoPath);
  }

  private async git(args: string[]): Promise<string> {
    const result = await runGitBounded({
      root: this.root,
      args,
      max_stdout_bytes: 16 * 1024 * 1024,
      max_stderr_bytes: 256 * 1024,
      env: gitOperationEnv()
    });
    return result.stdout;
  }
}
