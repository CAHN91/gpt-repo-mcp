import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { ProductContract } from "../src/contracts/product-contract.contract.js";
import { CodexResultService } from "../src/services/codex-result-service.js";
import { parseCodexRunManifest } from "../src/services/codex-run-manifest.js";
import { LegacyCodexV2TaskFixture } from "./fixtures/legacy-codex-v2-task-service.js";
import { DelegationV3TaskService } from "../src/services/delegation-v3-task-service.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-07-19T12:00:00.000Z");

function productContract(): ProductContract {
  return {
    schema_version: 1,
    product: {
      name: "Review Evidence Fixture",
      purpose: "Keep technical readiness separate from qualitative product judgment."
    },
    primary_users: [{
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical but time-constrained",
      work_context: "Reviews delegated repository outcomes before local shipping."
    }],
    jobs_to_be_done: [{
      id: "review-product-outcome",
      statement: "Determine whether technically correct work still solves the intended product problem."
    }],
    must_reduce: ["False confidence from green tests"],
    must_not_become: ["An agent self-approval mechanism"],
    experience_principles: ["Technical and product evidence stay separate"],
    canonical_docs: ["docs/guide.md"],
    governance: {
      mode: "advisory",
      product_review_required_for: ["product_slice", "product_correction"],
      checkpoint_every_root_runs: 5
    }
  };
}

function productTask() {
  return {
    repo_id: "fixture",
    title: "Review product evidence",
    task_kind: "product_slice" as const,
    assignment: "Implement the bounded product change and report separate PAC and TAC evidence.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "Technical success can be mistaken for product success.",
      desired_outcome: "Review shows deterministic technical readiness and a separate bounded product evidence pack.",
      why_now: "Delegation v3 review evidence is being activated."
    },
    product_alignment: {
      primary_user_id: "repo-operator",
      job_ids: ["review-product-outcome"],
      user_problem: "The operator lacks a concise product-grounded review pack.",
      product_goal: "Make product judgment explicit without letting the implementation agent approve itself.",
      additional_must_not_become: ["A raw diff dump"],
      product_acceptance_criteria: ["The product evidence pack remains bounded and product-grounded."]
    },
    starting_points: ["src/app.ts"],
    authorization_scope: ["src/**"],
    forbidden_paths: [],
    hard_constraints: ["Preserve exact manifest and prompt binding."],
    must_preserve: ["Stage and commit remain suppressed before attestation."],
    explicit_exclusions: ["Do not record a product verdict in RNV-03A."],
    technical_acceptance_criteria: ["The changed file and strict result correlate."],
    runner: { mode: "manual" as const }
  };
}

function technicalTask() {
  return {
    repo_id: "fixture",
    title: "Review technical evidence",
    task_kind: "technical_infrastructure" as const,
    assignment: "Implement the bounded technical change and report TAC evidence.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "Review does not expose one deterministic technical readiness state.",
      desired_outcome: "Technical readiness is derived from bound evidence rather than free-form judgment.",
      why_now: "RNV-03A is introducing the readiness contract."
    },
    technical_context: {
      enabling_value: "Give later attestation and Git gating one deterministic technical prerequisite."
    },
    starting_points: ["src/app.ts"],
    authorization_scope: ["src/**"],
    forbidden_paths: [],
    hard_constraints: ["Do not introduce product verdict semantics."],
    must_preserve: ["Historical review remains compatible."],
    explicit_exclusions: [],
    technical_acceptance_criteria: ["The changed file and strict result correlate."],
    runner: { mode: "manual" as const }
  };
}

