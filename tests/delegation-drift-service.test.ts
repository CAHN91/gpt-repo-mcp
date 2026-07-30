import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexReviewAttestationV2Schema } from "../src/contracts/codex-review-attestation.contract.js";
import {
  DelegationRunManifestV3Schema,
  type DelegationRunManifestV3,
  type DelegationTaskV3
} from "../src/contracts/delegation-v3.contract.js";
import { DelegationDriftService } from "../src/services/delegation-drift-service.js";
import { DelegationV3TaskService } from "../src/services/delegation-v3-task-service.js";
import { delegationTaskSha256V3 } from "../src/services/delegation-v3-normalizer.js";
import { codexRunPaths } from "../src/services/codex-run-paths.js";
import { codexReviewAttestationAnySha256 } from "../src/services/codex-review-state.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";
import { writeQueuedV3Run, writeV3Result } from "./fixtures/delegation-v3-run-fixture.js";
import { technicalTaskInput } from "./fixtures/delegation-v3-fixtures.js";

const ROOT_A = "2026-07-20T120000Z-drift-root-a";
const ROOT_B = "2026-07-20T120100Z-drift-root-b";
const ROOT_C = "2026-07-20T120200Z-drift-root-c";
const ROOT_D = "2026-07-20T120300Z-drift-root-d";
const ROOT_E = "2026-07-20T120400Z-drift-root-e";
const CHILD_A = "2026-07-20T120500Z-drift-corrective-a";
const CHILD_B = "2026-07-20T120600Z-drift-corrective-b";

function productContract(checkpointEveryRootRuns = 3) {
  return {
    schema_version: 1,
    product: {
      name: "Fixture Product",
      purpose: "Keep delegated repository work coherent and product-aware."
    },
    primary_users: [{
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical",
      work_context: "Coordinates implementation work across a trusted local repository."
    }],
    jobs_to_be_done: [{
      id: "delegate-coherent-work",
      statement: "Delegate coherent work without losing the intended outcome."
    }],
    must_reduce: ["Prompt micromanagement"],
    must_not_become: ["A competing planning engine"],
    experience_principles: ["Outcome before implementation detail"],
    canonical_docs: ["docs/guide.md"],
    governance: {
      mode: "advisory" as const,
      product_review_required_for: ["product_slice", "product_correction"] as const,
      checkpoint_every_root_runs: checkpointEveryRootRuns
    }
  };
}

