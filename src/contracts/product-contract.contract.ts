import { z } from "zod";

const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_SHORT_TEXT = 500;
const MAX_LONG_TEXT = 2_000;
const MAX_PATH_LENGTH = 512;
const MAX_USERS = 20;
const MAX_JOBS = 50;
const MAX_PRINCIPLES = 50;
const MAX_CANONICAL_DOCS = 20;

const BoundedTextSchema = (maxLength: number) => z.string()
  .min(1)
  .max(maxLength)
  .refine((value) => !value.includes("\0"), "NUL characters are not allowed.")
  .refine((value) => value.trim().length > 0, "Text must not be empty after trimming.");

export const ProductEntityIdSchema = z.string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "IDs must use lowercase letters, digits, and hyphens.");

export const ProductTaskKindSchema = z.enum(["product_slice", "product_correction"]);

export const ProductCanonicalDocumentPathSchema = z.string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .superRefine((value, context) => {
    if (value !== value.trim()) {
      context.addIssue({ code: "custom", message: "Canonical document paths cannot contain surrounding whitespace." });
    }
    if (/[\0\r\n]/.test(value)) {
      context.addIssue({ code: "custom", message: "Canonical document paths cannot contain NUL or newlines." });
    }
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
      context.addIssue({ code: "custom", message: "Canonical document paths must be repo-relative POSIX paths." });
    }
    if (value === "." || value.startsWith("./") || value.split("/").includes("..")) {
      context.addIssue({ code: "custom", message: "Canonical document paths cannot use traversal or dot-relative segments." });
    }
    if (["*", "?", "[", "]", "{", "}"].some((character) => value.includes(character))) {
      context.addIssue({ code: "custom", message: "Canonical document paths must be concrete paths, not globs." });
    }
  });

export const ProductDescriptorSchema = z.object({
  name: BoundedTextSchema(MAX_NAME_LENGTH),
  purpose: BoundedTextSchema(MAX_LONG_TEXT)
}).strict();

export const ProductUserSchema = z.object({
  id: ProductEntityIdSchema,
  role: BoundedTextSchema(MAX_NAME_LENGTH),
  technical_level: BoundedTextSchema(MAX_SHORT_TEXT),
  work_context: BoundedTextSchema(MAX_LONG_TEXT)
}).strict();

export const ProductJobSchema = z.object({
  id: ProductEntityIdSchema,
  statement: BoundedTextSchema(MAX_LONG_TEXT)
}).strict();

const ProductPrinciplesSchema = z.array(BoundedTextSchema(MAX_SHORT_TEXT)).min(1).max(MAX_PRINCIPLES);
const CanonicalDocumentsSchema = z.array(ProductCanonicalDocumentPathSchema).min(1).max(MAX_CANONICAL_DOCS);

export const ProductGovernanceSchema = z.object({
  mode: z.enum(["advisory", "enforce"]),
  product_review_required_for: z.array(ProductTaskKindSchema).max(2),
  checkpoint_every_root_runs: z.number().int().min(1).max(100)
}).strict().superRefine((value, context) => {
  if (hasDuplicates(value.product_review_required_for)) {
    context.addIssue({ code: "custom", path: ["product_review_required_for"], message: "Duplicate values are not allowed." });
  }
});

export const ProductContractSchema = z.object({
  schema_version: z.literal(1),
  product: ProductDescriptorSchema,
  primary_users: z.array(ProductUserSchema).min(1).max(MAX_USERS),
  jobs_to_be_done: z.array(ProductJobSchema).min(1).max(MAX_JOBS),
  must_reduce: ProductPrinciplesSchema,
  must_not_become: ProductPrinciplesSchema,
  experience_principles: ProductPrinciplesSchema,
  canonical_docs: CanonicalDocumentsSchema,
  governance: ProductGovernanceSchema
}).strict().superRefine((value, context) => {
  const duplicateFields: Array<[string, readonly string[]]> = [
    ["primary_users", value.primary_users.map(({ id }) => id)],
    ["jobs_to_be_done", value.jobs_to_be_done.map(({ id }) => id)],
    ["must_reduce", value.must_reduce.map((entry) => entry.trim())],
    ["must_not_become", value.must_not_become.map((entry) => entry.trim())],
    ["experience_principles", value.experience_principles.map((entry) => entry.trim())],
    ["canonical_docs", value.canonical_docs]
  ];
  for (const [field, values] of duplicateFields) {
    if (hasDuplicates(values)) {
      context.addIssue({ code: "custom", path: [field], message: "Duplicate values are not allowed." });
    }
  }
});

