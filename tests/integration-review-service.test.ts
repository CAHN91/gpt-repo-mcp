import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { ProductContract } from "../src/contracts/product-contract.contract.js";
import { GitStageCommitInputSchema } from "../src/contracts/git-operations.contract.js";
import { IntegrationReviewWriteInputSchema } from "../src/contracts/integration-review.contract.js";
import { CodexResultService } from "../src/services/codex-result-service.js";
import { CodexReviewAttestationService } from "../src/services/codex-review-attestation-service.js";
import { DelegationV3TaskService } from "../src/services/delegation-v3-task-service.js";
import { GitOperationsService } from "../src/services/git-operations-service.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { GitService } from "../src/services/git-service.js";
import { IntegrationReviewService } from "../src/services/integration-review-service.js";
import { OperationsPolicy } from "../src/services/operations-policy.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { parseCodexRunManifest } from "../src/services/codex-run-manifest.js";
import { writeV3Result } from "./fixtures/delegation-v3-run-fixture.js";

const execFileAsync = promisify(execFile);
const RUNS = [
  "2026-07-22T210000Z-integration-a",
  "2026-07-22T210100Z-integration-b",
  "2026-07-22T210200Z-integration-c"
] as const;
const VALIDATION_ID = "validation-integration-review";

describe("IntegrationReviewService", () => {
  test("contracts reject force, skip-review, push, and dual path sources", () => {
    const integrationBase = {
      repo_id: "fixture",
      run_ids: [RUNS[0], RUNS[1]],
      validation_id: VALIDATION_ID,
      expected_head_sha: "a".repeat(40),
      commit_message: "Reviewed integration"
    };
    for (const forbidden of [
      { force: true },
      { skip_review: true },
      { push: true },
      { paths: ["src/app.ts"] }
    ]) {
      expect(IntegrationReviewWriteInputSchema.safeParse({ ...integrationBase, ...forbidden }).success).toBe(false);
    }
    const stageBase = {
      repo_id: "fixture",
      review_pathset_id: "integration-2026-07-22-test",
      message: "Reviewed integration",
      expected_head_sha: "a".repeat(40)
    };
    expect(GitStageCommitInputSchema.safeParse({ ...stageBase, force: true }).success).toBe(false);
    expect(GitStageCommitInputSchema.safeParse({ ...stageBase, push: true }).success).toBe(false);
    expect(GitStageCommitInputSchema.safeParse({ ...stageBase, paths: ["src/extra.ts"] }).success).toBe(false);
  });

  test("review-bound pathsets still reject secret-candidate paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "gpt-integration-secret-"));
    await writeFile(join(root, ".env"), "# blocked secret-candidate path\n");
    await expect(operations(root).validateReviewBoundPaths([".env"]))
      .rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
  });

  test("three reviewed runs commit 60 paths atomically through one review-bound pathset", async () => {
    const fixture = await preparedFixture();
    const integration = await createIntegration(fixture);

    expect(integration).toMatchObject({
      path_count: 60,
      run_ids: [...RUNS],
      review_pathset_id: expect.stringMatching(/^integration-/)
    });
    expect(integration.reviewed_paths).toHaveLength(60);

    const result = await operations(fixture.root).stageCommit({
      repo_id: "fixture",
      review_pathset_id: integration.review_pathset_id,
      message: "Integrate three reviewed runs",
      expected_head_sha: fixture.head
    });
    expect(result.review_pathset_id).toBe(integration.review_pathset_id);
    expect(result.staged_paths).toHaveLength(60);
    expect(result.committed_paths).toHaveLength(60);
    expect(result.commit_sha).toMatch(/^[a-f0-9]{40}$/);
  }, 30_000);

  test("an extra unreviewed path blocks integration review", async () => {
    const fixture = await preparedFixture();
    await writeFile(join(fixture.root, "unreviewed.txt"), "not covered\n");
    await writeValidation(fixture.root, fixture.head);

    await expect(createIntegration(fixture)).rejects.toMatchObject({ code: "DELEGATION_REVIEW_GATE_BLOCKED" });
  }, 30_000);

  test("a byte change after integration review makes the pathset stale", async () => {
    const fixture = await preparedFixture();
    const integration = await createIntegration(fixture);
    await writeFile(join(fixture.root, integration.reviewed_paths[0]!), "changed after integration review\n");

    await expect(operations(fixture.root).stageCommit({
      repo_id: "fixture",
      review_pathset_id: integration.review_pathset_id,
      message: "Integrate three reviewed runs",
      expected_head_sha: fixture.head,
      dry_run: true
    })).rejects.toMatchObject({ code: "DELEGATION_REVIEW_GATE_BLOCKED" });
  }, 30_000);

  test("a failed product verdict cannot be hidden by integration review", async () => {
    const fixture = await baseFixture();
    const technicalPaths = fixture.paths.slice(0, 20);
    const productPaths = fixture.paths.slice(20, 40);
    await implementAndAttest(fixture.root, RUNS[0], technicalPaths, "technical", "not_applicable");
    await implementAndAttest(fixture.root, RUNS[1], productPaths, "product", "failed");
    await writeValidation(fixture.root, fixture.head);

    await expect(integrationService(fixture.root).write({
      repo_id: "fixture",
      run_ids: [RUNS[0], RUNS[1]],
      validation_id: VALIDATION_ID,
      expected_head_sha: fixture.head,
      commit_message: "Must not integrate failed product work"
    })).rejects.toMatchObject({ code: "DELEGATION_REVIEW_GATE_BLOCKED" });
  }, 30_000);
});

