import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { ProductContract } from "../src/contracts/product-contract.contract.js";
import { CodexResultService } from "../src/services/codex-result-service.js";
import { DelegationV3TaskService } from "../src/services/delegation-v3-task-service.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { parseCodexRunManifest } from "../src/services/codex-run-manifest.js";
import { codexRunPaths } from "../src/services/codex-run-paths.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

const execFileAsync = promisify(execFile);
const FIXED_NOW = new Date("2026-07-18T23:30:00.000Z");

function contract(): ProductContract {
  return {
    schema_version: 1,
    product: {
      name: "Fixture Operations",
      purpose: "Keep delegated repository work coherent, reviewable, and grounded in the intended operator outcome."
    },
    primary_users: [{
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical but time-constrained",
      work_context: "Reviews implementation outcomes across trusted local repositories."
    }],
    jobs_to_be_done: [{
      id: "review-coherent-work",
      statement: "Review whether delegated work is technically correct and still serves the intended product outcome."
    }],
    must_reduce: ["Prompt micromanagement"],
    must_not_become: ["A technically green but product-blind workflow"],
    experience_principles: ["Product outcome and technical evidence are reviewed separately"],
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
    title: "Review coherent product work",
    task_kind: "product_slice" as const,
    assignment: "Implement a small product-aware repository change and report separate product and technical evidence.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "A technically passing implementation can still lose the intended product outcome.",
      desired_outcome: "Review exposes both technical readiness and product evidence before any ship decision.",
      why_now: "Delegation v3 review compatibility is being activated."
    },
    product_alignment: {
      primary_user_id: "repo-operator",
      job_ids: ["review-coherent-work"],
      user_problem: "The operator cannot distinguish technical success from product success in one acceptance list.",
      product_goal: "Keep PAC and TAC evidence separate and require a later product attestation.",
      additional_must_not_become: [],
      product_acceptance_criteria: ["Product evidence remains separately visible in review."]
    },
    starting_points: ["src/app.ts"],
    authorization_scope: ["src/**", "tests/**"],
    forbidden_paths: [],
    hard_constraints: ["Preserve repository safety and exact run binding."],
    must_preserve: ["No stage or commit payload before product attestation."],
    explicit_exclusions: ["Do not push."],
    technical_acceptance_criteria: ["Manifest, result, and changed paths correlate exactly."],
    runner: { mode: "manual" as const }
  };
}

function technicalTask() {
  return {
    repo_id: "fixture",
    title: "Review technical result contract",
    task_kind: "technical_infrastructure" as const,
    assignment: "Verify that strict v3 review never accepts a legacy result fallback.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "Legacy markdown fallback could weaken a strict v3 result contract.",
      desired_outcome: "V3 requires RESULT.json and reports missing strict evidence.",
      why_now: "The result parser is being version-dispatched."
    },
    technical_context: { enabling_value: "Keep v3 review deterministic and fail-closed." },
    starting_points: ["src/app.ts"],
    authorization_scope: ["src/**"],
    forbidden_paths: [],
    hard_constraints: ["Do not interpret RESULT.md as a v3 result."],
    must_preserve: ["Historical v1/v2 RESULT.md fallback remains available."],
    explicit_exclusions: [],
    technical_acceptance_criteria: ["V3 review requires RESULT.json."],
    runner: { mode: "manual" as const }
  };
}

