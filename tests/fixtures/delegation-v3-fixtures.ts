import type { DelegationTaskV3Input } from "../../src/contracts/delegation-v3.contract.js";
import type { ProductContextSelectionResult } from "../../src/contracts/product-contract.contract.js";
import { hashCanonical } from "../../src/services/product-contract-service.js";

export const DELEGATION_V3_FIXTURE_RUN_ID = "2026-07-19T000000Z-delegation-v3-golden";

function commonInput() {
  return {
    repo_id: "fixture",
    title: "Preserve coherent delegation",
    assignment: "Create the declared outcome while preserving repository contracts and implementation autonomy.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "Repeated technical iterations can lose the intended product or operational outcome.",
      desired_outcome: "The implementation remains complete, bounded, reviewable, and grounded in the declared outcome.",
      why_now: "Delegation v3 is replacing a closed-world prompt contract."
    },
    relevant_context: "The repository is local-first and all Git shipping remains a separate reviewed action.",
    starting_points: ["src/**", "tests/**"],
    authorization_scope: ["src/**", "tests/**", "docs/**"],
    forbidden_paths: ["config.local.json"],
    hard_constraints: ["Preserve path sandboxing and secret scanning."],
    must_preserve: ["Historical v1 and v2 artifacts remain reviewable."],
    explicit_exclusions: ["Do not add arbitrary shell execution."],
    technical_acceptance_criteria: ["Typecheck and focused tests pass."],
    validation: { profile: "all" as const, test_paths: [] },
    runner: { mode: "manual" as const },
    run_id: DELEGATION_V3_FIXTURE_RUN_ID
  };
}

export function productTaskInput(
  kind: "product_slice" | "product_correction" = "product_slice"
): DelegationTaskV3Input {
  return {
    ...commonInput(),
    task_kind: kind,
    product_alignment: {
      primary_user_id: "repo-operator",
      job_ids: ["delegate-coherent-work"],
      user_problem: "The operator otherwise has to supervise internal implementation details instead of reviewing the resulting outcome.",
      product_goal: "Keep product intent explicit while the implementation agent owns coherent connected work.",
      additional_must_not_become: ["A manual approval bureaucracy"],
      product_acceptance_criteria: [
        "The operator can identify the intended outcome before implementation detail.",
        "The task permits required connected work inside authorization."
      ]
    }
  };
}

export function technicalTaskInput(): DelegationTaskV3Input {
  return {
    ...commonInput(),
    task_kind: "technical_infrastructure",
    technical_context: {
      enabling_value: "Give ChatGPT and implementation agents one deterministic delegation contract without product-blind prompt expansion."
    }
  };
}

export function securityTaskInput(): DelegationTaskV3Input {
  return {
    ...commonInput(),
    title: "Harden manifest migration",
    assignment: "Harden the manifest migration boundary so incompatible versions fail closed without weakening historical review.",
    task_kind: "security_or_migration",
    security_context: {
      protected_contract: "Manifest identity, schema version, task hash, and prompt hash must remain bound before migration writes.",
      failure_risk: "An ambiguous compatibility path could accept tampered or incorrectly versioned task artifacts."
    },
    hard_constraints: [
      "Preserve exact `schema_version`, `prompt_sha256`, and `task_sha256` field names.",
      "Call `parseDelegationManifestV3()` before any migration write.",
      "Keep src/services/codex-run-manifest.ts backward compatible for historical v1/v2 review."
    ],
    technical_acceptance_criteria: [
      "Unknown schema versions fail before any write.",
      "Historical v1/v2 review remains available."
    ]
  };
}

export function overspecifiedProductTaskInput(): DelegationTaskV3Input {
  return {
    ...productTaskInput("product_correction"),
    title: "Overspecified correction fixture",
    assignment: [
      "Implement only exactly the following internal solution and change no other files.",
      "Do not inspect beyond src/services/delegation-v3-task-service.ts, src/services/delegation-v3-renderer.ts, tests/delegation-v3-task-service.test.ts, and docs/ROADMAP.md.",
      "1. In the file src/services/delegation-v3-task-service.ts add the class named `PromptGate`.",
      "2. Create the method named `validatePrompt()`.",
      "3. Replace the function named `resolveTask()`.",
      "4. Call the hook named `usePromptGate()`.",
      "5. Change line 42 in src/services/delegation-v3-renderer.ts.",
      "6. Add the component named `PromptWarning` in tests/delegation-v3-task-service.test.ts.",
      "```ts",
      "export function createPromptGate() { return true; }",
      "```"
    ].join("\n"),
    relevant_context: "Exactly these files define the complete implementation plan: src/services/delegation-v3-task-service.ts, src/services/delegation-v3-renderer.ts, tests/delegation-v3-task-service.test.ts, docs/ROADMAP.md.",
    starting_points: Array.from({ length: 13 }, (_, index) => `src/area-${index + 1}/**`),
    technical_acceptance_criteria: Array.from({ length: 21 }, (_, index) => `Implementation detail ${index + 1} is present exactly as prescribed.`)
  };
}

export function productSelection(): ProductContextSelectionResult {
  const snapshot: ProductContextSelectionResult["snapshot"] = {
    schema_version: 1,
    product: {
      name: "GPT Repo MCP",
      purpose: "Keep local repository work safe, coherent, and product-aware."
    },
    primary_user: {
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical but time-constrained",
      work_context: "Coordinates ChatGPT and implementation agents across trusted repositories."
    },
    jobs_to_be_done: [{
      id: "delegate-coherent-work",
      statement: "Delegate complete implementation without brittle prompt micromanagement."
    }],
    must_reduce: ["Prompt micromanagement", "Repeated context reconstruction"],
    must_not_become: ["A file-by-file prompt factory", "A new approval bureaucracy"],
    experience_principles: ["Outcome before implementation detail", "Repository truth before agent claims"],
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
