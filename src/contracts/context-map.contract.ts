import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const ContextMapInputSchema = RepoInputSchema.extend({
  goal: z.string().min(1).optional().describe("Optional planning goal used to infer additional focus paths from filename terms."),
  focus_paths: z.array(z.string()).optional().describe("Optional repo-relative paths to center reverse dependency and test-affinity analysis on."),
  max_files: z.number().int().positive().optional().describe("Maximum number of source files to scan for import edges.")
});

export const ContextMapEntryPointSchema = z.object({
  path: z.string(),
  kind: z.enum(["package", "runtime", "cli", "config"]),
  reason: z.string()
});

export const ContextMapImportEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  import: z.string(),
  unresolved: z.boolean().optional()
});

export const ContextMapReverseDependentSchema = z.object({
  path: z.string(),
  dependents: z.array(z.string())
});

export const ContextMapRouteSignalSchema = z.object({
  path: z.string(),
  route: z.string(),
  kind: z.enum(["app-route", "pages-route", "api-route"])
});

export const ContextMapComponentSignalSchema = z.object({
  path: z.string(),
  name: z.string()
});

export const ContextMapResultSchema = z.object({
  entrypoints: z.array(ContextMapEntryPointSchema),
  import_edges: z.array(ContextMapImportEdgeSchema),
  reverse_dependents: z.array(ContextMapReverseDependentSchema),
  affected_tests: z.array(z.string()),
  generated_paths: z.array(z.string()),
  dependency_paths: z.array(z.string()),
  route_signals: z.array(ContextMapRouteSignalSchema),
  component_signals: z.array(ContextMapComponentSignalSchema),
  framework_signals: z.array(z.string()),
  scanned_file_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warnings: z.array(z.string())
});

export type ContextMapInput = z.infer<typeof ContextMapInputSchema>;
export type ContextMapResult = z.infer<typeof ContextMapResultSchema>;
export type ContextMapEntryPoint = z.infer<typeof ContextMapEntryPointSchema>;
export type ContextMapImportEdge = z.infer<typeof ContextMapImportEdgeSchema>;
export type ContextMapRouteSignal = z.infer<typeof ContextMapRouteSignalSchema>;
export type ContextMapComponentSignal = z.infer<typeof ContextMapComponentSignalSchema>;
