import { z } from "zod";
import {
  ProductCanonicalDocumentPathSchema,
  ProductContractDiagnosticSchema,
  ProductDescriptorSchema,
  ProductGovernanceSchema,
  ProductJobSchema,
  ProductUserSchema
} from "./product-contract.contract.js";
import { DelegationCheckpointSchema } from "./delegation-drift.contract.js";

const ProjectProductBoundarySchema = z.object({
  must_reduce: z.array(z.string().min(1).max(500)).max(50),
  must_not_become: z.array(z.string().min(1).max(500)).max(50),
  experience_principles: z.array(z.string().min(1).max(500)).max(50)
}).strict();

const ProjectCanonicalEvidenceSchema = z.object({
  path: ProductCanonicalDocumentPathSchema,
  size_bytes: z.number().int().nonnegative(),
  role: z.literal("canonical_reference")
}).strict();

const ProductContractSetupGuidanceSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_product_contract"),
    path: ProductCanonicalDocumentPathSchema,
    reason: z.string().min(1).max(1_000),
    required_sections: z.array(z.enum([
      "product",
      "primary_users",
      "jobs_to_be_done",
      "must_reduce",
      "must_not_become",
      "experience_principles",
      "canonical_docs",
      "governance"
    ])).length(8)
  }).strict(),
  z.object({
    action: z.literal("repair_product_contract"),
    path: ProductCanonicalDocumentPathSchema,
    reason: z.string().min(1).max(1_000)
  }).strict()
]);

export const ProjectProductBriefConfiguredSchema = z.object({
  status: z.literal("configured"),
  authority: z.literal("repository_product_contract"),
  source_path: ProductCanonicalDocumentPathSchema,
  contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  product: ProductDescriptorSchema,
  governance: ProductGovernanceSchema,
  delegation_checkpoint: DelegationCheckpointSchema
    .describe("Compact repository-wide Delegation v3 checkpoint state derived from validated historical root runs and product reviews; never an implementation priority."),
  primary_users: z.array(ProductUserSchema).min(1).max(20),
  jobs_to_be_done: z.array(ProductJobSchema).min(1).max(50),
  product_boundaries: ProjectProductBoundarySchema,
  canonical_evidence: z.array(ProjectCanonicalEvidenceSchema).min(1).max(20),
  planning_readiness: z.literal("product_grounded"),
  setup_guidance: z.array(ProductContractSetupGuidanceSchema).length(0)
}).strict();

const ProjectProductBriefUnavailableShape = {
  authority: z.literal("unavailable"),
  source_path: ProductCanonicalDocumentPathSchema,
  planning_readiness: z.literal("technical_only"),
  diagnostic: ProductContractDiagnosticSchema,
  setup_guidance: z.array(ProductContractSetupGuidanceSchema).length(1)
};

export const ProjectProductBriefMissingSchema = z.object({
  status: z.literal("missing"),
  ...ProjectProductBriefUnavailableShape
}).strict();

export const ProjectProductBriefInvalidSchema = z.object({
  status: z.literal("invalid"),
  ...ProjectProductBriefUnavailableShape
}).strict();

export const ProjectProductBriefSchema = z.discriminatedUnion("status", [
  ProjectProductBriefConfiguredSchema,
  ProjectProductBriefMissingSchema,
  ProjectProductBriefInvalidSchema
]);

export type ProjectProductBrief = z.infer<typeof ProjectProductBriefSchema>;
