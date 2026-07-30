import { z } from "zod";

export const RepoInputSchema = z.object({
  repo_id: z.string().min(1).describe("Stable approved repository id from repo_list_roots.")
});

export const RepoTreeInputSchema = RepoInputSchema.extend({
  path: z.string().optional(),
  max_depth: z.number().int().positive().optional(),
  page_size: z.number().int().positive().optional(),
  include_files: z.boolean().optional(),
  respect_default_excludes: z.boolean().optional(),
  include_generated: z.boolean().optional(),
  include_dependencies: z.boolean().optional(),
  cursor: z.string().optional().describe("Opaque cursor returned by a previous repo_tree call with the same path and filters.")
});

export const RepoSummarySchema = z.object({
  repo_id: z.string(),
  display_name: z.string(),
  root: z.string()
});

export const RepoListResultSchema = z.object({
  repos: z.array(RepoSummarySchema)
});