describe("RNV-03A review evidence", () => {
  test("reports technical PASS with product review required and a bounded product pack", async () => {
    const fixture = await reviewFixture(true);
    const task = await v3Service(fixture.root).write(productTask());
    const manifest = await v3Manifest(fixture.root, task.manifest_path);
    await writeFile(join(fixture.root, "src", "app.ts"), "export const reviewed = true;\n");
    await writeV3Result(fixture.root, task.result_json_path, {
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "Implemented the bounded product change.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "Required for the declared product outcome." }],
      commands_run: [],
      tests: ["passed"],
      product_acceptance_criteria: productCriteria(manifest, "passed"),
      technical_acceptance_criteria: technicalCriteria(manifest, "passed"),
      scope_extension_required: [],
      blockers: [],
      followups: []
    });

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.technical_readiness).toMatchObject({
      status: "passed",
      deterministic: true,
      checks: {
        integrity: "passed",
        baseline: "passed",
        authorization: "passed",
        result_contract: "passed",
        result_status: "passed",
        scope: "passed",
        change_attribution: "passed",
        connected_changes: "passed",
        technical_acceptance: "passed",
        validation: "not_applicable"
      },
      blocking_reasons: [],
      incomplete_reasons: []
    });
    expect(review.product_review).toEqual({
      requirement: "required",
      status: "pending",
      source: "manifest"
    });
    expect(review.technical_acceptance_evidence).toMatchObject({ complete: true, all_passed: true });
    expect(review.product_acceptance_evidence).toMatchObject({ complete: true, agent_all_passed: true });
    expect(review.product_evidence).toMatchObject({
      status: "available",
      product: { name: "Review Evidence Fixture" },
      primary_user: { id: "repo-operator", role: "Repository operator" },
      changed_paths: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts" }],
      lineage: { kind: "root", root_run_id: task.run_id, parent_run_id: null, child_index: null },
      truncated: false
    });
    if (review.product_evidence.status !== "available") throw new Error("Expected available product evidence.");
    expect(review.product_evidence.product_acceptance_criteria).toEqual([
      expect.objectContaining({ agent_status: "passed", agent_evidence: "Bound product evidence." })
    ]);
    expect(review.warnings).toEqual(expect.arrayContaining([
      "DELEGATION_V3_PRODUCT_REVIEW_REQUIRED",
      "DELEGATION_V3_REVIEW_ATTESTATION_REQUIRED",
      "CODEX_HAPPY_PATH_PAYLOADS_SUPPRESSED"
    ]));
    expectNoHappyPathPayloads(review);
  });

  test("reports technical PASS with product review not applicable for a technical v3 task", async () => {
    const fixture = await reviewFixture(false);
    const task = await v3Service(fixture.root).write(technicalTask());
    const manifest = await v3Manifest(fixture.root, task.manifest_path);
    await writeFile(join(fixture.root, "src", "app.ts"), "export const technical = true;\n");
    await writeV3Result(fixture.root, task.result_json_path, {
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "Implemented the bounded technical change.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "Required for the enabling value." }],
      commands_run: [],
      tests: ["passed"],
      product_acceptance_criteria: [],
      technical_acceptance_criteria: technicalCriteria(manifest, "passed"),
      scope_extension_required: [],
      blockers: [],
      followups: []
    });

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.technical_readiness.status).toBe("passed");
    expect(review.product_review).toEqual({
      requirement: "not_applicable",
      status: "not_applicable",
      source: "manifest"
    });
    expect(review.product_acceptance_evidence.binding_available).toBe(false);
    expect(review.product_evidence).toEqual({ status: "not_applicable", reason: "technical_task" });
    expectNoHappyPathPayloads(review);
  });

  test("reports deterministic technical FAIL when TAC fails", async () => {
    const fixture = await reviewFixture(false);
    const task = await v3Service(fixture.root).write(technicalTask());
    const manifest = await v3Manifest(fixture.root, task.manifest_path);
    await writeFile(join(fixture.root, "src", "app.ts"), "export const technical = false;\n");
    await writeV3Result(fixture.root, task.result_json_path, {
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "Implementation did not satisfy the technical criterion.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "Attempted the required technical change." }],
      commands_run: [],
      tests: ["failed"],
      product_acceptance_criteria: [],
      technical_acceptance_criteria: technicalCriteria(manifest, "failed"),
      scope_extension_required: [],
      blockers: [],
      followups: []
    });

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.technical_readiness).toMatchObject({
      status: "failed",
      checks: { technical_acceptance: "failed" },
      blocking_reasons: ["TECHNICAL_CHECK_FAILED:technical_acceptance"]
    });
    expect(review.warnings).toContain("CODEX_TECHNICAL_READINESS_FAILED");
    expectNoHappyPathPayloads(review);
  });

  test("keeps technical readiness passed when PAC evidence is missing", async () => {
    const fixture = await reviewFixture(true);
    const task = await v3Service(fixture.root).write(productTask());
    const manifest = await v3Manifest(fixture.root, task.manifest_path);
    await writeFile(join(fixture.root, "src", "app.ts"), "export const missingPac = true;\n");
    await writeV3Result(fixture.root, task.result_json_path, {
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "Implemented technically but omitted PAC evidence.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "Required for the technical implementation." }],
      commands_run: [],
      tests: ["passed"],
      product_acceptance_criteria: [],
      technical_acceptance_criteria: technicalCriteria(manifest, "passed"),
      scope_extension_required: [],
      blockers: [],
      followups: []
    });

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.technical_readiness.status).toBe("passed");
    expect(review.product_acceptance_evidence).toMatchObject({
      binding_available: true,
      complete: false,
      agent_all_passed: false,
      missing_ids: ["PAC-1"]
    });
    expect(review.product_review.status).toBe("pending");
    if (review.product_evidence.status !== "available") throw new Error("Expected available product evidence.");
    expect(review.product_evidence.product_acceptance_criteria[0]).toMatchObject({
      id: "PAC-1",
      agent_status: "missing",
      agent_evidence: ""
    });
    expect(review.warnings).toContain("CODEX_PRODUCT_ACCEPTANCE_MISSING_IDS");
    expectNoHappyPathPayloads(review);
  });

  test("preserves scope-amendment evidence while technical readiness is failed", async () => {
    const fixture = await reviewFixture(true);
    const task = await v3Service(fixture.root).write(productTask());
    const manifest = await v3Manifest(fixture.root, task.manifest_path);
    await writeV3Result(fixture.root, task.result_json_path, {
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "blocked",
      summary: "Additional test authorization is required.",
      changed_files: [],
      connected_changes: [],
      commands_run: [],
      tests: [],
      product_acceptance_criteria: productCriteria(manifest, "unverified"),
      technical_acceptance_criteria: technicalCriteria(manifest, "unverified"),
      scope_extension_required: [{
        path_or_area: "tests/**",
        reason: "Regression coverage is outside the current authorization.",
        required_outcome: "Add bounded regression coverage."
      }],
      blockers: [],
      followups: []
    });

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.technical_readiness.status).toBe("failed");
    expect(review.technical_readiness.checks.result_status).toBe("failed");
    expect(review.review_loop).toMatchObject({ status: "eligible", next_child_kind: "scope_amendment" });
    expect(review.next_tool_payloads?.repo_write_codex_task?.lineage).toMatchObject({
      kind: "scope_amendment",
      authorization_additions: ["tests/**"]
    });
    if (review.product_evidence.status !== "available") throw new Error("Expected available product evidence.");
    expect(review.product_evidence.scope_extension_required).toEqual([
      expect.objectContaining({ path_or_area: "tests/**" })
    ]);
    expectNoHappyPathPayloads(review);
  });

  test("reports incomplete readiness when requested validation evidence is missing", async () => {
    const fixture = await reviewFixture(false);
    const task = await v3Service(fixture.root).write({
      ...technicalTask(),
      validation: { profile: "test", test_paths: [] }
    });
    const manifest = await v3Manifest(fixture.root, task.manifest_path);
    await writeFile(join(fixture.root, "src", "app.ts"), "export const validationPending = true;\n");
    await writeV3Result(fixture.root, task.result_json_path, {
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "Implemented but no current validation artifact exists.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "Required for the technical outcome." }],
      commands_run: [],
      tests: [],
      product_acceptance_criteria: [],
      technical_acceptance_criteria: technicalCriteria(manifest, "passed"),
      scope_extension_required: [],
      blockers: [],
      followups: []
    });

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.technical_readiness).toMatchObject({
      status: "incomplete",
      checks: { validation: "incomplete" },
      incomplete_reasons: ["TECHNICAL_CHECK_INCOMPLETE:validation"]
    });
    expect(review.warnings).toContain("CODEX_TECHNICAL_READINESS_INCOMPLETE");
    expectNoHappyPathPayloads(review);
  });

  test("redacts sensitive PAC evidence in the bounded product pack", async () => {
    const fixture = await reviewFixture(true);
    const task = await v3Service(fixture.root).write(productTask());
    const manifest = await v3Manifest(fixture.root, task.manifest_path);
    const sensitiveValue = `${String.fromCharCode(115, 107, 45)}${"a".repeat(48)}`;
    await writeFile(join(fixture.root, "src", "app.ts"), "export const redacted = true;\n");
    await writeV3Result(fixture.root, task.result_json_path, {
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "Implemented with sensitive text in reported product evidence.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "Required for the product outcome." }],
      commands_run: [],
      tests: ["passed"],
      product_acceptance_criteria: productCriteria(manifest, "passed").map((entry) => ({
        ...entry,
        evidence: `Evidence accidentally included ${sensitiveValue}.`
      })),
      technical_acceptance_criteria: technicalCriteria(manifest, "passed"),
      scope_extension_required: [],
      blockers: [],
      followups: []
    });

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    if (review.product_evidence.status !== "available") throw new Error("Expected available product evidence.");
    expect(review.product_evidence.product_acceptance_criteria[0]?.agent_evidence).toContain("[REDACTED_SECRET]");
    expect(review.product_evidence.product_acceptance_criteria[0]?.agent_evidence).not.toContain(sensitiveValue);
  });

  test("fails technical readiness and withholds product evidence when v3 integrity is broken", async () => {
    const fixture = await reviewFixture(true);
    const task = await v3Service(fixture.root).write(productTask());
    const manifest = await v3Manifest(fixture.root, task.manifest_path);
    await writeFile(join(fixture.root, "src", "app.ts"), "export const tamperedReview = true;\n");
    await writeV3Result(fixture.root, task.result_json_path, {
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "The result exists but the prompt binding is no longer trustworthy.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "Claimed product change." }],
      commands_run: [],
      tests: ["passed"],
      product_acceptance_criteria: productCriteria(manifest, "passed"),
      technical_acceptance_criteria: technicalCriteria(manifest, "passed"),
      scope_extension_required: [],
      blockers: [],
      followups: []
    });
    await writeFile(join(fixture.root, task.prompt_path), "# tampered review prompt\n");

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.integrity.manifest_bound).toBe(false);
    expect(review.technical_readiness).toMatchObject({
      status: "failed",
      checks: { integrity: "failed" },
      blocking_reasons: expect.arrayContaining(["TECHNICAL_CHECK_FAILED:integrity"])
    });
    expect(review.product_review).toEqual({
      requirement: "required",
      status: "pending",
      source: "manifest"
    });
    expect(review.product_evidence).toEqual({ status: "unavailable", reason: "integrity_failed" });
    expectNoHappyPathPayloads(review);
  });

  test("projects legacy v2 technical readiness and explicit product-review unavailability", async () => {
    const fixture = await reviewFixture(false);
    const task = await v2Service(fixture.root).write({
      repo_id: "fixture",
      title: "Legacy v2 review",
      objective: "Change the app through the historical contract.",
      allowed_paths: ["src/**"],
      acceptance_criteria: ["The app is updated"]
    });
    await writeFile(join(fixture.root, "src", "app.ts"), "export const legacy = true;\n");
    await mkdir(dirname(join(fixture.root, task.result_json_path)), { recursive: true });
    await writeFile(join(fixture.root, task.result_json_path), `${JSON.stringify({
      schema_version: 2,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "Implemented the legacy change.",
      changed_files: ["src/app.ts"],
      commands_run: [],
      tests: ["passed"],
      acceptance_criteria: [{ id: "AC-1", status: "passed", evidence: "Verified." }],
      blockers: [],
      followups: []
    }, null, 2)}\n`);

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.technical_readiness.status).toBe("passed");
    expect(review.technical_acceptance_evidence).toMatchObject({ complete: true, all_passed: true });
    expect(review.product_review).toEqual({
      requirement: "unavailable",
      status: "unavailable",
      source: "legacy_unavailable"
    });
    expect(review.product_evidence).toEqual({ status: "unavailable", reason: "legacy_run" });
    expect(review.warnings).toContain("CODEX_PRODUCT_REVIEW_UNAVAILABLE_LEGACY");
  });
});

