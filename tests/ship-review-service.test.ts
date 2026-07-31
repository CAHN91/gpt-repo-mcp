import { describe, expect, test, vi } from "vitest";
import type { FailureDiagnoseResult } from "../src/contracts/failure-diagnose.contract.js";
import type { GitReviewResult } from "../src/contracts/git-review.contract.js";
import type { SemanticReviewResult } from "../src/contracts/semantic-review.contract.js";
import { ShipReviewResultSchema } from "../src/contracts/ship-review.contract.js";
import { ShipReviewService, type ShipReviewDependencies } from "../src/services/ship-review-service.js";

describe("ShipReviewService", () => {
  test("returns ready and exposes reviewed stage/commit payloads after full passing validation", async () => {
    const dependencies = fixtureDependencies();
    const input = { repo_id: "fixture", paths: ["src/app.ts"], max_files: 20 };
    const result = await new ShipReviewService(dependencies).review(input);

    expect(result.ship_readiness).toEqual({
      status: "ready",
      reasons: [],
      validation_status: "passed",
      blocking_finding_ids: [],
      diagnosis_included: false
    });
    expect(result.next_tool_payloads.repo_write_stage_commit?.paths).toEqual(["src/app.ts"]);
    expect(result.next_tool_payloads.repo_validate).toBeUndefined();
    expect(result.failure_diagnosis).toBeUndefined();
    expect(ShipReviewResultSchema.safeParse(result).success).toBe(true);
    expect(dependencies.gitReview.review).toHaveBeenCalledWith({
      repo_id: "fixture",
      mode: "commit_plan",
      detail: "compact",
      paths: ["src/app.ts"],
      max_files: 20
    });
    expect(dependencies.semanticReview.review).toHaveBeenCalledWith(input);
    expect(dependencies.failureDiagnose.diagnose).not.toHaveBeenCalled();
  });

  test("compact ship review removes duplicated gate and granular payloads while full retains them", async () => {
    const compact = await new ShipReviewService(fixtureDependencies()).review({ repo_id: "fixture" });
    const full = await new ShipReviewService(fixtureDependencies()).review({ repo_id: "fixture", detail: "full" });

    expect(compact.detail).toBe("compact");
    expect(compact.delegation_gate).toBeUndefined();
    expect(compact.review_loop).toBeUndefined();
    expect(compact.git_review.next_tool_payloads).toEqual({});
    expect(Object.keys(compact.next_tool_payloads)).toEqual(["repo_write_stage_commit"]);

    expect(full.detail).toBe("full");
    expect(full.delegation_gate).toBeDefined();
    expect(full.review_loop).toBeDefined();
    expect(full.git_review.next_tool_payloads.repo_write_stage_commit_actual).toBeDefined();
    expect(full.next_tool_payloads.repo_write_commit_dry_run).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThan(
      Buffer.byteLength(JSON.stringify(full), "utf8") * 0.75
    );
  });

  test("diagnoses failed validation and blocks ship with a validation payload", async () => {
    const dependencies = fixtureDependencies({ validation: "failed", semanticStatus: "review_required" });
    const result = await new ShipReviewService(dependencies).review({ repo_id: "fixture", paths: ["src/app.ts"] });

    expect(result.ship_readiness.status).toBe("review_required");
    expect(result.ship_readiness.reasons).toEqual(["SEMANTIC_REVIEW_REQUIRED", "VALIDATION_FAILED"]);
    expect(result.ship_readiness.diagnosis_included).toBe(true);
    expect(result.failure_diagnosis?.diagnostics).toHaveLength(0);
    expect(result.next_tool_payloads.repo_validate).toEqual({ repo_id: "fixture", profile: "all" });
    expect(result.next_tool_payloads.repo_write_stage_commit).toBeUndefined();
    expect(dependencies.failureDiagnose.diagnose).toHaveBeenCalledWith({
      repo_id: "fixture",
      scope_paths: ["src/app.ts"]
    });
  });

  test("treats focused validation as insufficient without running failure diagnosis", async () => {
    const dependencies = fixtureDependencies({ focused: true });
    const result = await new ShipReviewService(dependencies).review({ repo_id: "fixture" });

    expect(result.ship_readiness.reasons).toEqual(["VALIDATION_FOCUSED"]);
    expect(result.next_tool_payloads.repo_validate).toEqual({ repo_id: "fixture", profile: "all" });
    expect(dependencies.failureDiagnose.diagnose).not.toHaveBeenCalled();
  });

  test("requires review when no safe canonical ship payload is available", async () => {
    const dependencies = fixtureDependencies();
    const mixedStateReview = gitReview("passed", false);
    delete mixedStateReview.next_tool_payloads.repo_write_stage_commit;
    dependencies.gitReview.review = vi.fn().mockResolvedValue(mixedStateReview);

    const result = await new ShipReviewService(dependencies).review({ repo_id: "fixture" });

    expect(result.ship_readiness).toMatchObject({
      status: "review_required",
      reasons: ["GIT_CANONICAL_SHIP_PAYLOAD_UNAVAILABLE"]
    });
    expect(result.next_tool_payloads.repo_write_stage_commit).toBeUndefined();
    expect(result.next_tool_payloads.repo_write_commit).toBeUndefined();
  });

  test("blocks an explicit run identity that is not represented by the applicable gate set", async () => {
    const dependencies = fixtureDependencies();
    const result = await new ShipReviewService(dependencies).review({
      repo_id: "fixture",
      run_id: "2026-07-19T150000Z-missing-gate-run",
      paths: ["src/app.ts"]
    });

    expect(result.ship_readiness).toMatchObject({
      status: "review_required",
      reasons: ["DELEGATION_GATE_RUN_MISMATCH"]
    });
    expect(result.next_tool_payloads.repo_write_stage_commit).toBeUndefined();
  });
});

