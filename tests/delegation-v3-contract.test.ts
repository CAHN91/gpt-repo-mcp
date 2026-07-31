import { describe, expect, test } from "vitest";
import {
  DelegationPreparedResultV3Schema,
  DelegationResultV3Schema,
  DelegationRunManifestV3Schema,
  DelegationTaskV3InputSchema,
  DelegationTaskV3Schema,
  DelegationWriteResultV3Schema,
  type DelegationTaskV3Input
} from "../src/contracts/delegation-v3.contract.js";
import type { ProductContextSelectionResult } from "../src/contracts/product-contract.contract.js";
import {
  buildDelegationProductBindingV3,
  delegationBaselineSha256V3,
  delegationManifestSha256V3,
  delegationTaskSha256V3,
  normalizeDelegationTaskV3,
  parseDelegationManifestV3,
  parseDelegationResultV3,
  parseDelegationResultV3WithWarnings,
  reviewRequirementForDelegationTaskV3
} from "../src/services/delegation-v3-normalizer.js";
import { hashCanonical } from "../src/services/product-contract-service.js";

const RUN_ID = "2026-07-18T220000Z-v3-contract";

function commonInput() {
  return {
    repo_id: "fixture",
    title: "Restore coherent delegation",
    assignment: "Implement the declared outcome without turning the task into a file-by-file script.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "Delegation loses product intent during repeated technical iterations.",
      desired_outcome: "Product intent remains bound while the implementation agent owns coherent connected work.",
      why_now: "The old task contract is being replaced before more repositories adopt it."
    },
    starting_points: ["src/**", "tests/**"],
    authorization_scope: ["src/**", "tests/**", "docs/**"],
    forbidden_paths: ["config.local.json"],
    hard_constraints: ["Preserve repository sandboxing."],
    must_preserve: ["Historical v1 and v2 artifacts remain readable."],
    explicit_exclusions: ["Do not add arbitrary shell execution."],
    technical_acceptance_criteria: [
      "Typecheck and tests pass.",
      { id: "TAC-7", criterion: "Unknown fields remain rejected." }
    ],
    validation: { profile: "all" as const, test_paths: [] },
    runner: { mode: "manual" as const },
    run_id: RUN_ID
  };
}

function productInput(kind: "product_slice" | "product_correction" = "product_slice"): DelegationTaskV3Input {
  return {
    ...commonInput(),
    task_kind: kind,
    product_alignment: {
      primary_user_id: "repo-operator",
      job_ids: ["delegate-coherent-work"],
      user_problem: "The operator receives technically correct work that has drifted from the product.",
      product_goal: "Keep repository work product-aware without reducing implementation autonomy.",
      additional_must_not_become: ["A manual approval bureaucracy"],
      product_acceptance_criteria: [
        "The product user and intended outcome remain explicit.",
        { id: "PAC-4", criterion: "The task does not prescribe an exhaustive internal solution." }
      ]
    }
  };
}

function productAlignment() {
  const input = productInput();
  if (!("product_alignment" in input)) throw new Error("Expected product task fixture.");
  return input.product_alignment;
}

function technicalInput(): DelegationTaskV3Input {
  return {
    ...commonInput(),
    task_kind: "technical_infrastructure",
    technical_context: {
      enabling_value: "Give all planning and delegation services one safe source of product context."
    }
  };
}

function securityInput(): DelegationTaskV3Input {
  return {
    ...commonInput(),
    task_kind: "security_or_migration",
    security_context: {
      protected_contract: "Prompt and manifest identity remain cryptographically bound.",
      failure_risk: "A compatibility fallback could permit unreviewed or incorrectly scoped work."
    }
  };
}

function productSelection(): ProductContextSelectionResult {
  const snapshot: ProductContextSelectionResult["snapshot"] = {
    schema_version: 1,
    product: {
      name: "GPT Repo MCP",
      purpose: "Keep local repository work safe, coherent, and product-aware."
    },
    primary_user: {
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical",
      work_context: "Coordinates ChatGPT and implementation agents across trusted repositories."
    },
    jobs_to_be_done: [{
      id: "delegate-coherent-work",
      statement: "Delegate coherent implementation without brittle prompt micromanagement."
    }],
    must_reduce: ["Prompt micromanagement"],
    must_not_become: ["A prompt factory that forgets the product"],
    experience_principles: ["Outcome before implementation detail"],
    canonical_docs: ["docs/ROADMAP.md"],
    governance: {
      mode: "advisory",
      product_review_required_for: ["product_slice", "product_correction"],
      checkpoint_every_root_runs: 5
    }
  };
  return {
    source_path: "docs/product-contract.json",
    contract_sha256: "a".repeat(64),
    snapshot_sha256: hashCanonical(snapshot),
    snapshot
  };
}