async function reviewFixture(withProductContract: boolean) {
  const fixture = await createRepoFixture();
  await writeFile(join(fixture.root, "README.md"), "# Review Evidence Fixture\n");
  if (withProductContract) {
    await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(productContract(), null, 2)}\n`);
  }
  await execFileAsync("git", ["init"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  const tracked = ["README.md", "docs/guide.md", "src/app.ts", ...(withProductContract ? ["docs/product-contract.json"] : [])];
  await execFileAsync("git", ["add", "--", ...tracked], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  return fixture;
}

function v3Service(root: string) {
  return new DelegationV3TaskService(
    root,
    new PathSandbox(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => NOW
  );
}

function v2Service(root: string) {
  return new LegacyCodexV2TaskFixture(
    root,
    new PathSandbox(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => NOW
  );
}

function reviewService(root: string) {
  return new CodexResultService(new PathSandbox(root), new GitReviewService(root), root);
}

async function v3Manifest(root: string, path: string) {
  const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(root, path), "utf8")) as unknown);
  if (manifest.schema_version !== 3) throw new Error("Expected Delegation v3 manifest.");
  return manifest;
}

function productCriteria(
  manifest: Awaited<ReturnType<typeof v3Manifest>>,
  status: "passed" | "failed" | "unverified"
) {
  if (!("product_alignment" in manifest.task)) return [];
  return manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => ({
    id,
    status,
    evidence: "Bound product evidence."
  }));
}

function technicalCriteria(
  manifest: Awaited<ReturnType<typeof v3Manifest>>,
  status: "passed" | "failed" | "unverified"
) {
  return manifest.task.technical_acceptance_criteria.map(({ id }) => ({
    id,
    status,
    evidence: "Bound technical evidence."
  }));
}

async function writeV3Result(root: string, path: string, result: unknown): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), `${JSON.stringify(result, null, 2)}\n`);
}

function expectNoHappyPathPayloads(review: Awaited<ReturnType<ReturnType<typeof reviewService>["review"]>>): void {
  for (const payloads of [review.next_tool_payloads, review.git_review?.next_tool_payloads]) {
    expect(payloads?.repo_write_stage_dry_run).toBeUndefined();
    expect(payloads?.repo_write_stage_actual).toBeUndefined();
    expect(payloads?.repo_write_stage_commit_dry_run).toBeUndefined();
    expect(payloads?.repo_write_stage_commit_actual).toBeUndefined();
    expect(payloads?.repo_write_commit_dry_run).toBeUndefined();
  }
  expect(review.git_review?.recommendation.ready_to_stage).toBe(false);
}
