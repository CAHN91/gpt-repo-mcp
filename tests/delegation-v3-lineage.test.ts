import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { ProductContract } from "../src/contracts/product-contract.contract.js";
import {
  DelegationTaskV3ToolInputSchema,
  type DelegationTaskV3ToolOutput
} from "../src/contracts/delegation-v3.contract.js";
import { CodexResultService } from "../src/services/codex-result-service.js";
import { parseCodexRunManifest } from "../src/services/codex-run-manifest.js";
import { DelegationV3TaskService } from "../src/services/delegation-v3-task-service.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";
import { productTaskInput } from "./fixtures/delegation-v3-fixtures.js";
import { writeV3Result } from "./fixtures/delegation-v3-run-fixture.js";

const execFileAsync = promisify(execFile);
const ROOT_RUN_ID = "2026-07-19T103000Z-lineage-root";
const CHILD_ONE_ID = "2026-07-19T103100Z-lineage-child-one";
const CHILD_TWO_ID = "2026-07-19T103200Z-lineage-child-two";
const CHILD_THREE_ID = "2026-07-19T103300Z-lineage-child-three";

function productContract(): ProductContract {
  return {
    schema_version: 1,
    product: {
      name: "Fixture Delegation",
      purpose: "Keep delegated repository work coherent, product-grounded, and safely extensible."
    },
    primary_users: [{
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical but time-constrained",
      work_context: "Coordinates ChatGPT and implementation agents across trusted repositories."
    }],
    jobs_to_be_done: [{
      id: "delegate-coherent-work",
      statement: "Delegate complete implementation without losing product intent or silently expanding authorization."
    }],
    must_reduce: ["Prompt reconstruction", "Unexplained scope expansion"],
    must_not_become: ["A file-by-file prompt factory", "An unbounded agent loop"],
    experience_principles: ["Inherited product intent remains explicit", "Authorization changes require evidence"],
    canonical_docs: ["docs/guide.md"],
    governance: {
      mode: "advisory",
      product_review_required_for: ["product_slice", "product_correction"],
      checkpoint_every_root_runs: 5
    }
  };
}