function audit() {
  return {
    verdict: "passed" as const,
    mode: "advisory" as const,
    product_grounding: "complete" as const,
    closed_world_risk: "low" as const,
    overspecification_risk: "low" as const,
    signals: [],
    warnings: []
  };
}

function productManifest() {
  const task = normalizeDelegationTaskV3(productInput());
  const binding = buildDelegationProductBindingV3(task, productSelection());
  const baseline = {
    head_sha: "0".repeat(40),
    worktree_fingerprint: "clean",
    initial_changed_paths: []
  };
  return {
    schema_version: 3 as const,
    repo_id: task.repo_id,
    run_id: task.run_id!,
    title: task.title,
    task_kind: task.task_kind,
    task,
    prompt_path: `.chatgpt/codex-runs/${RUN_ID}/PROMPT.md`,
    result_json_path: `.chatgpt/codex-runs/${RUN_ID}/RESULT.json`,
    manifest_path: `.chatgpt/codex-runs/${RUN_ID}/run.json`,
    product_binding: binding,
    review_requirement: "product_required" as const,
    delegation_audit: audit(),
    authorization: {
      starting_points: task.starting_points,
      caller_scope: task.authorization_scope,
      effective_scope: task.authorization_scope,
      caller_forbidden_paths: task.forbidden_paths,
      effective_forbidden_paths: [".git/**", ".chatgpt/**", ...task.forbidden_paths]
    },
    baseline,
    baseline_sha256: delegationBaselineSha256V3(baseline),
    task_sha256: delegationTaskSha256V3(task),
    prompt_sha256: "d".repeat(64),
    prompt_byte_count: 123,
    created_at: "2026-07-18T22:00:00.000Z"
  };
}

