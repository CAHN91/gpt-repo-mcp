import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";
import { SymbolConfidenceSchema } from "./symbol-context.contract.js";

const ValidationIdSchema = z.string().regex(/^validation-[A-Za-z0-9-]{1,160}$/);
const DevHarnessArtifactSchema = z.string().regex(/^\.chatgpt\/dev-harness\/[A-Za-z0-9._/-]+\.json$/).refine((path) => !path.split("/").includes(".."), {
  message: "Expected a safe repo-local dev-harness JSON artifact path."
});

export const FailureDiagnoseInputSchema = RepoInputSchema.extend({
  validation_id: ValidationIdSchema.optional().describe("Optional validation id; omit to inspect the latest saved validation artifact."),
  dev_harness_artifacts: z.array(DevHarnessArtifactSchema).max(10).optional().describe("Optional explicit repo-local dev-harness JSON artifacts to correlate."),
  scope_paths: z.array(z.string().min(1)).max(50).optional().describe("Optional repo-relative paths that bound candidate correlation."),
  max_diagnostics: z.number().int().positive().max(200).optional().describe("Maximum normalized diagnostics to return, capped at 200."),
  max_candidates: z.number().int().positive().max(50).optional().describe("Maximum ranked candidates to return, capped at 50.")
});

export const FailureDiagnosticSchema = z.object({
  tool: z.enum(["typescript", "eslint", "vitest", "jest", "pytest", "node", "python", "unknown"]),
  source: z.enum(["validation", "dev_harness"]),
  artifact_path: z.string(),
  message: z.string(),
  code: z.string().optional(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  test_name: z.string().optional()
});

export const FailureCandidateSchema = z.object({
  path: z.string(),
  score: z.number().int().min(0).max(100),
  confidence: SymbolConfidenceSchema,
  evidence: z.array(z.string()),
  heuristics: z.array(z.string()),
  symbols: z.array(z.string()),
  affected_tests: z.array(z.string()),
  recommended_checks: z.array(z.string())
});

export const FailureDiagnoseResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  validation: z.object({
    found: z.boolean(),
    validation_id: z.string().optional(),
    artifact_path: z.string().optional(),
    status: z.enum(["passed", "failed", "skipped"]).optional()
  }),
  diagnostics: z.array(FailureDiagnosticSchema),
  candidates: z.array(FailureCandidateSchema),
  correlations: z.object({
    changed_paths: z.array(z.string()),
    touched_paths: z.array(z.string()),
    symbol_paths: z.array(z.string())
  }),
  next_tool_payloads: z.object({
    repo_fetch_file: z.object({ repo_id: z.string(), path: z.string() }).optional(),
    repo_symbol_context: z.object({ repo_id: z.string(), paths: z.array(z.string()), direction: z.literal("both"), depth: z.number().int() }).optional(),
    repo_validate: z.object({ repo_id: z.string(), profile: z.literal("test"), test_paths: z.array(z.string()) }).optional()
  }),
  truncated: z.boolean(),
  warnings: z.array(z.string())
});

export type FailureDiagnoseInput = z.infer<typeof FailureDiagnoseInputSchema>;
export type FailureDiagnoseResult = z.infer<typeof FailureDiagnoseResultSchema>;
export type FailureDiagnostic = z.infer<typeof FailureDiagnosticSchema>;
export type FailureCandidate = z.infer<typeof FailureCandidateSchema>;