function fixtureDependencies(options: {
  validation?: "missing" | "passed" | "failed" | "stale";
  focused?: boolean;
  semanticStatus?: "ready" | "review_required";
} = {}): ShipReviewDependencies {
  return {
    gitReview: { review: vi.fn().mockResolvedValue(gitReview(options.validation ?? "passed", options.focused ?? false)) },
    semanticReview: { review: vi.fn().mockResolvedValue(semanticReview(options.semanticStatus ?? "ready")) },
    failureDiagnose: { diagnose: vi.fn().mockResolvedValue(failureDiagnosis()) }
  };
}

function gitReview(validation: "missing" | "passed" | "failed" | "stale", focused: boolean): GitReviewResult {
  return {
    ok: true,
    detail: "compact",
    branch: "feature",
    head_sha: "abc123",
    clean: false,
    changed_paths: [],
    diff_summary: { file_count: 1, truncated: false, files: [] },
    recommendation: {
      ready_to_stage: true,
      recommended_stage_paths: ["src/app.ts"],
      excluded_paths: [],
      suggested_commit_message: "Update app",
      risk_level: "low",
      warnings: []
    },
    ship_readiness: { validation: { status: validation, focused } },
    delegation_gate: {
      status: "not_applicable",
      requested_paths: ["src/app.ts"],
      applicable_runs: [],
      blocking_reasons: [],
      warnings: [],
      truncated: false
    },
    next_tool_payloads: {
      repo_write_stage_commit_actual: {
        repo_id: "fixture",
        paths: ["src/app.ts"],
        message: "Update app",
        expected_head_sha: "abc123",
        dry_run: false
      },
      repo_write_stage_commit: {
        repo_id: "fixture",
        paths: ["src/app.ts"],
        message: "Update app",
        expected_head_sha: "abc123",
        dry_run: false
      },
      repo_write_commit_dry_run: {
        repo_id: "fixture",
        message: "Update app",
        expected_head_sha: "abc123",
        expected_staged_paths: ["src/app.ts"],
        dry_run: true
      }
    }
  };
}

function semanticReview(status: "ready" | "review_required"): SemanticReviewResult {
  return {
    ok: true,
    repo_id: "fixture",
    reviewed_paths: ["src/app.ts"],
    findings: [],
    summary: { total: 0, high: 0, medium: 0, low: 0, blocking: 0 },
    ship_readiness: {
      status,
      blocking_finding_ids: status === "review_required" ? ["finding-1"] : [],
      validation_status: status === "review_required" ? "failed" : "passed"
    },
    next_tool_payloads: { repo_git_review: { repo_id: "fixture", paths: ["src/app.ts"] } },
    truncated: false,
    warnings: []
  };
}

function failureDiagnosis(): FailureDiagnoseResult {
  return {
    ok: true,
    repo_id: "fixture",
    validation: { found: true, status: "failed" },
    diagnostics: [],
    candidates: [],
    correlations: { changed_paths: ["src/app.ts"], touched_paths: [], symbol_paths: [] },
    next_tool_payloads: {},
    truncated: false,
    warnings: []
  };
}