describe("Delegation v3 lineage", () => {
  test("returns a structured lineage error when the requested parent run is missing", async () => {
    const fixture = await lineageFixture();
    const service = taskService(fixture.root);
    const missingParentRunId = "2026-07-19T000000Z-intentionally-missing-parent";

    await expect(service.prepare({
      ...rootTask(),
      run_id: CHILD_ONE_ID,
      lineage: {
        kind: "corrective",
        parent_run_id: missingParentRunId,
        reason: "Verify that a missing parent fails closed at the lineage boundary."
      }
    })).rejects.toMatchObject({
      code: "RUNNER_POLICY_BLOCKED",
      message: "Delegation v3 parent manifest is unavailable.",
      diagnostics: { parent_run_id: missingParentRunId }
    });
  });

  test("writes a corrective child with inherited root contracts, bounded authorization, fresh baseline, and lineage prompt", async () => {
    const fixture = await lineageFixture();
    const service = taskService(fixture.root);
    const rootInput = rootTask({ authorization_scope: ["src/**", "tests/**"] });
    const root = await service.write(rootInput);
    const rootManifest = await readV3Manifest(fixture.root, root.manifest_path);

    await writeFile(join(fixture.root, "src", "app.ts"), "export const corrected = false;\n");
    await writeV3Result(fixture.root, root.run_id, {
      status: "blocked",
      changed_files: ["src/app.ts"],
      blockers: ["The first implementation needs a bounded correction inside the existing authorization."]
    });
    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: root.run_id });
    const payload = childPayload(review.next_tool_payloads?.repo_write_codex_task);

    expect(review.review_loop).toMatchObject({
      status: "eligible",
      root_run_id: root.run_id,
      next_parent_run_id: root.run_id,
      next_child_index: 1,
      next_child_kind: "corrective",
      children_created: 0,
      max_children: 2
    });
    expect(payload.lineage).toEqual({
      kind: "corrective",
      parent_run_id: root.run_id,
      reason: expect.stringContaining(root.run_id)
    });

    const narrowedPayload = DelegationTaskV3ToolInputSchema.parse({
      ...payload,
      run_id: CHILD_ONE_ID,
      starting_points: ["src/app.ts"],
      authorization_scope: ["src/app.ts"]
    });
    const child = await service.write(narrowedPayload);
    const childManifest = await readV3Manifest(fixture.root, child.manifest_path);
    const childPrompt = await readFile(join(fixture.root, child.prompt_path), "utf8");

    expect(child.lineage).toEqual({
      kind: "corrective",
      parent_run_id: root.run_id,
      root_run_id: root.run_id,
      child_index: 1,
      max_children: 2
    });
    expect(child.warnings).toContain("DELEGATION_V3_CORRECTIVE_CHILD");
    expect(childManifest.task.lineage).toMatchObject({
      kind: "corrective",
      parent_run_id: root.run_id,
      root_run_id: root.run_id,
      child_index: 1,
      parent_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      root_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(childManifest.product_binding).toEqual(rootManifest.product_binding);
    expect(childManifest.review_requirement).toBe(rootManifest.review_requirement);
    expect(childManifest.task.outcome).toEqual(rootManifest.task.outcome);
    expect(childManifest.task.hard_constraints).toEqual(rootManifest.task.hard_constraints);
    expect(childManifest.task.must_preserve).toEqual(rootManifest.task.must_preserve);
    expect(childManifest.task.explicit_exclusions).toEqual(rootManifest.task.explicit_exclusions);
    expect(childManifest.task.authorization_scope).toEqual(["src/app.ts"]);
    expect(childManifest.baseline.initial_changed_paths).toContain("src/app.ts");
    expect(childManifest.baseline_sha256).not.toBe(rootManifest.baseline_sha256);
    expect(childPrompt).toContain("## Lineage");
    expect(childPrompt).toContain("- kind: corrective");
    expect(childPrompt).toContain("Stay within the inherited or narrower authorization boundary.");
    expect(childPrompt.indexOf("## Product or Operational Frame")).toBeLessThan(childPrompt.indexOf("## Lineage"));
    expect(childPrompt.indexOf("## Lineage")).toBeLessThan(childPrompt.indexOf("## Assignment"));
  });

  test("creates a scope-amendment child only from exact structured parent RESULT.json evidence", async () => {
    const fixture = await lineageFixture();
    const service = taskService(fixture.root);
    const root = await service.write(rootTask({
      authorization_scope: ["src/**"],
      starting_points: ["src/**"]
    }));
    await writeV3Result(fixture.root, root.run_id, {
      status: "blocked",
      scope_extension_required: [{
        path_or_area: "tests/**",
        reason: "The inherited outcome requires regression coverage outside the original authorization.",
        required_outcome: "Add bounded regression tests for the completed implementation."
      }]
    });

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: root.run_id });
    const payload = childPayload(review.next_tool_payloads?.repo_write_codex_task);

    expect(review.review_loop).toMatchObject({
      status: "eligible",
      next_child_kind: "scope_amendment",
      authorization_scope: ["src/**"],
      scope_extension_required: [{ path_or_area: "tests/**" }]
    });
    expect(payload.authorization_scope).toEqual(["src/**", "tests/**"]);
    expect(payload.lineage).toEqual({
      kind: "scope_amendment",
      parent_run_id: root.run_id,
      reason: expect.stringContaining(root.run_id),
      authorization_additions: ["tests/**"]
    });

    const child = await service.write({ ...payload, run_id: CHILD_ONE_ID });
    const manifest = await readV3Manifest(fixture.root, child.manifest_path);
    const prompt = await readFile(join(fixture.root, child.prompt_path), "utf8");

    expect(child.lineage?.kind).toBe("scope_amendment");
    expect(child.warnings).toContain("DELEGATION_V3_SCOPE_AMENDMENT_CHILD");
    expect(manifest.task.authorization_scope).toEqual(["src/**", "tests/**"]);
    expect(manifest.task.lineage).toMatchObject({
      kind: "scope_amendment",
      authorization_additions: ["tests/**"],
      evidence: {
        source: "parent_result",
        parent_result_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        scope_extension_required: [{ path_or_area: "tests/**" }]
      }
    });
    expect(prompt).toContain("- approved authorization additions:");
    expect(prompt).toContain("  - tests/**");
    expect(prompt).toContain("evidence source: parent RESULT.json");

    await expect(service.write({
      ...payload,
      run_id: CHILD_TWO_ID,
      authorization_scope: ["src/**", "tests/**", "docs/**"],
      lineage: {
        kind: "scope_amendment",
        parent_run_id: root.run_id,
        reason: "Attempt an unrelated authorization expansion.",
        authorization_additions: ["tests/**", "docs/**"]
      }
    })).rejects.toMatchObject({ code: "RUNNER_POLICY_BLOCKED" });
  });

  test("rejects child attempts that weaken root product, PAC, hard, preservation, exclusion, or authorization contracts", async () => {
    const fixture = await lineageFixture();
    const service = taskService(fixture.root);
    const root = await service.write(rootTask({ authorization_scope: ["src/**"] }));
    await writeV3Result(fixture.root, root.run_id, {
      status: "blocked",
      blockers: ["The inherited implementation requires correction without scope expansion."]
    });
    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: root.run_id });
    const payload = childPayload(review.next_tool_payloads?.repo_write_codex_task);
    if (!payload.product_alignment) throw new Error("Expected product child payload.");

    const attempts = [
      {
        ...payload,
        run_id: CHILD_ONE_ID,
        outcome: { ...payload.outcome, desired_outcome: "Replace the inherited outcome." }
      },
      {
        ...payload,
        run_id: CHILD_ONE_ID,
        product_alignment: { ...payload.product_alignment, product_goal: "Replace the inherited product goal." }
      },
      {
        ...payload,
        run_id: CHILD_ONE_ID,
        product_alignment: {
          ...payload.product_alignment,
          product_acceptance_criteria: payload.product_alignment.product_acceptance_criteria.slice(1)
        }
      },
      { ...payload, run_id: CHILD_ONE_ID, hard_constraints: [] },
      { ...payload, run_id: CHILD_ONE_ID, must_preserve: [] },
      { ...payload, run_id: CHILD_ONE_ID, explicit_exclusions: [] },
      { ...payload, run_id: CHILD_ONE_ID, authorization_scope: ["docs/**"] }
    ];

    for (const attempt of attempts) {
      await expect(service.write(attempt)).rejects.toMatchObject({ code: "RUNNER_POLICY_BLOCKED" });
    }
  });

  test("blocks review payloads and direct child creation when the parent prompt-manifest binding is tampered", async () => {
    const fixture = await lineageFixture();
    const service = taskService(fixture.root);
    const root = await service.write(rootTask({ authorization_scope: ["src/**"] }));
    await writeV3Result(fixture.root, root.run_id, {
      status: "blocked",
      blockers: ["A correction would otherwise be eligible."]
    });
    await writeFile(join(fixture.root, root.prompt_path), "# tampered parent prompt\n");

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: root.run_id });
    expect(review.integrity.manifest_bound).toBe(false);
    expect(review.review_loop).toMatchObject({
      status: "blocked",
      next_parent_run_id: null,
      next_child_index: null,
      next_child_kind: null
    });
    expect(review.next_tool_payloads).not.toHaveProperty("repo_write_codex_task");

    const rootManifest = await readV3Manifest(fixture.root, root.manifest_path);
    const manualAttempt = DelegationTaskV3ToolInputSchema.parse({
      ...rootManifest.task,
      run_id: CHILD_ONE_ID,
      title: "Tampered parent child attempt",
      assignment: "Attempt a child from a tampered parent chain.",
      lineage: {
        kind: "corrective",
        parent_run_id: root.run_id,
        reason: "This must fail before any child artifact is written."
      }
    });
    await expect(service.write(manualAttempt)).rejects.toMatchObject({ code: "RUNNER_POLICY_BLOCKED" });
  });

  test("blocks child baselines when the parent already contains newly observed unauthorized changes", async () => {
    const fixture = await lineageFixture();
    const service = taskService(fixture.root);
    const root = await service.write(rootTask({ authorization_scope: ["src/**"] }));
    await writeV3Result(fixture.root, root.run_id, {
      status: "blocked",
      scope_extension_required: [{
        path_or_area: "tests/**",
        reason: "Regression tests are required outside the original authorization.",
        required_outcome: "Add bounded test coverage after authorization is amended."
      }]
    });
    await writeFile(join(fixture.root, "docs", "guide.md"), "# Unauthorized parent change\n");

    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: root.run_id });
    expect(review.review_loop).toMatchObject({
      status: "blocked",
      next_parent_run_id: null,
      next_child_index: null,
      next_child_kind: null
    });
    expect(review.next_tool_payloads).not.toHaveProperty("repo_write_codex_task");

    const rootManifest = await readV3Manifest(fixture.root, root.manifest_path);
    const manualAttempt = DelegationTaskV3ToolInputSchema.parse({
      ...rootManifest.task,
      run_id: CHILD_ONE_ID,
      title: "Unauthorized baseline laundering attempt",
      assignment: "Attempt to create a child while an unrelated unauthorized change is already present.",
      authorization_scope: ["src/**", "tests/**"],
      lineage: {
        kind: "scope_amendment",
        parent_run_id: root.run_id,
        reason: "Only tests were requested by parent evidence.",
        authorization_additions: ["tests/**"]
      }
    });
    await expect(service.write(manualAttempt)).rejects.toMatchObject({ code: "RUNNER_POLICY_BLOCKED" });
  });

  test("serializes concurrent child writes and rejects reuse of the same generated run id", async () => {
    const fixture = await lineageFixture();
    const service = taskService(fixture.root);
    const root = await service.write(rootTask({ authorization_scope: ["src/**"] }));
    await writeV3Result(fixture.root, root.run_id, {
      status: "blocked",
      scope_extension_required: [{
        path_or_area: "tests/**",
        reason: "Regression coverage is required outside the original authorization.",
        required_outcome: "Add bounded tests for the inherited outcome."
      }]
    });
    const review = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: root.run_id });
    const payload = childPayload(review.next_tool_payloads?.repo_write_codex_task);

    const results = await Promise.allSettled([
      service.write(payload),
      service.write(payload)
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    if (!rejected || rejected.status !== "rejected") throw new Error("Expected one rejected concurrent child write.");
    expect(rejected.reason).toMatchObject({ code: "RUNNER_POLICY_BLOCKED" });

    const rereview = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: root.run_id });
    expect(rereview.review_loop).toMatchObject({
      status: "eligible",
      children_created: 1,
      next_child_index: 2
    });
  });

  test("shares one bounded two-child limit across corrective and scope-amendment descendants", async () => {
    const fixture = await lineageFixture();
    const service = taskService(fixture.root);
    const root = await service.write(rootTask({ authorization_scope: ["src/**"] }));
    await writeV3Result(fixture.root, root.run_id, {
      status: "blocked",
      scope_extension_required: [{
        path_or_area: "tests/**",
        reason: "Regression tests are required outside the root authorization.",
        required_outcome: "Cover the inherited outcome with regression tests."
      }]
    });

    const rootReview = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: root.run_id });
    const firstPayload = childPayload(rootReview.next_tool_payloads?.repo_write_codex_task);
    const first = await service.write({ ...firstPayload, run_id: CHILD_ONE_ID });
    await writeV3Result(fixture.root, first.run_id, {
      status: "blocked",
      blockers: ["The amended implementation needs one final correction inside its inherited authorization."]
    });

    const firstReview = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: first.run_id });
    const secondPayload = childPayload(firstReview.next_tool_payloads?.repo_write_codex_task);
    expect(secondPayload.lineage?.kind).toBe("corrective");
    const second = await service.write({ ...secondPayload, run_id: CHILD_TWO_ID });
    await writeV3Result(fixture.root, second.run_id);

    const secondReview = await reviewService(fixture.root).review({ repo_id: "fixture", run_id: second.run_id });
    expect(secondReview.review_loop).toMatchObject({
      status: "limit_reached",
      root_run_id: root.run_id,
      children_created: 2,
      max_children: 2,
      next_child_index: null,
      next_child_kind: null
    });
    expect(secondReview.next_tool_payloads).not.toHaveProperty("repo_write_codex_task");

    const secondManifest = await readV3Manifest(fixture.root, second.manifest_path);
    const directThirdAttempt = DelegationTaskV3ToolInputSchema.parse({
      ...secondManifest.task,
      run_id: CHILD_THREE_ID,
      title: "Disallowed third child",
      assignment: "Attempt a third child after the shared root limit.",
      lineage: {
        kind: "corrective",
        parent_run_id: second.run_id,
        reason: "Attempt to exceed the shared lineage limit."
      }
    });
    await expect(service.write(directThirdAttempt)).rejects.toMatchObject({ code: "RUNNER_POLICY_BLOCKED" });
  });
});

