import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";
import { SymbolConfidenceSchema } from "./symbol-context.contract.js";

export const SemanticRiskCategorySchema = z.enum(["public_contract", "api_schema", "migration", "authorization", "configuration", "async_error", "test_gap"]);
export const SemanticRiskPrioritySchema = z.enum(["high", "medium", "low"]);

export const SemanticReviewInputSchema = RepoInputSchema.extend({
  paths: z.array(z.string().min(1)).max(100).optional().describe("Optional changed repo-relative paths to scope semantic review."),
  categories: z.array(SemanticRiskCategorySchema).max(7).optional().describe("Optional risk categories to inspect; omit for all categories."),
  max_findings: z.number().int().positive().max(100).optional().describe("Maximum evidence-backed findings to return, capped at 100."),
  max_files: z.number().int().positive().max(500).optional().describe("Maximum source files available to symbol correlation, capped at 500.")
});

export const SemanticFindingSchema = z.object({
  id: z.string(),
  category: SemanticRiskCategorySchema,
  priority: SemanticRiskPrioritySchema,
  confidence: SymbolConfidenceSchema,
  title: z.string(),
  path: z.string(),
  line: z.number().int().positive().optional(),
  evidence: z.array(z.string()),
  affected_symbols: z.array(z.string()),
  related_paths: z.array(z.string()),
  recommended_check: z.string(),
  blocks_ship: z.boolean()
});

export const SemanticReviewResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  reviewed_paths: z.array(z.string()),
  findings: z.array(SemanticFindingSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    blocking: z.number().int().nonnegative()
  }),
  ship_readiness: z.object({
    status: z.enum(["ready", "review_required"]),
    blocking_finding_ids: z.array(z.string()),
    validation_status: z.enum(["passed", "failed", "skipped", "missing"])
  }),
  next_tool_payloads: z.object({
    repo_git_review: z.object({ repo_id: z.string(), paths: z.array(z.string()).optional() }),
    repo_symbol_context: z.object({ repo_id: z.string(), paths: z.array(z.string()), direction: z.literal("both"), depth: z.number().int() }).optional(),
    repo_failure_diagnose: z.object({ repo_id: z.string() }).optional()
  }),
  truncated: z.boolean(),
  warnings: z.array(z.string())
});

export type SemanticReviewInput = z.infer<typeof SemanticReviewInputSchema>;
export type SemanticReviewResult = z.infer<typeof SemanticReviewResultSchema>;
export type SemanticFinding = z.infer<typeof SemanticFindingSchema>;
export type SemanticRiskCategory = z.infer<typeof SemanticRiskCategorySchema>;
