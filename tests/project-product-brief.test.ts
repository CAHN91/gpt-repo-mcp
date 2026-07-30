import { describe, expect, test } from "vitest";
import { ProjectProductBriefSchema } from "../src/contracts/project-product-brief.contract.js";
import type { ProductContractLoadResult } from "../src/contracts/product-contract.contract.js";
import { projectProductBrief } from "../src/services/project-product-brief.js";

const configured: ProductContractLoadResult = {
  status: "configured",
  source_path: "docs/product-contract.json",
  size_bytes: 100,
  contract_sha256: "a".repeat(64),
  contract: {
    schema_version: 1,
    product: { name: "Demo", purpose: "Help an operator make the next decision." },
    primary_users: [{
      id: "operator",
      role: "Operator",
      technical_level: "Non-technical",
      work_context: "Works under time pressure."
    }],
    jobs_to_be_done: [{ id: "resolve-work", statement: "Resolve the current work item." }],
    must_reduce: ["Manual comparison"],
    must_not_become: ["A technical workspace"],
    experience_principles: ["Decision before internals"],
    canonical_docs: ["README.md"],
    governance: {
      mode: "advisory",
      product_review_required_for: ["product_slice"],
      checkpoint_every_root_runs: 5
    }
  },
  canonical_documents: [{ path: "README.md", size_bytes: 50 }],
  warnings: []
};

describe("projectProductBrief", () => {
  test("projects configured repository product truth into a planning-ready contract", () => {
    const result = projectProductBrief(configured);

    expect(ProjectProductBriefSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: "configured",
      authority: "repository_product_contract",
      product: { name: "Demo" },
      governance: { mode: "advisory" },
      delegation_checkpoint: {
        status: "no_history",
        governance_mode: "advisory",
        threshold_root_runs: 5,
        root_runs_since_last_product_checkpoint: 0
      },
      product_boundaries: { must_reduce: ["Manual comparison"] },
      canonical_evidence: [{ path: "README.md", size_bytes: 50, role: "canonical_reference" }],
      planning_readiness: "product_grounded",
      setup_guidance: []
    });
  });

  test("returns create guidance without invented product fields when the contract is missing", () => {
    const result = projectProductBrief({
      status: "missing",
      source_path: "docs/product-contract.json",
      diagnostic: {
        code: "PRODUCT_CONTRACT_MISSING",
        message: "Repository product contract is not configured."
      },
      warnings: []
    });

    expect(ProjectProductBriefSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: "missing",
      authority: "unavailable",
      planning_readiness: "technical_only",
      setup_guidance: [{
        action: "create_product_contract",
        required_sections: [
          "product",
          "primary_users",
          "jobs_to_be_done",
          "must_reduce",
          "must_not_become",
          "experience_principles",
          "canonical_docs",
          "governance"
        ]
      }]
    });
    expect(result).not.toHaveProperty("product");
  });

  test("returns repair guidance and preserves the exact invalid diagnostic", () => {
    const result = projectProductBrief({
      status: "invalid",
      source_path: "docs/product-contract.json",
      diagnostic: {
        code: "PRODUCT_CONTRACT_MALFORMED",
        message: "Repository product contract does not match the required schema.",
        fields: ["primary_users"]
      },
      warnings: []
    });

    expect(ProjectProductBriefSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: "invalid",
      authority: "unavailable",
      planning_readiness: "technical_only",
      diagnostic: {
        code: "PRODUCT_CONTRACT_MALFORMED",
        fields: ["primary_users"]
      },
      setup_guidance: [{ action: "repair_product_contract" }]
    });
    expect(result).not.toHaveProperty("product");
  });
});
