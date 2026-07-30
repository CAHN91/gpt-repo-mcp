import { describe, expect, test } from "vitest";
import { DelegationLineageV3Schema } from "../src/contracts/delegation-v3.contract.js";
import { auditDelegationTaskV3 } from "../src/services/delegation-v3-audit.js";
import {
  buildDelegationProductBindingV3,
  normalizeDelegationTaskV3,
  normalizeDelegationTaskV3WithLineage
} from "../src/services/delegation-v3-normalizer.js";
import { renderDelegationPromptV3 } from "../src/services/delegation-v3-renderer.js";
import { effectiveForbiddenPatterns } from "../src/services/codex-task-policy.js";
import {
  overspecifiedProductTaskInput,
  productSelection,
  productTaskInput,
  securityTaskInput,
  technicalTaskInput
} from "./fixtures/delegation-v3-fixtures.js";

const RESULT_JSON_PATH = ".chatgpt/codex-runs/2026-07-19T000000Z-delegation-v3-golden/RESULT.json";

describe("Delegation v3 golden prompt matrix", () => {
  test.each([
    {
      name: "product slice",
      input: productTaskInput("product_slice"),
      expectedHeadings: productHeadings(false),
      expectedFrame: ["- Product: GPT Repo MCP", "- Primary user: Repository operator", "- Product goal: Keep product intent explicit while the implementation agent owns coherent connected work."],
      expectedAuditWarnings: []
    },
    {
      name: "product correction",
      input: productTaskInput("product_correction"),
      expectedHeadings: productHeadings(false),
      expectedFrame: ["Task kind: product_correction", "- The product must not become:", "  - A manual approval bureaucracy"],
      expectedAuditWarnings: []
    },
    {
      name: "technical infrastructure",
      input: technicalTaskInput(),
      expectedHeadings: technicalHeadings(false),
      expectedFrame: ["Task kind: technical_infrastructure", "- Enabling value: Give ChatGPT and implementation agents one deterministic delegation contract without product-blind prompt expansion."],
      expectedAuditWarnings: []
    },
    {
      name: "security or migration",
      input: securityTaskInput(),
      expectedHeadings: technicalHeadings(true),
      expectedFrame: ["Task kind: security_or_migration", "- Protected contract: Manifest identity, schema version, task hash, and prompt hash must remain bound before migration writes.", "- Failure risk: An ambiguous compatibility path could accept tampered or incorrectly versioned task artifacts."],
      expectedAuditWarnings: []
    },
    {
      name: "overspecified product correction",
      input: overspecifiedProductTaskInput(),
      expectedHeadings: productHeadings(true),
      expectedFrame: ["Task kind: product_correction", "## Delegation Audit", "- mode: advisory", "- product_grounding: complete", "- closed_world_risk: high", "- overspecification_risk: high"],
      expectedAuditWarnings: ["DELEGATION_CLOSED_WORLD_RISK", "DELEGATION_OVERSPECIFICATION_RISK"]
    }
  ])("renders the $name golden contract", ({ input, expectedHeadings, expectedFrame, expectedAuditWarnings }) => {
    const { prompt, audit } = renderCase(input);

    expect(headings(prompt)).toEqual(expectedHeadings);
    for (const text of expectedFrame) expect(prompt).toContain(text);
    expect(audit.warnings).toEqual(expectedAuditWarnings);
    if (prompt.includes("## Delegation Audit")) {
      expect(prompt).toContain(`- mode: ${audit.mode}`);
      expect(prompt).toContain(`- product_grounding: ${audit.product_grounding}`);
    }
    expect(prompt.indexOf("## Product or Operational Frame")).toBeLessThan(prompt.indexOf("## Assignment"));
    expect(prompt.indexOf("## Starting Points")).toBeLessThan(prompt.indexOf("## Authorization Boundary"));
    expect(prompt.indexOf("## Authorization Boundary")).toBeLessThan(prompt.indexOf("## Implementation Responsibility"));
    expect(prompt).toContain("They are not an exhaustive read or implementation list.");
    expect(prompt).toContain("They do not predict which files must change.");
    expect(prompt).toContain("Complete logically connected work inside the authorization boundary");
    expect(prompt).toContain(`write strict JSON to \`${RESULT_JSON_PATH}\``);
    expect(prompt).toContain("RESULT.json is the only result artifact for this task.");
    expect(prompt).toContain("use only `passed`, `failed`, or `unverified`. Never write `verified`.");
    expect(prompt).toContain("use `passed` for every criterion with concrete evidence");
    expect(prompt).toContain("provide a separate user-facing completion response");
    expect(prompt).toContain("Follow the active AGENTS.md communication and language rules.");
    expect(prompt).toContain("Do not copy the technical RESULT.json evidence into the chat response.");
    expect(prompt).not.toContain("Then print the same concise outcome summary in the agent chat.");
    expect(prompt).not.toContain("RESULT.md");
    expect(prompt).not.toContain("## Inspect First");
    expect(prompt).not.toContain("## Allowed Paths");
    expect(prompt).not.toContain("## Implementation Scope");
  });

  test("renders the evidence-bound scope-amendment lineage golden contract", () => {
    const parentRunId = "2026-07-19T001000Z-lineage-parent";
    const rootRunId = "2026-07-19T000000Z-lineage-root";
    const input = {
      ...productTaskInput("product_correction"),
      run_id: "2026-07-19T002000Z-lineage-child",
      authorization_scope: ["src/**", "tests/**", "docs/**", "tools/**"],
      lineage: {
        kind: "scope_amendment" as const,
        parent_run_id: parentRunId,
        reason: "Add the exact area required by parent RESULT.json evidence.",
        authorization_additions: ["tools/**"]
      }
    };
    const lineage = DelegationLineageV3Schema.parse({
      kind: "scope_amendment",
      parent_run_id: parentRunId,
      root_run_id: rootRunId,
      child_index: 1,
      max_children: 2,
      reason: input.lineage.reason,
      parent_manifest_sha256: "b".repeat(64),
      root_manifest_sha256: "a".repeat(64),
      authorization_additions: ["tools/**"],
      evidence: {
        source: "parent_result",
        parent_result_sha256: "c".repeat(64),
        scope_extension_required: [{
          path_or_area: "tools/**",
          reason: "The inherited implementation requires a bounded tool adapter update.",
          required_outcome: "Complete the inherited outcome without unrelated authorization expansion."
        }]
      }
    });
    const task = normalizeDelegationTaskV3WithLineage(input, lineage);
    const binding = buildDelegationProductBindingV3(task, productSelection());
    const audit = auditDelegationTaskV3(task, binding, "advisory");
    const prompt = renderDelegationPromptV3({
      task,
      runId: task.run_id!,
      paths: { resultJsonPath: RESULT_JSON_PATH },
      productBinding: binding,
      effectiveForbiddenPaths: effectiveForbiddenPatterns(task.forbidden_paths),
      audit
    });
    const expectedHeadings = productHeadings(false);
    expectedHeadings.splice(1, 0, "## Lineage");

    expect(headings(prompt)).toEqual(expectedHeadings);
    expect(prompt).toContain("- kind: scope_amendment");
    expect(prompt).toContain(`- parent_run_id: ${parentRunId}`);
    expect(prompt).toContain(`- root_run_id: ${rootRunId}`);
    expect(prompt).toContain("- child_index: 1/2");
    expect(prompt).toContain("- approved authorization additions:\n  - tools/**");
    expect(prompt).toContain("- evidence source: parent RESULT.json");
    expect(prompt).toContain("Use only the listed evidence-bound additions beyond the parent authorization boundary.");
    expect(prompt.indexOf("## Product or Operational Frame")).toBeLessThan(prompt.indexOf("## Lineage"));
    expect(prompt.indexOf("## Lineage")).toBeLessThan(prompt.indexOf("## Assignment"));
  });

  test("does not render a golden prompt for enforce-mode missing product grounding", () => {
    const task = normalizeDelegationTaskV3(productTaskInput());
    const audit = auditDelegationTaskV3(task, { kind: "not_required" }, "enforce");
    const prompt = audit.verdict === "blocked" ? null : renderDelegationPromptV3({
      task,
      runId: task.run_id!,
      paths: { resultJsonPath: RESULT_JSON_PATH },
      productBinding: { kind: "not_required" },
      effectiveForbiddenPaths: effectiveForbiddenPatterns(task.forbidden_paths),
      audit
    });

    expect({ audit, prompt }).toEqual({
      audit: {
        verdict: "blocked",
        mode: "enforce",
        product_grounding: "missing",
        closed_world_risk: "low",
        overspecification_risk: "low",
        signals: [],
        warnings: ["DELEGATION_PRODUCT_GROUNDING_MISSING"]
      },
      prompt: null
    });
  });
});