describe("Delegation v3 contracts", () => {
  test("normalizes every task kind with an explicit outcome frame", () => {
    for (const input of [productInput("product_slice"), productInput("product_correction"), technicalInput(), securityInput()]) {
      const task = normalizeDelegationTaskV3(input);
      expect(task.outcome.beneficiary).toBe("Repository operator");
      expect(task.authorization_scope).toEqual(["src/**", "tests/**", "docs/**"]);
      expect(task.technical_acceptance_criteria.map(({ id }) => id)).toEqual(["TAC-1", "TAC-7"]);
      expect(task).not.toHaveProperty("objective");
      expect(task).not.toHaveProperty("context_summary");
      expect(task).not.toHaveProperty("inspect_first");
      expect(task).not.toHaveProperty("allowed_paths");
      expect(task).not.toHaveProperty("implementation_scope");
      expect(task).not.toHaveProperty("verification_commands");
    }
  });

  test("requires kind-specific product, technical, and security context", () => {
    expect(DelegationTaskV3InputSchema.safeParse({ ...commonInput(), task_kind: "product_slice" }).success).toBe(false);
    expect(DelegationTaskV3InputSchema.safeParse({
      ...commonInput(),
      task_kind: "technical_infrastructure",
      product_alignment: productAlignment()
    }).success).toBe(false);
    expect(DelegationTaskV3InputSchema.safeParse({ ...commonInput(), task_kind: "security_or_migration" }).success).toBe(false);
  });

  test("rejects removed v2 catch-all and implementation-plan fields", () => {
    const value = {
      ...productInput(),
      objective: "Legacy objective",
      context_summary: "Legacy context",
      inspect_first: ["src/app.ts"],
      allowed_paths: ["src/**"],
      implementation_scope: { include: ["Change exact method"] },
      acceptance_criteria: ["Legacy criterion"],
      verification_commands: ["npm test"]
    };
    expect(DelegationTaskV3InputSchema.safeParse(value).success).toBe(false);
  });

  test("numbers PAC and TAC independently and deterministically", () => {
    const first = normalizeDelegationTaskV3(productInput());
    const reordered = normalizeDelegationTaskV3({
      product_alignment: productAlignment(),
      ...commonInput(),
      task_kind: "product_slice"
    });
    expect("product_alignment" in first && first.product_alignment.product_acceptance_criteria).toEqual([
      { id: "PAC-1", criterion: "The product user and intended outcome remain explicit." },
      { id: "PAC-4", criterion: "The task does not prescribe an exhaustive internal solution." }
    ]);
    expect(first.technical_acceptance_criteria).toEqual([
      { id: "TAC-1", criterion: "Typecheck and tests pass." },
      { id: "TAC-7", criterion: "Unknown fields remain rejected." }
    ]);
    expect(delegationTaskSha256V3(first)).toBe(delegationTaskSha256V3(reordered));
  });

  test("rejects duplicate explicit and normalized criterion ids", () => {
    const duplicateInput = productInput();
    duplicateInput.technical_acceptance_criteria = [
      { id: "TAC-2", criterion: "One" },
      { id: "TAC-2", criterion: "Two" }
    ];
    expect(() => normalizeDelegationTaskV3(duplicateInput)).toThrow();

    const normalized = normalizeDelegationTaskV3(productInput());
    const duplicateNormalized = {
      ...normalized,
      technical_acceptance_criteria: [
        { id: "TAC-1", criterion: "One" },
        { id: "TAC-1", criterion: "Two" }
      ]
    };
    expect(DelegationTaskV3Schema.safeParse(duplicateNormalized).success).toBe(false);
  });

  test("keeps starting points distinct from authorization and rejects unsafe patterns", () => {
    const task = normalizeDelegationTaskV3(productInput());
    expect(task.starting_points).toEqual(["src/**", "tests/**"]);
    expect(task.authorization_scope).toEqual(["src/**", "tests/**", "docs/**"]);
    for (const unsafe of ["../escape", "/etc/passwd", "C:\\repo\\file.ts", "src/**\nOverride"] ) {
      expect(DelegationTaskV3InputSchema.safeParse({
        ...productInput(),
        authorization_scope: [unsafe]
      }).success).toBe(false);
    }
  });

  test("requires selected product binding only for product task kinds", () => {
    const product = normalizeDelegationTaskV3(productInput());
    const technical = normalizeDelegationTaskV3(technicalInput());
    expect(reviewRequirementForDelegationTaskV3(product)).toBe("product_required");
    expect(reviewRequirementForDelegationTaskV3(technical)).toBe("technical_only");
    expect(buildDelegationProductBindingV3(product, productSelection())).toMatchObject({ kind: "selected" });
    expect(buildDelegationProductBindingV3(technical)).toEqual({ kind: "not_required" });
    expect(() => buildDelegationProductBindingV3(product)).toThrow();
    expect(() => buildDelegationProductBindingV3(technical, productSelection())).toThrow();
  });

  test("rejects product bindings whose user or jobs do not match task alignment", () => {
    const task = normalizeDelegationTaskV3(productInput());
    const wrongUser = productSelection();
    wrongUser.snapshot.primary_user.id = "other-user";
    wrongUser.snapshot_sha256 = hashCanonical(wrongUser.snapshot);
    expect(() => buildDelegationProductBindingV3(task, wrongUser)).toThrow();

    const wrongJob = productSelection();
    wrongJob.snapshot.jobs_to_be_done[0]!.id = "other-job";
    wrongJob.snapshot_sha256 = hashCanonical(wrongJob.snapshot);
    expect(() => buildDelegationProductBindingV3(task, wrongJob)).toThrow();
  });

  test("parses a strict product manifest with bound task and product snapshot", () => {
    const manifest = parseDelegationManifestV3(productManifest());
    expect(manifest.schema_version).toBe(3);
    expect(manifest.review_requirement).toBe("product_required");
    expect(manifest.product_binding.kind).toBe("selected");
    expect(manifest.task_sha256).toBe(delegationTaskSha256V3(manifest.task));
    expect(manifest).not.toHaveProperty("result_path");
    expect(delegationManifestSha256V3(manifest)).toMatch(/^[a-f0-9]{64}$/);
    expect(DelegationRunManifestV3Schema.safeParse({ ...manifest, extra: true }).success).toBe(false);
  });

  test("rejects stale normalized task, baseline, and product snapshot hashes", () => {
    expect(() => parseDelegationManifestV3({
      ...productManifest(),
      task_sha256: "e".repeat(64)
    })).toThrow();

    const baselineTamper = productManifest();
    baselineTamper.baseline.worktree_fingerprint = "changed";
    expect(() => parseDelegationManifestV3(baselineTamper)).toThrow();

    const snapshotTamper = productManifest();
    if (snapshotTamper.product_binding.kind !== "selected") throw new Error("Expected selected product binding.");
    snapshotTamper.product_binding.snapshot.product.purpose = "Tampered after snapshot hashing.";
    expect(() => parseDelegationManifestV3(snapshotTamper)).toThrow();
  });

  test("requires technical-only review and no product binding for technical manifests", () => {
    const task = normalizeDelegationTaskV3(technicalInput());
    const base = productManifest();
    const valid = {
      ...base,
      task_kind: task.task_kind,
      task,
      product_binding: { kind: "not_required" as const },
      review_requirement: "technical_only" as const,
      delegation_audit: { ...audit(), product_grounding: "not_required" as const },
      authorization: {
        ...base.authorization,
        starting_points: task.starting_points,
        caller_scope: task.authorization_scope,
        effective_scope: task.authorization_scope,
        caller_forbidden_paths: task.forbidden_paths
      },
      task_sha256: delegationTaskSha256V3(task)
    };
    expect(DelegationRunManifestV3Schema.safeParse(valid).success).toBe(true);
    expect(DelegationRunManifestV3Schema.safeParse({ ...valid, review_requirement: "product_required" }).success).toBe(false);
    expect(DelegationRunManifestV3Schema.safeParse({ ...valid, product_binding: buildDelegationProductBindingV3(normalizeDelegationTaskV3(productInput()), productSelection()) }).success).toBe(false);
  });

  test("parses completed result v3 with separate product and technical evidence", () => {
    const result = parseDelegationResultV3(JSON.stringify({
      schema_version: 3,
      repo_id: "fixture",
      run_id: RUN_ID,
      status: "completed",
      summary: "Implemented the coherent task contract.",
      changed_files: ["src/app.ts", "tests/app.test.ts"],
      connected_changes: [{
        paths: ["src/app.ts", "tests/app.test.ts"],
        category: "tests",
        reason: "The implementation and its focused test are one connected verified change."
      }],
      commands_run: ["npm test"],
      tests: ["passed"],
      product_acceptance_criteria: [{ id: "PAC-1", status: "passed", evidence: "Product goal remains explicit." }],
      technical_acceptance_criteria: [{ id: "TAC-1", status: "passed", evidence: "Tests passed." }],
      scope_extension_required: [],
      blockers: [],
      followups: []
    }), "fixture", RUN_ID);
    expect(result.product_acceptance_criteria[0]?.id).toBe("PAC-1");
    expect(result.technical_acceptance_criteria[0]?.id).toBe("TAC-1");
  });

  test("normalizes only the exact verified status synonym to canonical passed", () => {
    const value = {
      schema_version: 3,
      repo_id: "fixture",
      run_id: RUN_ID,
      status: "completed",
      summary: "Completed the requested outcome.",
      changed_files: ["src/app.ts"],
      connected_changes: [{ path: "src/app.ts", reason: "Required for the requested behavior." }],
      commands_run: ["npm test"],
      tests: ["passed"],
      product_acceptance_criteria: [{ id: "PAC-1", status: "verified", evidence: "Product behavior was confirmed." }],
      technical_acceptance_criteria: [{ id: "TAC-1", status: "verified", evidence: "Relevant checks passed." }],
      scope_extension_required: [],
      blockers: [],
      followups: []
    };
    const parsed = parseDelegationResultV3WithWarnings(JSON.stringify(value), "fixture", RUN_ID);
    expect(parsed.result.product_acceptance_criteria[0]?.status).toBe("passed");
    expect(parsed.result.technical_acceptance_criteria[0]?.status).toBe("passed");
    expect(parsed.warnings).toEqual(["DELEGATION_V3_STATUS_VERIFIED_NORMALIZED"]);
    expect(() => parseDelegationResultV3(JSON.stringify({
      ...value,
      product_acceptance_criteria: [{ id: "PAC-1", status: "complete", evidence: "Unknown status." }]
    }), "fixture", RUN_ID)).toThrow();
  });

  test("represents blocked work through structured scope extension", () => {
    const result = DelegationResultV3Schema.parse({
      schema_version: 3,
      repo_id: "fixture",
      run_id: RUN_ID,
      status: "blocked",
      summary: "Authorization excludes a required connected surface.",
      changed_files: [],
      connected_changes: [],
      commands_run: [],
      tests: [],
      product_acceptance_criteria: [],
      technical_acceptance_criteria: [],
      scope_extension_required: [{
        path_or_area: "apps/web/**",
        reason: "The user-facing outcome cannot be completed in the current authorization scope.",
        required_outcome: "Expose the recommended action in the existing user workflow."
      }],
      blockers: [],
      followups: []
    });
    expect(result.scope_extension_required).toHaveLength(1);
  });

  test("rejects inconsistent completed, blocked, duplicate, and connected-change results", () => {
    const base = {
      schema_version: 3,
      repo_id: "fixture",
      run_id: RUN_ID,
      summary: "Result",
      changed_files: ["src/app.ts"],
      connected_changes: [],
      commands_run: [],
      tests: [],
      product_acceptance_criteria: [],
      technical_acceptance_criteria: [],
      scope_extension_required: [],
      blockers: [],
      followups: []
    };
    expect(DelegationResultV3Schema.safeParse({ ...base, status: "completed", blockers: ["Still blocked"] }).success).toBe(false);
    expect(DelegationResultV3Schema.safeParse({ ...base, status: "blocked" }).success).toBe(false);
    expect(DelegationResultV3Schema.safeParse({ ...base, status: "completed", changed_files: ["src/app.ts", "src/app.ts"] }).success).toBe(false);
    expect(DelegationResultV3Schema.safeParse({
      ...base,
      status: "completed",
      connected_changes: [{ path: "tests/app.test.ts", reason: "Missing from changed files." }]
    }).success).toBe(false);
  });

  test("result parser rejects invalid JSON, identity mismatch, and unknown fields", () => {
    expect(() => parseDelegationResultV3("{invalid", "fixture", RUN_ID)).toThrow();
    const value = {
      schema_version: 3,
      repo_id: "other",
      run_id: RUN_ID,
      status: "completed",
      summary: "Done",
      changed_files: [],
      connected_changes: [],
      commands_run: [],
      tests: [],
      product_acceptance_criteria: [],
      technical_acceptance_criteria: [],
      scope_extension_required: [],
      blockers: [],
      followups: []
    };
    expect(() => parseDelegationResultV3(JSON.stringify(value), "fixture", RUN_ID)).toThrow();
    expect(DelegationResultV3Schema.safeParse({ ...value, repo_id: "fixture", extra: true }).success).toBe(false);
  });

  test("defines strict future prepare and write output contracts without exposing prompt prose", () => {
    const prepared = {
      ok: true,
      schema_version: 3,
      repo_id: "fixture",
      run_id: RUN_ID,
      task_kind: "product_slice",
      prompt_path: `.chatgpt/codex-runs/${RUN_ID}/PROMPT.md`,
      result_json_path: `.chatgpt/codex-runs/${RUN_ID}/RESULT.json`,
      manifest_path: `.chatgpt/codex-runs/${RUN_ID}/run.json`,
      review_gate_path: `.chatgpt/codex-runs/${RUN_ID}/review-gate.json`,
      review_requirement: "product_required",
      product_contract_sha256: "a".repeat(64),
      delegation_audit: audit(),
      warnings: []
    };
    expect(DelegationPreparedResultV3Schema.safeParse(prepared).success).toBe(true);
    expect(prepared).not.toHaveProperty("result_path");
    expect(DelegationWriteResultV3Schema.safeParse({
      ...prepared,
      dry_run: false,
      written_paths: [prepared.prompt_path, prepared.manifest_path],
      next_tool_payloads: { repo_agent_runs: { repo_id: "fixture", run_id: RUN_ID } }
    }).success).toBe(true);
    expect(DelegationRunManifestV3Schema.safeParse({
      ...productManifest(),
      result_path: `.chatgpt/codex-runs/${RUN_ID}/RESULT.md`
    }).success).toBe(false);
    expect(DelegationPreparedResultV3Schema.safeParse({
      ...prepared,
      product_contract_sha256: undefined
    }).success).toBe(false);
    expect(DelegationPreparedResultV3Schema.safeParse({
      ...prepared,
      review_requirement: "technical_only"
    }).success).toBe(false);

    const technicalPrepared = {
      ...prepared,
      task_kind: "technical_infrastructure",
      review_requirement: "technical_only",
      product_contract_sha256: undefined,
      delegation_audit: { ...audit(), product_grounding: "not_required" }
    };
    expect(DelegationPreparedResultV3Schema.safeParse(technicalPrepared).success).toBe(true);
    expect(DelegationPreparedResultV3Schema.safeParse({
      ...technicalPrepared,
      product_contract_sha256: "a".repeat(64)
    }).success).toBe(false);
    expect(DelegationPreparedResultV3Schema.safeParse({ ...prepared, prompt_markdown: "not part of compact metadata" }).success).toBe(false);
    expect(DelegationPreparedResultV3Schema.safeParse({
      ...prepared,
      result_path: `.chatgpt/codex-runs/${RUN_ID}/RESULT.md`
    }).success).toBe(false);
  });
});
