import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const SymbolDirectionSchema = z.enum(["inbound", "outbound", "both"]);
export const SymbolKindSchema = z.enum(["function", "class", "interface", "type", "enum", "variable", "method"]);
export const SymbolConfidenceSchema = z.enum(["high", "medium", "low"]);

export const SymbolContextInputSchema = RepoInputSchema.extend({
  symbols: z.array(z.string().min(1).max(160)).max(20).optional().describe("Optional exact symbol names to inspect."),
  paths: z.array(z.string().min(1)).max(50).optional().describe("Optional repo-relative source paths whose definitions should seed analysis."),
  direction: SymbolDirectionSchema.optional().describe("Call-edge direction to expand; defaults to both."),
  depth: z.number().int().min(0).max(4).optional().describe("Maximum call-edge expansion depth, capped at 4."),
  max_files: z.number().int().positive().max(500).optional().describe("Maximum source files to scan, capped at 500."),
  max_symbols: z.number().int().positive().max(500).optional().describe("Maximum definitions to return, capped at 500."),
  max_relations: z.number().int().positive().max(2_000).optional().describe("Maximum references and relations to return, capped at 2000.")
}).refine((value) => (value.symbols?.length ?? 0) > 0 || (value.paths?.length ?? 0) > 0, {
  message: "At least one symbol or path is required."
});

export const SymbolDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: SymbolKindSchema,
  path: z.string(),
  line: z.number().int().positive(),
  exported: z.boolean(),
  container: z.string().optional()
});

export const SymbolLocationSchema = z.object({
  symbol_id: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  from_symbol_id: z.string().optional()
});

export const SymbolCallSchema = z.object({
  from_symbol_id: z.string(),
  to_symbol_id: z.string(),
  path: z.string(),
  line: z.number().int().positive()
});

export const SymbolImplementationSchema = z.object({
  interface_symbol_id: z.string(),
  implementation_symbol_id: z.string(),
  path: z.string(),
  line: z.number().int().positive()
});

export const SymbolImportSchema = z.object({
  path: z.string(),
  module: z.string(),
  names: z.array(z.string())
});

export const CodeIntelligenceProviderSchema = z.object({
  name: z.enum(["native", "codebase_memory"]),
  status: z.enum([
    "native_only",
    "ready",
    "index_required",
    "indexing",
    "degraded",
    "provider_unavailable"
  ]),
  fallback_used: z.literal("native").optional(),
  index_available: z.boolean(),
  suggested_action: z.string().optional(),
  graph: z.object({
    definitions: z.array(z.object({
      name: z.string(),
      kind: z.string(),
      path: z.string(),
      line_start: z.number().int().positive(),
      line_end: z.number().int().positive()
    })),
    callers: z.array(z.object({ name: z.string(), hop: z.number().int().nonnegative() })),
    callees: z.array(z.object({ name: z.string(), hop: z.number().int().nonnegative() }))
  }).optional(),
  warnings: z.array(z.string())
});

export const SymbolContextResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  definitions: z.array(SymbolDefinitionSchema),
  references: z.array(SymbolLocationSchema),
  calls: z.array(SymbolCallSchema),
  implementations: z.array(SymbolImplementationSchema),
  imports: z.array(SymbolImportSchema),
  exports: z.array(z.string()),
  reverse_dependents: z.array(z.object({ symbol_id: z.string(), paths: z.array(z.string()) })),
  affected_tests: z.array(z.string()),
  cache: z.object({ key: z.string(), path: z.string(), hit: z.boolean() }),
  scanned_file_count: z.number().int().nonnegative(),
  confidence: SymbolConfidenceSchema,
  truncated: z.boolean(),
  warnings: z.array(z.string()),
  provider: CodeIntelligenceProviderSchema.optional()
});

export type SymbolContextInput = z.infer<typeof SymbolContextInputSchema>;
export type SymbolContextResult = z.infer<typeof SymbolContextResultSchema>;
export type SymbolDefinition = z.infer<typeof SymbolDefinitionSchema>;
export type SymbolLocation = z.infer<typeof SymbolLocationSchema>;
export type SymbolCall = z.infer<typeof SymbolCallSchema>;
export type SymbolImplementation = z.infer<typeof SymbolImplementationSchema>;
export type SymbolImport = z.infer<typeof SymbolImportSchema>;
export type CodeIntelligenceProvider = z.infer<typeof CodeIntelligenceProviderSchema>;