describe("DelegationDriftService", () => {
  test("returns bounded no-history evidence without inventing a trend", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(productContract(), null, 2)}\n`);

    const result = await service(fixture.root).analyze("fixture");

    expect(result).toMatchObject({
      status: "no_history",
      observed_v3_run_count: 0,
      root_run_count: 0,
      signals: [],
      repeated_areas: [],
      prompt_bytes: { sample_count: 0, trend: "insufficient_data" },
      checkpoint: {
        status: "no_history",
        governance_mode: "advisory",
        threshold_root_runs: 3,
        root_runs_since_last_product_checkpoint: 0
      }
    });
    expect(result).not.toHaveProperty("recommendation");
    expect(result).not.toHaveProperty("next_action");
    expect(result).not.toHaveProperty("priority");
  });

  test("counts root runs after the product review timestamp rather than after the reviewed run", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(productContract(2), null, 2)}\n`);
    const reviewed = await writeQueuedV3Run(fixture.root, ROOT_A, {
      task_kind: "product_slice",
      created_at: "2026-07-20T12:00:00.000Z"
    });
    await writeQueuedV3Run(fixture.root, ROOT_B, {
      task_kind: "technical_infrastructure",
      created_at: "2026-07-20T12:10:00.000Z"
    });
    await writeLatePassingReview(fixture.root, reviewed, "2026-07-20T12:20:00.000Z");

    const result = await service(fixture.root).analyze("fixture");

    expect(result.checkpoint).toMatchObject({
      status: "current",
      root_runs_since_last_product_checkpoint: 0,
      latest_product_checkpoint_run_id: ROOT_A,
      latest_product_checkpoint_at: "2026-07-20T12:20:00.000Z"
    });
  });

  test("detects bounded correction, scope, growth, repeated-area, checkpoint, and technical-dominance signals", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(productContract(), null, 2)}\n`);

    const roots = [ROOT_A, ROOT_B, ROOT_C, ROOT_D, ROOT_E];
    for (const [index, runId] of roots.entries()) {
      const manifest = await writeQueuedV3Run(fixture.root, runId, {
        task_kind: "technical_infrastructure",
        created_at: `2026-07-20T12:0${index}:00.000Z`,
        authorization_scope: Array.from({ length: 1 + index }, (_, scopeIndex) => `src/area-${scopeIndex + 1}/**`)
      });
      await rewriteRootMetrics(fixture.root, manifest, {
        promptByteCount: 1_000 + index * 400,
        startingPointCount: 1 + index
      });
      if (index < 2) {
        await writeV3Result(fixture.root, runId, {
          status: "blocked",
          changed_files: ["src/app.ts"],
          scope_extension_required: [{
            path_or_area: `packages/area-${index + 1}/**`,
            reason: "Required connected work lies outside the current authorization boundary.",
            required_outcome: "Complete the declared outcome without silent omission."
          }]
        });
      } else {
        await writeV3Result(fixture.root, runId, { changed_files: ["src/app.ts"] });
      }
    }

    const root = DelegationRunManifestV3Schema.parse(JSON.parse(
      await readFile(join(fixture.root, codexRunPaths(ROOT_A).manifestPath), "utf8")
    ));
    await writeCorrectiveChild(fixture.root, root, CHILD_A, 1, "2026-07-20T12:05:00.000Z");
    await writeCorrectiveChild(fixture.root, root, CHILD_B, 2, "2026-07-20T12:06:00.000Z");

    const result = await service(fixture.root).analyze("fixture");

    expect(result).toMatchObject({
      status: "observed",
      observed_v3_run_count: 7,
      root_run_count: 5,
      product_root_run_count: 0,
      technical_root_run_count: 5,
      child_run_count: 2,
      corrective_child_count: 2,
      scope_extension_run_count: 2,
      maximum_corrective_children_per_root: 2,
      checkpoint: {
        status: "due",
        governance_mode: "advisory",
        threshold_root_runs: 3,
        root_runs_since_last_product_checkpoint: 5
      },
      prompt_bytes: { sample_count: 5, first: 1_000, latest: 2_600, trend: "increasing" },
      starting_point_count: { sample_count: 5, first: 1, latest: 5, trend: "increasing" },
      authorization_pattern_count: { sample_count: 5, first: 1, latest: 5, trend: "increasing" },
      repeated_areas: [{ area: "src", run_count: 5 }]
    });
    expect(result.signals).toEqual(expect.arrayContaining([
      "DELEGATION_DRIFT_CORRECTION_LOOP",
      "DELEGATION_DRIFT_SCOPE_EXTENSION_FREQUENT",
      "DELEGATION_DRIFT_PROMPT_GROWTH",
      "DELEGATION_DRIFT_AUTHORIZATION_GROWTH",
      "DELEGATION_DRIFT_REPEATED_AREA",
      "DELEGATION_PRODUCT_CHECKPOINT_DUE",
      "DELEGATION_DRIFT_TECHNICAL_ROOT_DOMINANCE"
    ]));

    const prepared = await new DelegationV3TaskService(
      fixture.root,
      new PathSandbox(fixture.root),
      new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] })
    ).prepare({
      ...technicalTaskInput(),
      run_id: "2026-07-20T120700Z-drift-audit-projection"
    });
    expect(prepared.delegation_audit.verdict).toBe("passed_with_warnings");
    expect(prepared.delegation_audit.warnings).toEqual(expect.arrayContaining(result.signals));
  });
});

async function writeLatePassingReview(
  root: string,
  manifest: DelegationRunManifestV3,
  reviewedAt: string
): Promise<void> {
  const placeholder = CodexReviewAttestationV2Schema.parse({
    schema_version: 2,
    review_gate_sha256: "d".repeat(64),
    repo_id: manifest.repo_id,
    run_id: manifest.run_id,
    reviewer: "chatgpt",
    review_requirement: manifest.review_requirement,
    product_verdict: "passed",
    rationale: "Late product checkpoint review.",
    evidence: manifest.task.task_kind === "product_slice" || manifest.task.task_kind === "product_correction"
      ? manifest.task.product_alignment.product_acceptance_criteria.map(({ id }) => ({
          criterion_id: id,
          verdict: "passed" as const,
          evidence: "Checkpoint evidence."
        }))
      : [],
    reviewed_at: reviewedAt,
    binding: {
      status: "available",
      state_sha256: "c".repeat(64),
      manifest_sha256: "a".repeat(64),
      prompt_sha256: manifest.prompt_sha256,
      result_sha256: "b".repeat(64),
      head_sha: manifest.baseline.head_sha,
      worktree_fingerprint: manifest.baseline.worktree_fingerprint,
      changed_paths: [],
      technical_readiness_sha256: "e".repeat(64),
      product_review_sha256: "f".repeat(64),
      product_evidence_sha256: "1".repeat(64),
      scope_evidence_sha256: "2".repeat(64),
      technical_acceptance_sha256: "3".repeat(64),
      product_acceptance_sha256: "4".repeat(64)
    },
    technical_readiness: {
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
        validation: "passed"
      },
      blocking_reasons: [],
      incomplete_reasons: []
    },
    product_review: {
      requirement: "required",
      status: "pending",
      source: "manifest"
    },
    review_sha256: "0".repeat(64)
  });
  const review = CodexReviewAttestationV2Schema.parse({
    ...placeholder,
    review_sha256: codexReviewAttestationAnySha256(placeholder)
  });
  await writeFile(join(root, codexRunPaths(manifest.run_id).reviewPath), `${JSON.stringify(review, null, 2)}\n`);
}

function service(root: string) {
  return new DelegationDriftService(root, new PathSandbox(root));
}

async function rewriteRootMetrics(
  root: string,
  manifest: DelegationRunManifestV3,
  input: { promptByteCount: number; startingPointCount: number }
): Promise<void> {
  const startingPoints = Array.from({ length: input.startingPointCount }, (_, index) => `src/start-${index + 1}/**`);
  const task = {
    ...manifest.task,
    starting_points: startingPoints
  } as DelegationTaskV3;
  const rewritten = DelegationRunManifestV3Schema.parse({
    ...manifest,
    task,
    authorization: {
      ...manifest.authorization,
      starting_points: startingPoints
    },
    task_sha256: delegationTaskSha256V3(task),
    prompt_byte_count: input.promptByteCount
  });
  await writeFile(join(root, rewritten.manifest_path), `${JSON.stringify(rewritten, null, 2)}\n`);
}

async function writeCorrectiveChild(
  root: string,
  rootManifest: DelegationRunManifestV3,
  childRunId: string,
  childIndex: 1 | 2,
  createdAt: string
): Promise<void> {
  const paths = codexRunPaths(childRunId);
  const task = {
    ...rootManifest.task,
    run_id: childRunId,
    title: `Correct drift fixture ${childIndex}`,
    lineage: {
      kind: "corrective" as const,
      parent_run_id: childIndex === 1 ? rootManifest.run_id : CHILD_A,
      root_run_id: rootManifest.run_id,
      child_index: childIndex,
      max_children: 2 as const,
      reason: "Correct the incomplete previous implementation without changing the root outcome.",
      parent_manifest_sha256: "b".repeat(64),
      root_manifest_sha256: "c".repeat(64)
    }
  } as DelegationTaskV3;
  const manifest = DelegationRunManifestV3Schema.parse({
    ...rootManifest,
    run_id: childRunId,
    title: task.title,
    task,
    prompt_path: paths.promptPath,
    result_json_path: paths.resultJsonPath,
    manifest_path: paths.manifestPath,
    task_sha256: delegationTaskSha256V3(task),
    prompt_sha256: "d".repeat(64),
    created_at: createdAt
  });
  await mkdir(join(root, paths.runDir), { recursive: true });
  await writeFile(join(root, paths.manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
}
