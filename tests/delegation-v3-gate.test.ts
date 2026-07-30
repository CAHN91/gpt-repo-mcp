import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { ProductContract } from "../src/contracts/product-contract.contract.js";
import { CodexReviewAttestationService } from "../src/services/codex-review-attestation-service.js";
import { CodexResultService } from "../src/services/codex-result-service.js";
import { DelegationGateService } from "../src/services/delegation-gate-service.js";
import { DelegationV3TaskService } from "../src/services/delegation-v3-task-service.js";
import { GitOperationsService } from "../src/services/git-operations-service.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { OperationsPolicy } from "../src/services/operations-policy.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { parseCodexRunManifest } from "../src/services/codex-run-manifest.js";
import { writeV3Result } from "./fixtures/delegation-v3-run-fixture.js";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-07-19T15:00:00.000Z");
const RUN_A = "2026-07-19T150000Z-gate-a";
const RUN_B = "2026-07-19T150100Z-gate-b";

describe("RNV-03C shared delegation gate", () => {
  test("enforce mode suppresses Git payloads and blocks direct stage while recovery remains available", async () => {
    const fixture = await gateFixture("enforce");
    await writeTechnicalRun(fixture.root, RUN_A);
    await changeAndResult(fixture.root, RUN_A, "export const gateOpen = true;\n");

    const review = await gitReview(fixture.root).review({ repo_id: "fixture", detail: "full" });
    expect(review.delegation_gate).toMatchObject({
      status: "blocked",
      applicable_runs: [expect.objectContaining({ run_id: RUN_A, status: "open" })]
    });
    expect(review.recommendation.ready_to_stage).toBe(false);
    expect(review.next_tool_payloads.repo_write_stage_actual).toBeUndefined();
    expect(review.next_tool_payloads.repo_write_stage_commit_actual).toBeUndefined();
    expect(review.next_tool_payloads.repo_write_recover_actual).toBeDefined();

    const operations = gitOperations(fixture.root);
    await expect(operations.stage({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      expected_head_sha: fixture.head,
      dry_run: true
    })).rejects.toMatchObject({ code: "DELEGATION_REVIEW_GATE_BLOCKED" });
    await expect(operations.stageCommit({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      message: "Blocked gated commit",
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({ code: "DELEGATION_REVIEW_GATE_BLOCKED" });
    expect(await stagedPaths(fixture.root)).toEqual([]);
    await expect(operations.recover({
      restore_paths: ["src/app.ts"],
      expected_head_sha: fixture.head,
      dry_run: true
    })).resolves.toMatchObject({ restored_paths: ["src/app.ts"] });
  });

  test("a valid technical-only attestation opens review, stage, and staged-only commit", async () => {
    const fixture = await gateFixture("enforce");
    await writeTechnicalRun(fixture.root, RUN_A);
    await changeAndResult(fixture.root, RUN_A, "export const gatePassed = true;\n");
    await attestTechnical(fixture.root, RUN_A);

    const review = await gitReview(fixture.root).review({ repo_id: "fixture", detail: "full" });
    expect(review.delegation_gate).toMatchObject({
      status: "passed",
      applicable_runs: [expect.objectContaining({
        run_id: RUN_A,
        status: "passed",
        review_status: "valid",
        product_verdict: "not_applicable"
      })]
    });
    expect(review.next_tool_payloads.repo_write_stage_actual?.paths).toEqual(["src/app.ts"]);

    const operations = gitOperations(fixture.root);
    await operations.stage({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      expected_head_sha: fixture.head
    });
    await expect(operations.commit({
      repo_id: "fixture",
      message: "Update gated app",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["src/app.ts"],
      dry_run: true
    })).resolves.toMatchObject({ committed_paths: ["src/app.ts"] });
  });

  test("a valid attestation permits composite stage-and-commit through both gate checks", async () => {
    const fixture = await gateFixture("enforce");
    await writeTechnicalRun(fixture.root, RUN_A);
    await changeAndResult(fixture.root, RUN_A, "export const compositeGate = true;\n");
    await attestTechnical(fixture.root, RUN_A);

    const result = await gitOperations(fixture.root).stageCommit({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      message: "Commit gate-reviewed app",
      expected_head_sha: fixture.head
    });
    expect(result).toMatchObject({
      dry_run: false,
      staged_paths: ["src/app.ts"],
      committed_paths: ["src/app.ts"]
    });
    expect(result.commit_sha).toMatch(/^[a-f0-9]{40}$/);
  });

  test("product FAIL is durable and blocks every ship-capable gate path", async () => {
    const fixture = await gateFixture("enforce");
    const manifest = await writeProductRun(fixture.root, RUN_A);
    await changeAndResult(fixture.root, RUN_A, "export const productWrong = true;\n");
    const review = await codexReview(fixture.root).review({ repo_id: "fixture", run_id: RUN_A });
    if (review.review_state.status !== "available") throw new Error("Expected available review state.");
    if (!("product_alignment" in manifest.task)) throw new Error("Expected product task.");
    await attestationService(fixture.root).write({
      repo_id: "fixture",
      run_id: RUN_A,
      expected_review_state_sha256: review.review_state.state_sha256,
      product_verdict: "failed",
      rationale: "The implementation is technically correct but product-wrong.",
      evidence: manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => ({
        criterion_id: id,
        verdict: "failed" as const,
        evidence: "The intended operator outcome is not sufficiently improved."
      }))
    });

    const decision = await new DelegationGateService(fixture.root).evaluate({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      operation: "ship"
    });
    expect(decision).toMatchObject({
      status: "blocked",
      applicable_runs: [expect.objectContaining({
        run_id: RUN_A,
        status: "failed",
        product_verdict: "failed"
      })]
    });
    expect(decision.blocking_reasons).toContain("DELEGATION_PRODUCT_REVIEW_FAILED");
  });

  test("a relevant content change after attestation makes the gate stale", async () => {
    const fixture = await gateFixture("enforce");
    await writeTechnicalRun(fixture.root, RUN_A);
    await changeAndResult(fixture.root, RUN_A, "export const originalState = true;\n");
    await attestTechnical(fixture.root, RUN_A);
    await writeFile(join(fixture.root, "src", "app.ts"), "export const changedAfterReview = true;\n");

    const decision = await new DelegationGateService(fixture.root).evaluate({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      operation: "stage"
    });
    expect(decision.status).toBe("blocked");
    expect(decision.applicable_runs[0]).toMatchObject({ status: "stale", review_status: "stale" });
    expect(decision.blocking_reasons).toContain("DELEGATION_REVIEW_STATE_CHANGED");
  });

  test("an unrelated change outside the attested pathset does not stale the run", async () => {
    const fixture = await gateFixture("enforce");
    await writeTechnicalRun(fixture.root, RUN_A);
    await changeAndResult(fixture.root, RUN_A, "export const scopedReview = true;\n");
    await attestTechnical(fixture.root, RUN_A);
    await writeFile(join(fixture.root, "docs", "guide.md"), "# Guide changed by unrelated work\n");

    const decision = await new DelegationGateService(fixture.root).evaluate({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      operation: "stage"
    });
    expect(decision.status).toBe("passed");
    expect(decision.applicable_runs[0]).toMatchObject({ status: "passed", review_status: "valid" });
  });

  test("a valid enforce gate still blocks when its bound manifest is removed or malformed", async () => {
    const fixture = await gateFixture("enforce");
    const written = await writeTechnicalRun(fixture.root, RUN_A);
    await changeAndResult(fixture.root, RUN_A, "export const orphanedGate = true;\n");
    await attestTechnical(fixture.root, RUN_A);
    await writeFile(join(fixture.root, written.manifest_path), "{ malformed\n");

    const decision = await new DelegationGateService(fixture.root).evaluate({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      operation: "stage"
    });
    expect(decision.status).toBe("blocked");
    expect(decision.applicable_runs[0]).toMatchObject({
      run_id: RUN_A,
      status: "invalid_gate",
      governance_mode: "enforce"
    });
    expect(decision.blocking_reasons).toContain("DELEGATION_REVIEW_GATE_INVALID");
  });

  test("tracked operational .chatgpt changes do not stale a content-bound attestation", async () => {
    const fixture = await gateFixture("enforce");
    await mkdir(join(fixture.root, ".chatgpt"), { recursive: true });
    await writeFile(join(fixture.root, ".chatgpt", "operator-state.json"), "{\"state\":1}\n");
    await git(fixture.root, ["add", "-f", ".chatgpt/operator-state.json"]);
    await git(fixture.root, ["commit", "-m", "track operator state"]);
    await writeTechnicalRun(fixture.root, RUN_A);
    await changeAndResult(fixture.root, RUN_A, "export const stableReview = true;\n");
    await attestTechnical(fixture.root, RUN_A);
    await writeFile(join(fixture.root, ".chatgpt", "operator-state.json"), "{\"state\":2}\n");

    const decision = await new DelegationGateService(fixture.root).evaluate({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      operation: "stage"
    });
    expect(decision.status).toBe("passed");
    expect(decision.applicable_runs[0]).toMatchObject({ status: "passed", review_status: "valid" });
  });

  test("pre-existing baseline changes are not captured by a later gate", async () => {
    const fixture = await gateFixture("enforce");
    await writeFile(join(fixture.root, "src", "app.ts"), "export const userWork = true;\n");
    await writeTechnicalRun(fixture.root, RUN_A);

    const decision = await new DelegationGateService(fixture.root).evaluate({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      operation: "stage"
    });
    expect(decision).toEqual({
      status: "not_applicable",
      requested_paths: ["src/app.ts"],
      applicable_runs: [],
      blocking_reasons: [],
      warnings: [],
      truncated: false
    });
  });

  test("advisory mode reports an open gate but does not suppress stage payloads", async () => {
    const fixture = await gateFixture("advisory");
    await writeTechnicalRun(fixture.root, RUN_A);
    await changeAndResult(fixture.root, RUN_A, "export const advisoryGate = true;\n");

    const review = await gitReview(fixture.root).review({ repo_id: "fixture", detail: "full" });
    expect(review.delegation_gate.status).toBe("advisory");
    expect(review.recommendation.warnings).toContain("DELEGATION_REVIEW_GATE_ADVISORY");
    expect(review.next_tool_payloads.repo_write_stage_actual?.paths).toEqual(["src/app.ts"]);
  });

  test("overlapping enforce gates require every applicable run to pass", async () => {
    const fixture = await gateFixture("enforce");
    await writeTechnicalRun(fixture.root, RUN_A);
    await writeTechnicalRun(fixture.root, RUN_B);
    await changeAndResult(fixture.root, RUN_A, "export const sharedChange = true;\n");
    await writeV3Result(fixture.root, RUN_B, { changed_files: ["src/app.ts"] });
    await attestTechnical(fixture.root, RUN_A);

    const decision = await new DelegationGateService(fixture.root).evaluate({
      repo_id: "fixture",
      paths: ["src/app.ts"],
      operation: "commit"
    });
    expect(decision.status).toBe("blocked");
    expect(decision.applicable_runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: RUN_A, status: "passed" }),
      expect.objectContaining({ run_id: RUN_B, status: "open" })
    ]));
  });
});