function renderCase(input: ReturnType<typeof productTaskInput> | ReturnType<typeof technicalTaskInput> | ReturnType<typeof securityTaskInput>) {
  const task = normalizeDelegationTaskV3(input);
  const binding = "product_alignment" in task
    ? buildDelegationProductBindingV3(task, productSelection())
    : buildDelegationProductBindingV3(task);
  const audit = auditDelegationTaskV3(task, binding, "advisory");
  const prompt = renderDelegationPromptV3({
    task,
    runId: task.run_id!,
    paths: { resultJsonPath: RESULT_JSON_PATH },
    productBinding: binding,
    effectiveForbiddenPaths: effectiveForbiddenPatterns(task.forbidden_paths),
    audit
  });
  return { audit, prompt };
}

function headings(prompt: string): string[] {
  return prompt.split("\n").filter((line) => line.startsWith("## "));
}

function productHeadings(withAudit: boolean): string[] {
  return [
    "## Product or Operational Frame",
    "## Assignment",
    "## Relevant Context",
    "## Hard Constraints",
    "## Must Preserve",
    "## Starting Points",
    "## Authorization Boundary",
    "## Forbidden Paths",
    "## Explicit Exclusions",
    "## Implementation Responsibility",
    "## Product Acceptance Criteria",
    "## Technical Acceptance Criteria",
    "## Structured Validation",
    "## Runner Handoff",
    ...(withAudit ? ["## Delegation Audit"] : []),
    "## Completion Contract"
  ];
}

function technicalHeadings(withAudit: boolean): string[] {
  return productHeadings(withAudit).filter((heading) => heading !== "## Product Acceptance Criteria");
}