export const ProductContractDiagnosticCodeSchema = z.enum([
  "PRODUCT_CONTRACT_MISSING",
  "PRODUCT_CONTRACT_MALFORMED",
  "PRODUCT_CONTRACT_TRUNCATED",
  "PRODUCT_CONTRACT_UNSAFE",
  "PRODUCT_CONTRACT_UNSUPPORTED",
  "PRODUCT_CONTRACT_SECRET_BLOCKED",
  "PRODUCT_CONTRACT_CANONICAL_DOC_INVALID",
  "PRODUCT_CONTRACT_SELECTION_INVALID"
]);

export const ProductContractDiagnosticSchema = z.object({
  code: ProductContractDiagnosticCodeSchema,
  message: z.string().min(1).max(500),
  fields: z.array(z.string().min(1).max(200)).max(20).optional()
}).strict();

const CanonicalDocumentMetadataSchema = z.object({
  path: ProductCanonicalDocumentPathSchema,
  size_bytes: z.number().int().nonnegative()
}).strict();

export const ProductContractConfiguredSchema = z.object({
  status: z.literal("configured"),
  source_path: ProductCanonicalDocumentPathSchema,
  size_bytes: z.number().int().nonnegative(),
  contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contract: ProductContractSchema,
  canonical_documents: z.array(CanonicalDocumentMetadataSchema).max(MAX_CANONICAL_DOCS),
  warnings: z.array(z.string())
}).strict();

export const ProductContractMissingSchema = z.object({
  status: z.literal("missing"),
  source_path: ProductCanonicalDocumentPathSchema,
  diagnostic: ProductContractDiagnosticSchema,
  warnings: z.array(z.string())
}).strict();

export const ProductContractInvalidSchema = z.object({
  status: z.literal("invalid"),
  source_path: ProductCanonicalDocumentPathSchema,
  diagnostic: ProductContractDiagnosticSchema,
  warnings: z.array(z.string())
}).strict();

export const ProductContractLoadResultSchema = z.discriminatedUnion("status", [
  ProductContractConfiguredSchema,
  ProductContractMissingSchema,
  ProductContractInvalidSchema
]);

export const ProductContextSelectionInputSchema = z.object({
  primary_user_id: ProductEntityIdSchema,
  job_ids: z.array(ProductEntityIdSchema).min(1).max(MAX_JOBS)
}).strict().superRefine((value, context) => {
  if (hasDuplicates(value.job_ids)) {
    context.addIssue({ code: "custom", path: ["job_ids"], message: "Duplicate values are not allowed." });
  }
});

export const ProductContextSnapshotSchema = z.object({
  schema_version: z.literal(1),
  product: ProductDescriptorSchema,
  primary_user: ProductUserSchema,
  jobs_to_be_done: z.array(ProductJobSchema).min(1).max(MAX_JOBS),
  must_reduce: ProductPrinciplesSchema,
  must_not_become: ProductPrinciplesSchema,
  experience_principles: ProductPrinciplesSchema,
  canonical_docs: CanonicalDocumentsSchema,
  governance: ProductGovernanceSchema
}).strict();

export const ProductContextSelectionResultSchema = z.object({
  source_path: ProductCanonicalDocumentPathSchema,
  contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: ProductContextSnapshotSchema
}).strict();

export type ProductContract = z.infer<typeof ProductContractSchema>;
export type ProductContractConfigured = z.infer<typeof ProductContractConfiguredSchema>;
export type ProductContractLoadResult = z.infer<typeof ProductContractLoadResultSchema>;
export type ProductContractDiagnosticCode = z.infer<typeof ProductContractDiagnosticCodeSchema>;
export type ProductContextSelectionInput = z.infer<typeof ProductContextSelectionInputSchema>;
export type ProductContextSelectionResult = z.infer<typeof ProductContextSelectionResultSchema>;
export type ProductTaskKind = z.infer<typeof ProductTaskKindSchema>;

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}