async function gateFixture(mode: "advisory" | "enforce") {
  const root = await mkdtemp(join(tmpdir(), "gpt-repo-mcp-gate-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export const initial = true;\n");
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
  await writeFile(join(root, "docs", "product-contract.json"), `${JSON.stringify(productContract(mode), null, 2)}\n`);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["add", "--", "src/app.ts", "docs/guide.md", "docs/product-contract.json"]);
  await git(root, ["commit", "-m", "initial"]);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { root, head };
}

function productContract(mode: "advisory" | "enforce"): ProductContract {
  return {
    schema_version: 1,
    product: { name: "Gate Fixture", purpose: "Require state-bound review before MCP ship operations." },
    primary_users: [{
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical",
      work_context: "Reviews delegated repository changes before local commit."
    }],
    jobs_to_be_done: [{
      id: "ship-reviewed-change",
      statement: "Ship only changes whose technical and product evidence has been reviewed."
    }],
    must_reduce: ["Unreviewed delegated commits"],
    must_not_become: ["A bypassable approval label"],
    experience_principles: ["One shared gate, low ceremony"],
    canonical_docs: ["docs/guide.md"],
    governance: {
      mode,
      product_review_required_for: ["product_slice", "product_correction"],
      checkpoint_every_root_runs: 5
    }
  };
}