async function preparedFixture() {
  const fixture = await baseFixture();
  const overlappingPathsets = [
    fixture.paths.slice(0, 30),
    fixture.paths.slice(20, 50),
    fixture.paths.slice(40, 60)
  ];
  for (let index = 0; index < RUNS.length; index += 1) {
    await implementRun(fixture.root, RUNS[index]!, overlappingPathsets[index]!, "technical");
  }
  for (const runId of RUNS) {
    await attestRun(fixture.root, runId, "technical", "not_applicable");
  }
  await writeValidation(fixture.root, fixture.head);
  return fixture;
}

async function createIntegration(fixture: Awaited<ReturnType<typeof baseFixture>>) {
  return integrationService(fixture.root).write({
    repo_id: "fixture",
    run_ids: [...RUNS],
    validation_id: VALIDATION_ID,
    expected_head_sha: fixture.head,
    commit_message: "Integrate three reviewed runs"
  });
}

async function baseFixture() {
  const root = await mkdtemp(join(tmpdir(), "gpt-integration-review-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  const paths = Array.from({ length: 60 }, (_, index) => `src/file-${String(index).padStart(3, "0")}.txt`);
  for (const path of paths) await writeFile(join(root, path), `initial ${path}\n`);
  await writeFile(join(root, "docs", "guide.md"), "# Integration fixture\n");
  await writeFile(join(root, "docs", "product-contract.json"), `${JSON.stringify(productContract(), null, 2)}\n`);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["add", "--", ...paths, "docs/guide.md", "docs/product-contract.json"]);
  await git(root, ["commit", "-m", "initial"]);
  return { root, paths, head: (await git(root, ["rev-parse", "HEAD"])).trim() };
}

async function implementAndAttest(
  root: string,
  runId: string,
  paths: string[],
  kind: "technical" | "product",
  verdict: "passed" | "failed" | "not_applicable"
) {
  await implementRun(root, runId, paths, kind);
  await attestRun(root, runId, kind, verdict);
}

async function implementRun(root: string, runId: string, paths: string[], kind: "technical" | "product") {
  await taskService(root).write(kind === "technical"
    ? technicalTask(runId, paths[0]!)
    : productTask(runId, paths[0]!));
  for (const path of paths) await writeFile(join(root, path), `changed by ${runId}: ${path}\n`);
  await writeV3Result(root, runId, { changed_files: paths });
}

async function attestRun(
  root: string,
  runId: string,
  kind: "technical" | "product",
  verdict: "passed" | "failed" | "not_applicable"
) {
  const manifestPath = join(root, ".chatgpt", "codex-runs", runId, "run.json");
  const manifest = parseCodexRunManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.schema_version !== 3) throw new Error("Expected v3 manifest.");
  const review = await codexReview(root).review({ repo_id: "fixture", run_id: runId });
  if (review.review_state.status !== "available") throw new Error("Expected available review state.");
  await attestationService(root).write({
    repo_id: "fixture",
    run_id: runId,
    expected_review_state_sha256: review.review_state.state_sha256,
    product_verdict: verdict,
    rationale: verdict === "failed" ? "The product outcome is not acceptable." : "The reviewed outcome is approved for integration.",
    evidence: kind === "product" && "product_alignment" in manifest.task
      ? manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => ({
          criterion_id: id,
          verdict: verdict === "failed" ? "failed" as const : "passed" as const,
          evidence: verdict === "failed" ? "The product criterion was not met." : "The product criterion was met."
        }))
      : []
  });
}

