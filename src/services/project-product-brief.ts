import {
  ProjectProductBriefSchema,
  type ProjectProductBrief
} from "../contracts/project-product-brief.contract.js";
import type { ProductContractLoadResult } from "../contracts/product-contract.contract.js";

const REQUIRED_PRODUCT_CONTRACT_SECTIONS = [
  "product",
  "primary_users",
  "jobs_to_be_done",
  "must_reduce",
  "must_not_become",
  "experience_principles",
  "canonical_docs",
  "governance"
] as const;

export function projectProductBrief(result: ProductContractLoadResult): ProjectProductBrief {
  if (result.status === "configured") {
    return ProjectProductBriefSchema.parse({
      status: "configured",
      authority: "repository_product_contract",
      source_path: result.source_path,
      contract_sha256: result.contract_sha256,
      product: result.contract.product,
      governance: result.contract.governance,
      delegation_checkpoint: {
        status: "no_history",
        governance_mode: result.contract.governance.mode,
        threshold_root_runs: result.contract.governance.checkpoint_every_root_runs,
        root_runs_since_last_product_checkpoint: 0
      },
      primary_users: result.contract.primary_users,
      jobs_to_be_done: result.contract.jobs_to_be_done,
      product_boundaries: {
        must_reduce: result.contract.must_reduce,
        must_not_become: result.contract.must_not_become,
        experience_principles: result.contract.experience_principles
      },
      canonical_evidence: result.canonical_documents.map(({ path, size_bytes }) => ({
        path,
        size_bytes,
        role: "canonical_reference" as const
      })),
      planning_readiness: "product_grounded",
      setup_guidance: []
    });
  }

  const action = result.status === "missing" ? "create_product_contract" : "repair_product_contract";
  return ProjectProductBriefSchema.parse({
    status: result.status,
    authority: "unavailable",
    source_path: result.source_path,
    planning_readiness: "technical_only",
    diagnostic: result.diagnostic,
    setup_guidance: [{
      action,
      path: result.source_path,
      reason: result.status === "missing"
        ? "Product planning cannot use repository-owned product truth until a reviewed product contract is configured."
        : "Product planning cannot use repository-owned product truth until the configured product contract is repaired.",
      ...(result.status === "missing" ? { required_sections: REQUIRED_PRODUCT_CONTRACT_SECTIONS } : {})
    }]
  });
}
