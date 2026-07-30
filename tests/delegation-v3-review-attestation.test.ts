import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { CodexReviewAttestationV2Schema } from "../src/contracts/codex-review-attestation.contract.js";
import { CodexReviewAttestationService } from "../src/services/codex-review-attestation-service.js";
import { codexReviewAttestationAnySha256 } from "../src/services/codex-review-state.js";
import { CodexResultService } from "../src/services/codex-result-service.js";
import { DelegationDriftService } from "../src/services/delegation-drift-service.js";
import { codexRunPaths } from "../src/services/codex-run-paths.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { GitService } from "../src/services/git-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";
import { writeQueuedV3Run, writeV3Result } from "./fixtures/delegation-v3-run-fixture.js";

const execFileAsync = promisify(execFile);
const PRODUCT_RUN = "2026-07-19T130000Z-review-attestation-product";
const TECHNICAL_RUN = "2026-07-19T130100Z-review-attestation-technical";
const REVIEWED_AT = new Date("2026-07-19T13:10:00.000Z");

describe("RNV-03B review attestation", () => {
  test("writes a product PASS bound to the exact review state and reads it back as valid", async () => {
    const fixture = await attestationFixture();
    const manifest = await productRun(fixture.root, PRODUCT_RUN);
    const before = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: PRODUCT_RUN });
    expect(before.review_state.status).toBe("available");
    expect(before.review_attestation.status).toBe("missing");
    if (before.review_state.status !== "available") throw new Error("Expected available review state.");

    const result = await writeService(fixture.root).write({
      repo_id: "fixture",
      run_id: PRODUCT_RUN,
      expected_review_state_sha256: before.review_state.state_sha256,
      product_verdict: "passed",
      rationale: "The implementation preserves the intended operator outcome.",
      evidence: productPacIds(manifest).map((id) => ({
        criterion_id: id,
        verdict: "passed" as const,
        evidence: "The bounded product evidence and changed path support this criterion."
      }))
    });

    expect(result).toMatchObject({
      dry_run: false,
      written_paths: [
        codexRunPaths(PRODUCT_RUN).reviewGatePath,
        codexRunPaths(PRODUCT_RUN).reviewPath
      ],
      review_requirement: "product_required",
      product_verdict: "passed",
      technical_readiness_status: "passed",
      review_state_sha256: before.review_state.state_sha256,
      reviewed_at: REVIEWED_AT.toISOString()
    });
    const artifact = CodexReviewAttestationV2Schema.parse(JSON.parse(
      await readFile(join(fixture.root, result.review_path), "utf8")
    ));
    expect(artifact.review_sha256).toBe(codexReviewAttestationAnySha256(artifact));
    expect(artifact.binding.state_sha256).toBe(before.review_state.state_sha256);
    expect(artifact.schema_version).toBe(2);
    if (artifact.schema_version !== 2) throw new Error("Expected gate-bound review attestation v2.");
    expect(artifact.review_gate_sha256).toBe(result.review_gate_sha256);
    const drift = await new DelegationDriftService(fixture.root, new PathSandbox(fixture.root)).analyze("fixture");
    expect(drift.checkpoint).toMatchObject({
      status: "current",
      governance_mode: "advisory",
      threshold_root_runs: 5,
      root_runs_since_last_product_checkpoint: 0,
      latest_product_checkpoint_run_id: PRODUCT_RUN,
      latest_product_checkpoint_at: REVIEWED_AT.toISOString()
    });

    const after = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: PRODUCT_RUN });
    expect(after.review_state).toEqual(before.review_state);
    expect(after.review_attestation).toMatchObject({
      status: "valid",
      verdict: "passed",
      review_sha256: artifact.review_sha256,
      reasons: []
    });
    expect(after.warnings).toContain("DELEGATION_V3_REVIEW_ATTESTED");
    expect(after.warnings).not.toContain("DELEGATION_V3_GIT_GATE_NOT_ENABLED");
    expect(after.warnings).not.toContain("DELEGATION_V3_REVIEW_ATTESTATION_REQUIRED");
    expect(after.next_tool_payloads?.repo_ship_review).toEqual({
      repo_id: "fixture",
      run_id: PRODUCT_RUN,
      paths: ["src/app.ts"]
    });
    expectNoHappyPathPayloads(after);
  });

  test("persists product FAIL and exposes a bounded corrective child on the next review", async () => {
    const fixture = await attestationFixture();
    const manifest = await productRun(fixture.root, PRODUCT_RUN);
    const before = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: PRODUCT_RUN });
    if (before.review_state.status !== "available") throw new Error("Expected available review state.");

    await writeService(fixture.root).write({
      repo_id: "fixture",
      run_id: PRODUCT_RUN,
      expected_review_state_sha256: before.review_state.state_sha256,
      product_verdict: "failed",
      rationale: "The implementation is technically correct but does not sufficiently reduce operator ambiguity.",
      evidence: productPacIds(manifest).map((id, index) => ({
        criterion_id: id,
        verdict: index === 0 ? "failed" as const : "passed" as const,
        evidence: index === 0
          ? "The product outcome is not yet clear enough for the operator."
          : "The remaining criterion is supported."
      }))
    });

    const after = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: PRODUCT_RUN });
    expect(after.review_attestation).toMatchObject({ status: "valid", verdict: "failed" });
    expect(after.warnings).toContain("DELEGATION_V3_PRODUCT_REVIEW_FAILED");
    expect(after.review_loop).toMatchObject({ status: "eligible", next_child_kind: "corrective" });
    expect(after.next_tool_payloads?.repo_write_codex_task?.lineage).toMatchObject({
      kind: "corrective",
      parent_run_id: PRODUCT_RUN
    });
    expect(after.next_tool_payloads?.repo_write_codex_task?.assignment).toContain(
      "The implementation is technically correct but does not sufficiently reduce operator ambiguity."
    );
    expect(after.next_tool_payloads?.repo_write_codex_task?.assignment).toContain("Failed PAC evidence: PAC-1");
    expectNoHappyPathPayloads(after);
  });

  test("accepts not_applicable only for a technically ready technical-only run", async () => {
    const fixture = await attestationFixture();
    await technicalRun(fixture.root, TECHNICAL_RUN, "passed");
    const before = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: TECHNICAL_RUN });
    if (before.review_state.status !== "available") throw new Error("Expected available review state.");

    const result = await writeService(fixture.root).write({
      repo_id: "fixture",
      run_id: TECHNICAL_RUN,
      expected_review_state_sha256: before.review_state.state_sha256,
      product_verdict: "not_applicable",
      rationale: "The manifest is technical-only and requires no product verdict.",
      evidence: []
    });

    expect(result).toMatchObject({ review_requirement: "technical_only", product_verdict: "not_applicable" });
    const after = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: TECHNICAL_RUN });
    expect(after.review_attestation).toMatchObject({ status: "valid", verdict: "not_applicable" });
    expectNoHappyPathPayloads(after);
  });

  test("rejects attestation when technical readiness is not passed", async () => {
    const fixture = await attestationFixture();
    await technicalRun(fixture.root, TECHNICAL_RUN, "failed");
    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: TECHNICAL_RUN });
    if (review.review_state.status !== "available") throw new Error("Expected available review state.");
    expect(review.technical_readiness.status).toBe("failed");

    await expect(writeService(fixture.root).write({
      repo_id: "fixture",
      run_id: TECHNICAL_RUN,
      expected_review_state_sha256: review.review_state.state_sha256,
      product_verdict: "not_applicable",
      rationale: "Caller cannot override technical failure.",
      evidence: []
    })).rejects.toMatchObject({ code: "CODEX_REVIEW_NOT_ELIGIBLE" });
  });

  test("rejects stale review-state tokens and marks an existing attestation stale after worktree drift", async () => {
    const fixture = await attestationFixture();
    const manifest = await productRun(fixture.root, PRODUCT_RUN);
    const before = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: PRODUCT_RUN });
    if (before.review_state.status !== "available") throw new Error("Expected available review state.");
    const payload = {
      repo_id: "fixture",
      run_id: PRODUCT_RUN,
      expected_review_state_sha256: before.review_state.state_sha256,
      product_verdict: "passed" as const,
      rationale: "The current state satisfies the intended outcome.",
      evidence: productPacIds(manifest).map((id) => ({
        criterion_id: id,
        verdict: "passed" as const,
        evidence: "Criterion is satisfied in the reviewed state."
      }))
    };
    await writeService(fixture.root).write(payload);
    await writeFile(join(fixture.root, "src", "app.ts"), "export const attested = 'changed-after-review';\n");

    const drifted = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: PRODUCT_RUN });
    expect(drifted.review_attestation).toMatchObject({ status: "stale", verdict: "passed" });
    expect(drifted.warnings).toContain("DELEGATION_V3_REVIEW_ATTESTATION_STALE");
    await expect(writeService(fixture.root).write(payload)).rejects.toMatchObject({ code: "CODEX_REVIEW_STATE_MISMATCH" });
  });

  test("detects a tampered review artifact", async () => {
    const fixture = await attestationFixture();
    const manifest = await productRun(fixture.root, PRODUCT_RUN);
    const before = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: PRODUCT_RUN });
    if (before.review_state.status !== "available") throw new Error("Expected available review state.");
    const written = await writeService(fixture.root).write({
      repo_id: "fixture",
      run_id: PRODUCT_RUN,
      expected_review_state_sha256: before.review_state.state_sha256,
      product_verdict: "passed",
      rationale: "Original reviewed rationale.",
      evidence: productPacIds(manifest).map((id) => ({
        criterion_id: id,
        verdict: "passed" as const,
        evidence: "Original reviewed evidence."
      }))
    });
    const path = join(fixture.root, written.review_path);
    const artifact = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    artifact.rationale = "Tampered rationale.";
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: PRODUCT_RUN });
    expect(review.review_attestation).toMatchObject({
      status: "tampered",
      reasons: ["REVIEW_ATTESTATION_HASH_MISMATCH"]
    });
    expect(review.warnings).toContain("DELEGATION_V3_REVIEW_ATTESTATION_TAMPERED");
  });

  test("redacts sensitive evidence and dry-run writes no artifact", async () => {
    const fixture = await attestationFixture();
    const manifest = await productRun(fixture.root, PRODUCT_RUN);
    const before = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: PRODUCT_RUN });
    if (before.review_state.status !== "available") throw new Error("Expected available review state.");
    const sensitiveValue = `${String.fromCharCode(115, 107, 45)}${"b".repeat(48)}`;
    const result = await writeService(fixture.root).write({
      repo_id: "fixture",
      run_id: PRODUCT_RUN,
      expected_review_state_sha256: before.review_state.state_sha256,
      product_verdict: "passed",
      rationale: `Reviewed without retaining ${sensitiveValue}.`,
      evidence: productPacIds(manifest).map((id) => ({
        criterion_id: id,
        verdict: "passed" as const,
        evidence: `Evidence accidentally contained ${sensitiveValue}.`
      })),
      dry_run: true
    });

    expect(result.dry_run).toBe(true);
    expect(result.written_paths).toEqual([]);
    expect(result.warnings).toContain("CODEX_REVIEW_EVIDENCE_REDACTED");
    await expect(readFile(join(fixture.root, result.review_path), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function attestationFixture() {
  const fixture = await createRepoFixture();
  await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(reviewProductContract(), null, 2)}\n`);
  await execFileAsync("git", ["init"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["add", "--", "docs/guide.md", "docs/product-contract.json", "src/app.ts"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  return fixture;
}

async function productRun(root: string, runId: string) {
  const git = new GitService(root);
  const status = await git.status();
  const manifest = await writeQueuedV3Run(root, runId, {
    task_kind: "product_slice",
    validation: null,
    baseline: {
      head_sha: status.head_sha,
      worktree_fingerprint: await git.worktreeFingerprint(),
      initial_changed_paths: baselinePaths(status.files)
    }
  });
  await writeFile(join(root, "src", "app.ts"), "export const attested = true;\n");
  await writeV3Result(root, runId, { changed_files: ["src/app.ts"] });
  return manifest;
}

async function technicalRun(root: string, runId: string, technicalStatus: "passed" | "failed") {
  const git = new GitService(root);
  const status = await git.status();
  await writeQueuedV3Run(root, runId, {
    task_kind: "technical_infrastructure",
    validation: null,
    baseline: {
      head_sha: status.head_sha,
      worktree_fingerprint: await git.worktreeFingerprint(),
      initial_changed_paths: baselinePaths(status.files)
    }
  });
  await writeFile(join(root, "src", "app.ts"), `export const technicalAttestation = ${technicalStatus === "passed"};\n`);
  await writeV3Result(root, runId, {
    changed_files: ["src/app.ts"],
    technical_status: technicalStatus
  });
}

function baselinePaths(files: Array<{ path: string; original_path?: string }>): string[] {
  return [...new Set(files.flatMap((file) => [
    ...(file.original_path ? [file.original_path] : []),
    file.path
  ]))].sort();
}

function productPacIds(manifest: Awaited<ReturnType<typeof writeQueuedV3Run>>): string[] {
  if (!("product_alignment" in manifest.task)) throw new Error("Expected product Delegation v3 manifest.");
  return manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => id);
}

function reviewService(root: string) {
  return new CodexResultService(new PathSandbox(root), new GitReviewService(root), root);
}

function writeService(root: string) {
  return new CodexReviewAttestationService(
    root,
    new PathSandbox(root),
    new GitReviewService(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => REVIEWED_AT
  );
}

function reviewProductContract() {
  return {
    schema_version: 1,
    product: { name: "Fixture Product", purpose: "Keep delegated work product-aware." },
    primary_users: [{
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical",
      work_context: "Coordinates implementation agents in a trusted repository."
    }],
    jobs_to_be_done: [{
      id: "delegate-coherent-work",
      statement: "Delegate coherent work without losing product intent."
    }],
    must_reduce: ["Prompt micromanagement"],
    must_not_become: ["A competing planning engine"],
    experience_principles: ["Outcome before implementation detail"],
    canonical_docs: ["docs/guide.md"],
    governance: {
      mode: "advisory" as const,
      product_review_required_for: ["product_slice", "product_correction"] as const,
      checkpoint_every_root_runs: 5
    }
  };
}

function expectNoHappyPathPayloads(review: Awaited<ReturnType<CodexResultService["review"]>>): void {
  for (const payloads of [review.next_tool_payloads, review.git_review?.next_tool_payloads]) {
    expect(payloads?.repo_write_stage_dry_run).toBeUndefined();
    expect(payloads?.repo_write_stage_actual).toBeUndefined();
    expect(payloads?.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(payloads?.repo_write_stage_commit_actual).toBeUndefined();
    expect(payloads?.repo_write_commit_dry_run).toBeUndefined();
  }
  expect(review.git_review?.recommendation.ready_to_stage).toBe(false);
}