async function writeTechnicalRun(root: string, runId: string) {
  return taskService(root).write({
    repo_id: "fixture",
    run_id: runId,
    title: `Technical gate ${runId}`,
    task_kind: "technical_infrastructure",
    assignment: "Implement the bounded technical change and preserve the shared review gate.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "MCP Git operations can otherwise bypass delegated review state.",
      desired_outcome: "Every ship-capable MCP path uses one state-bound gate.",
      why_now: "RNV-03C activates the shared gate."
    },
    technical_context: { enabling_value: "Prevent unreviewed delegated work from reaching a local commit." },
    starting_points: ["src/app.ts"],
    authorization_scope: ["src/**"],
    hard_constraints: ["Recovery operations remain available."],
    must_preserve: ["Manual terminal Git stays outside the MCP guarantee."],
    explicit_exclusions: ["Do not add push behavior."],
    technical_acceptance_criteria: ["The shared gate covers the requested path."],
    runner: { mode: "manual" }
  });
}

async function writeProductRun(root: string, runId: string) {
  const written = await taskService(root).write({
    repo_id: "fixture",
    run_id: runId,
    title: `Product gate ${runId}`,
    task_kind: "product_slice",
    assignment: "Implement the bounded product change and preserve the shared review gate.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "Technically green work can still be product-wrong.",
      desired_outcome: "Product-wrong work is durably blocked before local commit.",
      why_now: "RNV-03C activates the product gate."
    },
    product_alignment: {
      primary_user_id: "repo-operator",
      job_ids: ["ship-reviewed-change"],
      user_problem: "The operator needs product judgment to control ship readiness.",
      product_goal: "Block product-wrong changes from every MCP commit path.",
      product_acceptance_criteria: ["The product outcome is explicitly judged before ship."]
    },
    starting_points: ["src/app.ts"],
    authorization_scope: ["src/**"],
    hard_constraints: ["Agent PAC claims are evidence only."],
    must_preserve: ["Corrective lineage remains available after product FAIL."],
    explicit_exclusions: ["Do not auto-approve product work."],
    technical_acceptance_criteria: ["The shared gate covers the requested path."],
    runner: { mode: "manual" }
  });
  const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(root, written.manifest_path), "utf8")) as unknown);
  if (manifest.schema_version !== 3) throw new Error("Expected v3 manifest.");
  return manifest;
}