function rootTask(overrides: Partial<ReturnType<typeof productTaskInput>> = {}) {
  const base = productTaskInput("product_correction");
  return DelegationTaskV3ToolInputSchema.parse({
    ...base,
    ...overrides,
    repo_id: "fixture",
    run_id: ROOT_RUN_ID
  });
}

function childPayload(value: DelegationTaskV3ToolOutput | undefined): DelegationTaskV3ToolOutput {
  if (!value) throw new Error("Expected review-generated Delegation v3 child payload.");
  return DelegationTaskV3ToolInputSchema.parse(value);
}

function taskService(root: string): DelegationV3TaskService {
  return new DelegationV3TaskService(
    root,
    new PathSandbox(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => new Date("2026-07-19T10:30:00.000Z")
  );
}

function reviewService(root: string): CodexResultService {
  return new CodexResultService(new PathSandbox(root), new GitReviewService(root), root);
}

async function readV3Manifest(root: string, path: string) {
  const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(root, path), "utf8")) as unknown);
  if (manifest.schema_version !== 3) throw new Error("Expected Delegation v3 manifest.");
  return manifest;
}

async function lineageFixture() {
  const fixture = await createRepoFixture();
  await writeFile(join(fixture.root, "README.md"), "# Fixture Delegation\n");
  await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(productContract(), null, 2)}\n`);
  await execFileAsync("git", ["init"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["add", "--", "README.md", "docs/guide.md", "docs/product-contract.json", "src/app.ts"], {
    cwd: fixture.root,
    env: { PATH: process.env.PATH ?? "" }
  });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  return fixture;
}
