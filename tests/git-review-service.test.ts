import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { CleanupService } from "../src/services/cleanup-service.js";
import { GitOperationsService } from "../src/services/git-operations-service.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { GitService } from "../src/services/git-service.js";
import { OperationsPolicy } from "../src/services/operations-policy.js";

const execFileAsync = promisify(execFile);

describe("GitReviewService", () => {
  test("clean repo returns NO_CHANGES and no payloads", async () => {
    const fixture = await createGitFixture();
    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.detail).toBe("compact");
    expect(result.clean).toBe(true);
    expect(result.changed_paths).toEqual([]);
    expect(result.recommendation).toMatchObject({
      ready_to_stage: false,
      recommended_stage_paths: [],
      suggested_commit_message: "No changes to commit",
      risk_level: "low",
      warnings: ["NO_CHANGES"]
    });
    expect(result.recommendation).not.toHaveProperty("recovery_guidance");
    expect(result.next_tool_payloads).toEqual({});
  });

  test("compact detail returns only canonical actual composite payloads and is materially smaller", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");
    const service = new GitReviewService(fixture.root);

    const compact = await service.review({ repo_id: "fixture", detail: "compact" });
    const full = await service.review({ repo_id: "fixture", detail: "full" });

    expect(compact.detail).toBe("compact");
    expect(Object.keys(compact.next_tool_payloads).sort()).toEqual([
      "repo_write_recover",
      "repo_write_stage_commit"
    ]);
    expect(compact.next_tool_payloads.repo_write_stage_commit).toMatchObject({
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: false
    });
    expect(compact.next_tool_payloads.repo_write_recover).toMatchObject({
      restore_paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: false
    });
    expect(compact.next_tool_payloads.repo_write_stage_commit_actual).toBeUndefined();
    expect(compact.next_tool_payloads.repo_write_stage_dry_run).toBeUndefined();
    expect(compact.next_tool_payloads.repo_git_restore_paths_actual).toBeUndefined();

    expect(full.detail).toBe("full");
    expect(full.next_tool_payloads.repo_write_stage_commit).toBeDefined();
    expect(full.next_tool_payloads.repo_write_recover).toBeDefined();
    expect(full.next_tool_payloads.repo_write_stage_commit_actual).toBeDefined();
    expect(full.next_tool_payloads.repo_write_stage_dry_run).toBeDefined();
    expect(full.next_tool_payloads.repo_git_restore_paths_actual).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThan(
      Buffer.byteLength(JSON.stringify(full), "utf8") * 0.7
    );
  });

  test("compact staged-only review returns one canonical local commit payload", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");
    await execFileAsync("git", ["add", "--", "docs/a.md"], { cwd: fixture.root });

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", detail: "compact" });

    expect(Object.keys(result.next_tool_payloads).sort()).toEqual([
      "repo_write_commit",
      "repo_write_recover"
    ]);
    expect(result.next_tool_payloads.repo_write_commit).toEqual({
      repo_id: "fixture",
      message: "Update docs",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["docs/a.md"],
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_stage_commit).toBeUndefined();
  });

  test("modified tracked files produce explicit recommended paths and composite payloads", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", detail: "full" });

    expect(result.clean).toBe(false);
    expect(result.head_sha).toBe(fixture.head);
    expect(result.changed_paths).toEqual([
      expect.objectContaining({
        path: "docs/a.md",
        status: "modified",
        staged: false,
        unstaged: true
      })
    ]);
    expect(result.recommendation.recommended_stage_paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_git_restore_paths_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_git_restore_paths_actual).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_stage_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_stage_actual?.dry_run).toBe(false);
    expect(result.next_tool_payloads.repo_write_commit_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["docs/a.md"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      message: "Update docs",
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      message: "Update docs",
      expected_head_sha: fixture.head,
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      restore_paths: ["docs/a.md"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_actual).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      restore_paths: ["docs/a.md"],
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_recover_dry_run).not.toHaveProperty("unstage_paths");
    expectNoGeneratedReasons(result.next_tool_payloads);

    const operations = new GitOperationsService(fixture.root, createFullOperationsPolicy());
    await expect(operations.stage(result.next_tool_payloads.repo_write_stage_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      staged_paths: ["docs/a.md"]
    });
    await expect(operations.stageCommit(result.next_tool_payloads.repo_write_stage_commit_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      staged_paths: ["docs/a.md"],
      committed_paths: ["docs/a.md"]
    });
    await expect(operations.restorePaths(result.next_tool_payloads.repo_git_restore_paths_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      restored_paths: ["docs/a.md"]
    });
    await expect(operations.recover(result.next_tool_payloads.repo_write_recover_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      restored_paths: ["docs/a.md"]
    });
  });

  test("staged files produce commit dry-run payload with expected_staged_paths", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan", detail: "full" });

    expect(result.recommendation.ready_to_stage).toBe(false);
    expect(result.recommendation.recommended_stage_paths).toEqual([]);
    expect(result.next_tool_payloads.repo_write_stage_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toBeUndefined();
    expect(result.next_tool_payloads.repo_git_restore_paths_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_git_restore_paths_actual).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      unstage_paths: ["docs/a.md"],
      restore_paths: ["docs/a.md"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_actual).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      unstage_paths: ["docs/a.md"],
      restore_paths: ["docs/a.md"],
      dry_run: false
    });
    expect(result.recommendation.warnings).toContain("STAGED_RECOVERY_REQUIRES_UNSTAGE_FIRST");
    expect(result.recommendation.recovery_guidance).toEqual([
      "Staged paths cannot be restored directly with repo_git_restore_paths because restore is worktree-only.",
      "For bad staged changes, use repo_write_recover with the review-provided unstage_paths and restore_paths, or use repo_write_unstage first when granular control is needed.",
      "If the staged diff is good, call repo_write_commit with the review-provided repo_write_commit_dry_run payload; it sets dry_run=true."
    ]);
    expect(result.next_tool_payloads.repo_write_unstage_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_unstage_actual).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_commit_dry_run).toEqual({
      repo_id: "fixture",
      message: "Update docs",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["docs/a.md"],
      dry_run: true
    });
    expectNoGeneratedReasons(result.next_tool_payloads);
  });

  test("staged Codex run artifacts are excluded from commit and stage payloads", async () => {
    const fixture = await createGitFixture();
    const resultPath = ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md";
    await mkdir(join(fixture.root, ".chatgpt", "codex-runs", "2026-06-04T081500Z-fix-login-expiry"), { recursive: true });
    await writeFile(join(fixture.root, resultPath), "# CODEX_RESULT\nstatus: completed\nsummary: local only\n");
    await git(fixture.root, ["add", "--", resultPath]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan", detail: "full" });

    expect(result.recommendation.excluded_paths).toContainEqual({
      path: resultPath,
      reason: "LOCAL_CODEX_ARTIFACT_EXCLUDED"
    });
    expect(result.recommendation.recommended_stage_paths).not.toContain(resultPath);
    expect(result.next_tool_payloads.repo_write_stage_dry_run?.paths ?? []).not.toContain(resultPath);
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run?.paths ?? []).not.toContain(resultPath);
    expect(result.next_tool_payloads.repo_write_commit_dry_run?.expected_staged_paths ?? []).not.toContain(resultPath);
  });

  test("staged Codex run artifacts block one-shot stage commit payloads for other files", async () => {
    const fixture = await createGitFixture();
    const resultPath = ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md";
    await mkdir(join(fixture.root, ".chatgpt", "codex-runs", "2026-06-04T081500Z-fix-login-expiry"), { recursive: true });
    await writeFile(join(fixture.root, resultPath), "# CODEX_RESULT\nstatus: completed\nsummary: local only\n");
    await git(fixture.root, ["add", "--", resultPath]);
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan", detail: "full" });

    expect(result.recommendation.recommended_stage_paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_write_stage_dry_run?.paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_commit_dry_run?.expected_staged_paths ?? []).not.toContain(resultPath);
  });

  test("mixed staged and unstaged tracked files produce commit payload for post-stage union", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A staged\n");
    await writeFile(join(fixture.root, "docs", "b.md"), "B unstaged\n");
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", mode: "commit_plan", detail: "full" });

    expect(result.next_tool_payloads.repo_write_stage_dry_run?.paths).toEqual(["docs/b.md"]);
    expect(result.next_tool_payloads.repo_git_restore_paths_dry_run?.paths).toEqual(["docs/b.md"]);
    expect(result.next_tool_payloads.repo_write_unstage_dry_run?.paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      unstage_paths: ["docs/a.md"],
      restore_paths: ["docs/a.md", "docs/b.md"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_actual).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      unstage_paths: ["docs/a.md"],
      restore_paths: ["docs/a.md", "docs/b.md"],
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toBeUndefined();
    expect(result.recommendation.warnings).toContain("STAGED_RECOVERY_REQUIRES_UNSTAGE_FIRST");
    expect(result.recommendation.recovery_guidance?.join(" ")).toContain("repo_write_recover");
    expect(result.next_tool_payloads.repo_write_commit_dry_run?.expected_staged_paths).toEqual([
      "docs/a.md",
      "docs/b.md"
    ]);
    expect(result.recommendation.suggested_commit_message).toBe("Update docs");
    expectNoGeneratedReasons(result.next_tool_payloads);
  });

  test("staged-only changes are represented in diff summary", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A staged\n");
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.diff_summary).toMatchObject({
      file_count: 1,
      truncated: false
    });
    expect(result.diff_summary.files).toEqual([
      expect.objectContaining({
        path: "docs/a.md",
        hunk_count: 1
      })
    ]);
  });

  test("safe untracked files are recommended for staging with stage-commit payloads", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "new.md"), "New\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", detail: "full" });

    expect(result.changed_paths).toEqual([
      expect.objectContaining({
        path: "docs/new.md",
        status: "untracked",
        staged: false,
        unstaged: true
      })
    ]);
    expect(result.recommendation.recommended_stage_paths).toEqual(["docs/new.md"]);
    expect(result.recommendation.excluded_paths).toEqual([]);
    expect(result.recommendation.warnings).toContain("UNTRACKED_PATHS_REVIEWED_FOR_STAGING");
    expect(result.recommendation).not.toHaveProperty("recovery_guidance");
    expect(result.next_tool_payloads.repo_write_stage_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/new.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/new.md"],
      message: "Update docs",
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_actual).toEqual({
      repo_id: "fixture",
      paths: ["docs/new.md"],
      message: "Update docs",
      expected_head_sha: fixture.head,
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_commit_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["docs/new.md"],
      dry_run: true
    });
    expectNoGeneratedReasons(result.next_tool_payloads);

    const operations = new GitOperationsService(fixture.root, createFullOperationsPolicy());
    await expect(operations.stageCommit(result.next_tool_payloads.repo_write_stage_commit_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      staged_paths: ["docs/new.md"],
      committed_paths: ["docs/new.md"]
    });
  });

  test("paths scopes review recommendations and mutation payloads to the current task", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A target changed\n");
    await writeFile(join(fixture.root, "docs", "unrelated-audit.md"), "Audit\n");
    await writeFile(join(fixture.root, "docs", "b.md"), "B changed\n");

    const result = await new GitReviewService(fixture.root).review({
      repo_id: "fixture",
      detail: "full",
      paths: ["docs/a.md"]
    });

    expect(result.changed_paths.map((entry) => entry.path)).toEqual(["docs/a.md"]);
    expect(result.diff_summary.files.map((entry) => entry.path)).toEqual(["docs/a.md"]);
    expect(result.recommendation.recommended_stage_paths).toEqual(["docs/a.md"]);
    expect(result.recommendation.warnings).toContain("REVIEW_SCOPE_APPLIED");
    expect(result.recommendation.warnings).toContain("REVIEW_SCOPE_OMITTED_CHANGED_PATHS");
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["docs/a.md"],
      message: "Update docs",
      expected_head_sha: fixture.head,
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_actual?.paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_write_stage_dry_run?.paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_write_commit_dry_run?.expected_staged_paths).toEqual(["docs/a.md"]);
    expect(result.next_tool_payloads.repo_write_recover_dry_run?.restore_paths).toEqual(["docs/a.md"]);
  });

  test("paths scopes diff loading before unrelated diff truncation can hide the target", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "aaa-huge.md"), "small\n");
    await git(fixture.root, ["add", "--", "docs/aaa-huge.md"]);
    await git(fixture.root, ["commit", "-m", "add huge fixture"]);
    const head = (await git(fixture.root, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(fixture.root, "docs", "aaa-huge.md"), `${"x".repeat(300_000)}\n`);
    await writeFile(join(fixture.root, "docs", "b.md"), "B target changed\n");

    const result = await new GitReviewService(fixture.root).review({
      repo_id: "fixture",
      detail: "full",
      paths: ["docs/b.md"]
    });

    expect(result.diff_summary.truncated).toBe(false);
    expect(result.diff_summary.files.map((entry) => entry.path)).toEqual(["docs/b.md"]);
    expect(result.recommendation.recommended_stage_paths).toEqual(["docs/b.md"]);
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run?.expected_head_sha).toBe(head);
    expect(result.recommendation.warnings).toContain("REVIEW_SCOPE_APPLIED");
    expect(result.recommendation.warnings).not.toContain("DIFF_SUMMARY_TRUNCATED");
  });

  test("untracked secret candidates remain excluded from staging", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, ".env.local"), "TOKEN=secret\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.recommendation.recommended_stage_paths).toEqual([]);
    expect(result.recommendation.excluded_paths).toEqual([
      { path: ".env.local", reason: "SECRET_CANDIDATE_REQUIRES_MANUAL_REVIEW" }
    ]);
    expect(result.next_tool_payloads.repo_write_stage_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
  });

  test("generated, cache, and dependency untracked paths remain excluded from staging", async () => {
    const fixture = await createGitFixture();
    await mkdir(join(fixture.root, "dist"), { recursive: true });
    await mkdir(join(fixture.root, ".cache"), { recursive: true });
    await mkdir(join(fixture.root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(fixture.root, "dist", "bundle.js"), "bundle\n");
    await writeFile(join(fixture.root, ".cache", "entry.json"), "{}\n");
    await writeFile(join(fixture.root, "node_modules", "pkg", "index.js"), "module.exports = {}\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.recommendation.recommended_stage_paths).toEqual([]);
    expect(result.recommendation.excluded_paths).toEqual([
      { path: ".cache/entry.json", reason: "GENERATED_PATH_EXCLUDED" },
      { path: "dist/bundle.js", reason: "GENERATED_PATH_EXCLUDED" },
      { path: "node_modules/pkg/index.js", reason: "GENERATED_PATH_EXCLUDED" }
    ]);
    expect(result.next_tool_payloads.repo_write_stage_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
  });

  test("cleanup-eligible untracked generated files produce cleanup payloads", async () => {
    const fixture = await createGitFixture();
    await mkdir(join(fixture.root, "coverage"), { recursive: true });
    await writeFile(join(fixture.root, "coverage", "report.txt"), "coverage\n");

    const result = await new GitReviewService(fixture.root, createCleanupPolicy()).review({ repo_id: "fixture", detail: "full" });

    expect(result.changed_paths).toEqual([
      expect.objectContaining({
        path: "coverage/report.txt",
        status: "untracked",
        staged: false,
        unstaged: true
      })
    ]);
    expect(result.recommendation.recommended_stage_paths).toEqual([]);
    expect(result.recommendation.excluded_paths).toEqual([
      { path: "coverage/report.txt", reason: "GENERATED_PATH_EXCLUDED" }
    ]);
    expect(result.next_tool_payloads.repo_cleanup_paths_dry_run).toEqual({
      repo_id: "fixture",
      paths: ["coverage/report.txt"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_cleanup_paths_actual).toEqual({
      repo_id: "fixture",
      paths: ["coverage/report.txt"],
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      cleanup_paths: ["coverage/report.txt"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_actual).toEqual({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      cleanup_paths: ["coverage/report.txt"],
      dry_run: false
    });
    expect(result.recommendation).not.toHaveProperty("recovery_guidance");
    expectNoGeneratedReasons(result.next_tool_payloads);

    const cleanup = new CleanupService(fixture.root, createCleanupPolicy());
    await expect(cleanup.cleanup(result.next_tool_payloads.repo_cleanup_paths_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      deleted: [{ path: "coverage/report.txt", type: "file" }]
    });
    const operations = new GitOperationsService(fixture.root, createCleanupPolicy());
    await expect(operations.recover(result.next_tool_payloads.repo_write_recover_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      deleted: [{ path: "coverage/report.txt", type: "file" }]
    });
  });

  test("untracked Codex run artifacts produce cleanup payloads and are excluded from staging", async () => {
    const fixture = await createGitFixture();
    const resultPath = ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md";
    await mkdir(join(fixture.root, ".chatgpt", "codex-runs", "2026-06-04T081500Z-fix-login-expiry"), { recursive: true });
    await writeFile(join(fixture.root, resultPath), "# CODEX_RESULT\nstatus: completed\nsummary: local only\n");

    const result = await new GitReviewService(fixture.root, createCleanupPolicy()).review({ repo_id: "fixture", detail: "full" });

    expect(result.recommendation.excluded_paths).toContainEqual({
      path: resultPath,
      reason: "LOCAL_CODEX_ARTIFACT_EXCLUDED"
    });
    expect(result.recommendation.recommended_stage_paths).not.toContain(resultPath);
    expect(result.next_tool_payloads.repo_cleanup_paths_dry_run).toEqual({
      repo_id: "fixture",
      paths: [resultPath],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      cleanup_paths: [resultPath],
      dry_run: true
    });
  });

  test("untracked non-cleanup-eligible files produce reviewed discard recovery payloads", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "new.md"), "New\n");

    const result = await new GitReviewService(fixture.root, createCleanupPolicy()).review({ repo_id: "fixture", detail: "full" });

    expect(result.next_tool_payloads.repo_cleanup_paths_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_cleanup_paths_actual).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      discard_paths: ["docs/new.md"],
      dry_run: true
    });
    expect(result.next_tool_payloads.repo_write_recover_actual).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      discard_paths: ["docs/new.md"],
      dry_run: false
    });
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run?.paths).toEqual(["docs/new.md"]);
    expect(result.recommendation.warnings).toContain("UNTRACKED_PATHS_REVIEWED_FOR_STAGING");

    const operations = new GitOperationsService(fixture.root, createFullOperationsPolicy());
    await expect(operations.recover(result.next_tool_payloads.repo_write_recover_dry_run!)).resolves.toMatchObject({
      dry_run: true,
      discarded: [{ path: "docs/new.md", type: "file" }]
    });
  });

  test("deleted tracked worktree path produces recover restore payload but no stage commit payload", async () => {
    const fixture = await createGitFixture();
    await git(fixture.root, ["rm", "--", "docs/a.md"]);
    await git(fixture.root, ["restore", "--staged", "--", "docs/a.md"]);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", detail: "full" });

    expect(result.recommendation.recommended_stage_paths).toEqual([]);
    expect(result.recommendation.excluded_paths).toEqual([
      { path: "docs/a.md", reason: "DELETED_PATH_REQUIRES_EXPLICIT_REVIEW" }
    ]);
    expect(result.next_tool_payloads.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_recover_dry_run).toMatchObject({
      repo_id: "fixture",
      expected_head_sha: fixture.head,
      restore_paths: ["docs/a.md"],
      dry_run: true
    });
  });

  test("truncated diff summary propagates warning and elevated risk", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");
    await writeFile(join(fixture.root, "docs", "b.md"), "B changed\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", max_files: 1 });

    expect(result.diff_summary).toMatchObject({
      file_count: 2,
      truncated: true
    });
    expect(result.diff_summary.files).toHaveLength(1);
    expect(result.recommendation.risk_level).toBe("medium");
    expect(result.recommendation.warnings).toContain("DIFF_SUMMARY_TRUNCATED");
  });

  test("reviews more than 1MB across 80 files with bounded loading and explicit truncation", async () => {
    const fixture = await createGitFixture();
    await mkdir(join(fixture.root, "src", "large"), { recursive: true });
    const paths = Array.from({ length: 80 }, (_, index) => `src/large/file-${String(index).padStart(3, "0")}.txt`);
    for (const path of paths) await writeFile(join(fixture.root, path), `initial ${path}\n`);
    await git(fixture.root, ["add", "--", ...paths]);
    await git(fixture.root, ["commit", "-m", "large baseline"]);
    const payload = "x".repeat(16 * 1024);
    for (const path of paths) await writeFile(join(fixture.root, path), `${path}\n${payload}\n`);

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture", max_files: 10 });
    expect(result.changed_paths).toHaveLength(80);
    expect(result.diff_summary).toMatchObject({ file_count: 80, truncated: true });
    expect(result.diff_summary.files).toHaveLength(10);
    expect(result.recommendation.warnings).toContain("DIFF_SUMMARY_TRUNCATED");

    const direct = await new GitService(fixture.root).diff({ max_bytes: 64 * 1024 });
    expect(direct.truncated).toBe(true);
    expect(direct.truncation_reason).toBe("max_bytes");
    expect(direct.warnings.join(" ")).toContain("Git completed successfully");
    expect(await new GitService(fixture.root).worktreeFingerprint()).toMatch(/^[a-f0-9]{64}$/);
  });

  test("ship readiness includes stale validation evidence when latest validation head differs", async () => {
    const fixture = await createGitFixture();
    await mkdir(join(fixture.root, ".chatgpt", "validation"), { recursive: true });
    await writeFile(join(fixture.root, ".chatgpt", "validation", "latest.json"), JSON.stringify({
      schema_version: 1,
      validation_id: "validation-old",
      repo_id: "fixture",
      profile: "test",
      status: "passed",
      head_sha: "1111111111111111111111111111111111111111",
      artifact_path: ".chatgpt/validation/validation-old/result.json",
      timestamp: "2026-06-25T00:00:00.000Z"
    }, null, 2));
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.ship_readiness.validation).toMatchObject({
      status: "stale",
      validation_id: "validation-old",
      validation_status: "passed",
      head_sha: "1111111111111111111111111111111111111111"
    });
    expect(result.recommendation.warnings).toContain("VALIDATION_STALE");
  });

  test("ship readiness marks same-head validation stale after unvalidated dirty changes", async () => {
    const fixture = await createGitFixture();
    await mkdir(join(fixture.root, ".chatgpt", "validation"), { recursive: true });
    await writeFile(join(fixture.root, ".chatgpt", "validation", "latest.json"), JSON.stringify({
      schema_version: 1,
      validation_id: "validation-clean-head",
      repo_id: "fixture",
      profile: "test",
      status: "passed",
      head_sha: fixture.head,
      artifact_path: ".chatgpt/validation/validation-clean-head/result.json",
      timestamp: "2026-06-25T00:00:00.000Z"
    }, null, 2));
    await writeFile(join(fixture.root, "docs", "a.md"), "A changed after validation\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.ship_readiness.validation).toMatchObject({
      status: "stale",
      validation_id: "validation-clean-head",
      validation_status: "passed",
      head_sha: fixture.head
    });
    expect(result.recommendation.warnings).toContain("VALIDATION_STALE");
  });

  test("ship readiness marks untracked content edits stale after validation", async () => {
    const fixture = await createGitFixture();
    await writeFile(join(fixture.root, "docs", "new.md"), "validated content\n");
    const worktreeFingerprint = await new GitService(fixture.root).worktreeFingerprint();
    await mkdir(join(fixture.root, ".chatgpt", "validation"), { recursive: true });
    await writeFile(join(fixture.root, ".chatgpt", "validation", "latest.json"), JSON.stringify({
      schema_version: 1,
      validation_id: "validation-untracked-content",
      repo_id: "fixture",
      profile: "test",
      status: "passed",
      head_sha: fixture.head,
      worktree_fingerprint: worktreeFingerprint,
      artifact_path: ".chatgpt/validation/validation-untracked-content/result.json",
      timestamp: "2026-06-25T00:00:00.000Z"
    }, null, 2));
    await writeFile(join(fixture.root, "docs", "new.md"), "changed after validation\n");

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.ship_readiness.validation).toMatchObject({
      status: "stale",
      validation_id: "validation-untracked-content",
      validation_status: "passed",
      head_sha: fixture.head
    });
    expect(result.recommendation.warnings).toContain("VALIDATION_STALE");
  });

  test("ship readiness surfaces focused validation metadata from latest evidence", async () => {
    const fixture = await createGitFixture();
    await mkdir(join(fixture.root, ".chatgpt", "validation"), { recursive: true });
    await writeFile(join(fixture.root, ".chatgpt", "validation", "latest.json"), JSON.stringify({
      schema_version: 1,
      validation_id: "validation-focused",
      repo_id: "fixture",
      profile: "test",
      focused: true,
      test_paths: ["tests/auth.test.ts"],
      status: "passed",
      head_sha: fixture.head,
      worktree_fingerprint: "clean",
      artifact_path: ".chatgpt/validation/validation-focused/result.json",
      timestamp: "2026-06-25T00:00:00.000Z"
    }, null, 2));

    const result = await new GitReviewService(fixture.root).review({ repo_id: "fixture" });

    expect(result.ship_readiness.validation).toMatchObject({
      status: "passed",
      validation_id: "validation-focused",
      focused: true,
      test_paths: ["tests/auth.test.ts"]
    });
    expect(result.recommendation.warnings).toContain("VALIDATION_FOCUSED");
  });
});

function expectNoGeneratedReasons(payloads: Record<string, unknown>): void {
  for (const [name, payload] of Object.entries(payloads)) {
    expect(payload, name).not.toHaveProperty("reason");
  }
}

function createCleanupPolicy(): OperationsPolicy {
  return new OperationsPolicy({
    enabled: true,
    cleanup_enabled: true
  });
}

function createFullOperationsPolicy(): OperationsPolicy {
  return new OperationsPolicy({
    enabled: true,
    git_stage_enabled: true,
    git_commit_enabled: true,
    cleanup_enabled: true
  });
}

async function createGitFixture(): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "gpt-repo-mcp-review-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "a.md"), "A\n");
  await writeFile(join(root, "docs", "b.md"), "B\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["add", "--", "docs/a.md", "docs/b.md"]);
  await git(root, ["commit", "-m", "initial"]);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { root, head };
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" }
  });
  return result.stdout;
}