describe("Delegation v3 review compatibility", () => {
  test("verifies v3 integrity and PAC/TAC evidence but suppresses ship payloads pending attestation", async () => {
    const fixture = await reviewFixture(true);
    const task = await taskService(fixture.root).write(productTask());
    const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(fixture.root, task.manifest_path), "utf8")));
    if (manifest.schema_version !== 3 || !("product_alignment" in manifest.task)) throw new Error("Expected product v3 manifest.");

    await writeFile(join(fixture.root, "src", "app.ts"), "export const productAware = true;\n");
    await writeFile(join(fixture.root, task.result_json_path), `${JSON.stringify({
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "Implemented a product-aware fixture change.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "Required to create the declared product outcome." }],
      commands_run: ["npm test"],
      tests: ["passed"],
      product_acceptance_criteria: manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => ({
        id,
        status: "verified",
        evidence: "Product evidence remains separate in review."
      })),
      technical_acceptance_criteria: manifest.task.technical_acceptance_criteria.map(({ id }) => ({
        id,
        status: "verified",
        evidence: "Manifest, result, and changed path correlate."
      })),
      scope_extension_required: [],
      blockers: [],
      followups: []
    }, null, 2)}\n`);

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.result_found).toBe(true);
    expect(review.result_source).toBe("RESULT.json");
    expect(review).not.toHaveProperty("legacy_result_path");
    expect(review.integrity).toMatchObject({
      manifest_version: 3,
      manifest_bound: true,
      head_matches_baseline: true,
      task_binding_matches: true,
      product_binding_matches: true,
      authorization_matches: true
    });
    expect(review.acceptance_evidence).toMatchObject({
      binding_available: true,
      complete: true,
      all_passed: true,
      missing_ids: [],
      unknown_ids: [],
      duplicate_ids: []
    });
    expect(review.codex_result?.product_acceptance_results?.every(({ id }) => id.startsWith("PAC-"))).toBe(true);
    expect(review.codex_result?.technical_acceptance_results?.every(({ id }) => id.startsWith("TAC-"))).toBe(true);
    expect(review.scope_evidence).toMatchObject({
      newly_observed_paths: ["src/app.ts"],
      out_of_scope_paths: [],
      forbidden_paths: [],
      observed_but_unreported: []
    });
    expect(review.warnings).toContain("DELEGATION_V3_REVIEW_ATTESTATION_REQUIRED");
    expect(review.warnings).toContain("DELEGATION_V3_STATUS_VERIFIED_NORMALIZED");
    expect(review.warnings).toContain("CODEX_HAPPY_PATH_PAYLOADS_SUPPRESSED");
    expect(review.git_review?.recommendation.ready_to_stage).toBe(false);
    expect(review.next_tool_payloads).not.toHaveProperty("repo_write_stage_actual");
    expect(review.next_tool_payloads).not.toHaveProperty("repo_write_stage_commit_actual");
    expect(review.next_tool_payloads).not.toHaveProperty("repo_write_commit_dry_run");
    expect(review.review_loop).toMatchObject({
      status: "not_applicable",
      next_child_index: null,
      next_child_kind: null
    });
    expect(review.next_tool_payloads).not.toHaveProperty("repo_write_codex_task");
  });

  test("attributes a claimed file that was already dirty when the run started", async () => {
    const fixture = await reviewFixture(true);
    await writeFile(join(fixture.root, "src", "app.ts"), "export const value = 'dirty-before-run';\n");
    const task = await taskService(fixture.root).write(productTask());
    const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(fixture.root, task.manifest_path), "utf8")));
    if (manifest.schema_version !== 3 || !("product_alignment" in manifest.task)) throw new Error("Expected product v3 manifest.");
    expect(manifest.baseline.initial_path_states?.map(({ path }) => path)).toContain("src/app.ts");

    await writeFile(join(fixture.root, "src", "app.ts"), "export const value = 'changed-by-run';\n");
    await writeFile(join(fixture.root, task.result_json_path), `${JSON.stringify({
      schema_version: 3,
      repo_id: "fixture",
      run_id: task.run_id,
      status: "completed",
      summary: "Changed the already-dirty file for the requested outcome.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "The run changed this file after its captured dirty baseline." }],
      commands_run: ["npm test"],
      tests: ["passed"],
      product_acceptance_criteria: manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => ({ id, status: "passed", evidence: "Product outcome confirmed." })),
      technical_acceptance_criteria: manifest.task.technical_acceptance_criteria.map(({ id }) => ({ id, status: "passed", evidence: "Technical outcome confirmed." })),
      scope_extension_required: [],
      blockers: [],
      followups: []
    }, null, 2)}\n`);

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });
    expect(review.scope_evidence).toMatchObject({
      pre_existing_paths: expect.arrayContaining(["src/app.ts"]),
      attributed_paths: ["src/app.ts"],
      dirty_baseline_attributed_paths: ["src/app.ts"],
      attribution_ambiguous_paths: [],
      claimed_but_not_observed: []
    });
    expect(review.technical_readiness.status).toBe("passed");
  });

  test("requires RESULT.json for v3 and does not use legacy RESULT.md fallback", async () => {
    const fixture = await reviewFixture(false);
    const task = await taskService(fixture.root).write(technicalTask());
    const legacyResultPath = codexRunPaths(task.run_id).resultPath;
    await writeFile(join(fixture.root, legacyResultPath), "# Legacy-looking result\nstatus: completed\n");

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: task.run_id });

    expect(review.result_found).toBe(false);
    expect(review.result_source).toBeUndefined();
    expect(review).not.toHaveProperty("legacy_result_path");
    expect(review.warnings).toContain("DELEGATION_V3_RESULT_JSON_REQUIRED");
    expect(review.warnings).toContain("CODEX_RESULT_MISSING");
  });

  test("rejects unsupported manifest versions instead of treating them as v1", () => {
    expect(() => parseCodexRunManifest({
      schema_version: 4,
      repo_id: "fixture",
      run_id: "2026-07-18T233000Z-unsupported"
    })).toThrow(/version 1, 2, or 3/);
    expect(() => parseCodexRunManifest({
      repo_id: "fixture",
      run_id: "2026-07-18T233000Z-missing-version"
    })).toThrow(/version 1, 2, or 3/);
  });
});

function taskService(root: string): DelegationV3TaskService {
  return new DelegationV3TaskService(
    root,
    new PathSandbox(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => FIXED_NOW
  );
}

function reviewService(root: string): CodexResultService {
  return new CodexResultService(new PathSandbox(root), new GitReviewService(root), root);
}

async function reviewFixture(withProductContract: boolean) {
  const fixture = await createRepoFixture();
  await writeFile(join(fixture.root, "README.md"), "# Fixture Operations\n");
  if (withProductContract) {
    await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(contract(), null, 2)}\n`);
  }
  await execFileAsync("git", ["init"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  const tracked = ["README.md", "docs/guide.md", "src/app.ts", ...(withProductContract ? ["docs/product-contract.json"] : [])];
  await execFileAsync("git", ["add", "--", ...tracked], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  return fixture;
}