async function changeAndResult(root: string, runId: string, content: string) {
  await writeFile(join(root, "src", "app.ts"), content);
  await writeV3Result(root, runId, { changed_files: ["src/app.ts"] });
}

async function attestTechnical(root: string, runId: string) {
  const review = await codexReview(root).review({ repo_id: "fixture", run_id: runId });
  if (review.review_state.status !== "available") throw new Error("Expected available review state.");
  return attestationService(root).write({
    repo_id: "fixture",
    run_id: runId,
    expected_review_state_sha256: review.review_state.state_sha256,
    product_verdict: "not_applicable",
    rationale: "The technical-only task is ready for shared-gate ship review.",
    evidence: []
  });
}

function taskService(root: string) {
  return new DelegationV3TaskService(
    root,
    new PathSandbox(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => NOW
  );
}

function codexReview(root: string) {
  return new CodexResultService(new PathSandbox(root), gitReview(root), root);
}

function attestationService(root: string) {
  return new CodexReviewAttestationService(
    root,
    new PathSandbox(root),
    gitReview(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => new Date("2026-07-19T15:10:00.000Z")
  );
}

function gitReview(root: string) {
  return new GitReviewService(root, operationsPolicy());
}

function gitOperations(root: string) {
  return new GitOperationsService(root, operationsPolicy());
}

function operationsPolicy() {
  return new OperationsPolicy({
    enabled: true,
    git_stage_enabled: true,
    git_commit_enabled: true,
    cleanup_enabled: true,
    cleanup_allowed_globs: [".chatgpt/**"]
  });
}

async function stagedPaths(root: string): Promise<string[]> {
  return (await git(root, ["diff", "--name-only", "--cached"]))
    .split("\n")
    .filter(Boolean)
    .sort();
}

async function git(root: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  return result.stdout;
}