function technicalTask(runId: string, startingPoint: string) {
  return {
    repo_id: "fixture",
    run_id: runId,
    title: `Integrate technical run ${runId}`,
    task_kind: "technical_infrastructure" as const,
    assignment: "Implement one bounded part of the intentionally shared integration worktree.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "Related reviewed runs need one safe local integration commit.",
      desired_outcome: "This run remains independently attributable and reviewable.",
      why_now: "The multi-run integration path is under test."
    },
    technical_context: { enabling_value: "Provide one independently attested part of the final integration." },
    starting_points: [startingPoint],
    authorization_scope: ["src/**"],
    hard_constraints: ["Do not modify unrelated paths."],
    must_preserve: ["Every changed path remains exactly attributed."],
    explicit_exclusions: ["Do not push."],
    technical_acceptance_criteria: ["The run's pathset is exactly attributable."],
    runner: { mode: "manual" as const }
  };
}

function productTask(runId: string, startingPoint: string) {
  return {
    repo_id: "fixture",
    run_id: runId,
    title: `Integrate product run ${runId}`,
    task_kind: "product_slice" as const,
    assignment: "Implement one bounded product part of the shared integration worktree.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "Integration must not hide a failed product judgment.",
      desired_outcome: "Product verdict remains authoritative during integration.",
      why_now: "The negative integration gate is under test."
    },
    product_alignment: {
      primary_user_id: "repo-operator",
      job_ids: ["integrate-reviewed-work"],
      user_problem: "Failed product work must remain blocked.",
      product_goal: "Preserve explicit product judgment through integration.",
      product_acceptance_criteria: ["The product verdict controls integration readiness."]
    },
    starting_points: [startingPoint],
    authorization_scope: ["src/**"],
    hard_constraints: ["Do not convert agent PAC claims into owner approval."],
    must_preserve: ["Failed product verdicts remain blocking."],
    explicit_exclusions: ["Do not push."],
    technical_acceptance_criteria: ["The run's pathset is exactly attributable."],
    runner: { mode: "manual" as const }
  };
}

async function writeValidation(root: string, head: string) {
  const fingerprint = await new GitService(root).worktreeFingerprint();
  const directory = join(root, ".chatgpt", "validation", VALIDATION_ID);
  await mkdir(directory, { recursive: true });
  const artifact = {
    schema_version: 1,
    validation_id: VALIDATION_ID,
    repo_id: "fixture",
    profile: "all",
    status: "passed",
    head_sha: head,
    worktree_fingerprint: fingerprint,
    timestamp: "2026-07-22T21:10:00.000Z",
    commands: [],
    counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
    warnings: []
  };
  await writeFile(join(directory, "result.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(join(root, ".chatgpt", "validation", "latest.json"), `${JSON.stringify({
    ...artifact,
    artifact_path: `.chatgpt/validation/${VALIDATION_ID}/result.json`
  }, null, 2)}\n`);
}

function taskService(root: string) {
  return new DelegationV3TaskService(
    root,
    new PathSandbox(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => new Date("2026-07-22T21:00:00.000Z")
  );
}

function codexReview(root: string) {
  return new CodexResultService(new PathSandbox(root), new GitReviewService(root, operationsPolicy()), root);
}

function attestationService(root: string) {
  return new CodexReviewAttestationService(
    root,
    new PathSandbox(root),
    new GitReviewService(root, operationsPolicy()),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => new Date("2026-07-22T21:05:00.000Z")
  );
}

function integrationService(root: string) {
  return new IntegrationReviewService(
    root,
    new PathSandbox(root),
    operationsPolicy(),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/integration-reviews/**"] }),
    () => new Date("2026-07-22T21:15:00.000Z")
  );
}

function operations(root: string) {
  return new GitOperationsService(root, operationsPolicy());
}

function operationsPolicy() {
  return new OperationsPolicy({
    enabled: true,
    git_stage_enabled: true,
    git_commit_enabled: true,
    validation_enabled: true,
    max_paths_per_operation: 50
  });
}

function productContract(): ProductContract {
  return {
    schema_version: 1,
    product: { name: "Integration Fixture", purpose: "Safely integrate multiple reviewed runs in one local commit." },
    primary_users: [{
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical",
      work_context: "Reviews and integrates related delegated work."
    }],
    jobs_to_be_done: [{ id: "integrate-reviewed-work", statement: "Integrate several independently reviewed runs without a safety bypass." }],
    must_reduce: ["Repeated whole-worktree attestations"],
    must_not_become: ["A force or skip-review path"],
    experience_principles: ["Exact state binding with low ceremony"],
    canonical_docs: ["docs/guide.md"],
    governance: {
      mode: "enforce",
      product_review_required_for: ["product_slice", "product_correction"],
      checkpoint_every_root_runs: 5
    }
  };
}

async function git(root: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  return result.stdout;
}
