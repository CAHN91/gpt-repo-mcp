import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const PathInputSchema = z.object({
  path: z.string().min(1)
});

export const GlobScopeSchema = z.object({
  include_globs: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional()
});

export const FetchFileInputSchema = RepoInputSchema.extend({
  path: z.string().min(1),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  max_bytes: z.number().int().positive().optional(),
  override_default_excludes: z.boolean().optional()
});

export const ReadManyInputSchema = RepoInputSchema.extend({
  paths: z.array(z.string()).optional(),
  include_globs: z.array(z.string()).optional(),
  exclude_globs: z.array(z.string()).optional(),
  max_files: z.number().int().positive().optional(),
  max_bytes_per_file: z.number().int().positive().optional(),
  max_total_bytes: z.number().int().positive().optional(),
  cursor: z.string().optional()
}).refine((input) => (input.paths?.length ?? 0) > 0 || (input.include_globs?.length ?? 0) > 0, {
  message: "repo_read_many requires paths or include_globs.",
  path: ["paths"]
});

export const FileClassificationSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  is_binary: z.boolean(),
  is_secret_candidate: z.boolean(),
  is_generated: z.boolean()
});

export const FileSummarySchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory", "nested_repo", "submodule"]),
  size_bytes: z.number().int().nonnegative().optional()
});

export const FileContentSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  newline_style: z.enum(["lf", "crlf", "cr", "mixed", "none"]).describe("Original on-disk newline style; returned text is normalized to LF."),
  has_final_newline: z.boolean().describe("Whether the original file ended with a newline sequence."),
  total_lines: z.number().int().nonnegative(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  truncated: z.boolean(),
  text: z.string(),
  warnings: z.array(z.string()).default([])
});

export const ReadManyResultSchema = z.object({
  files: z.array(FileContentSchema),
  skipped: z.array(z.object({
    path: z.string(),
    reason: z.string()
  })),
  matched_count: z.number().int().nonnegative(),
  returned_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  next_cursor: z.string().optional()
});
