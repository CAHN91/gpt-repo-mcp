import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const GitStatusInputSchema = RepoInputSchema;

export const GitDiffInputSchema = RepoInputSchema.extend({
  base: z.string().optional().describe("Second-pass refinement for comparing from a specific base ref. Omit on the first diff call."),
  compare: z.string().optional().describe("Second-pass refinement for comparing to a specific ref. Omit on the first diff call."),
  staged: z.boolean().optional().describe("Second-pass refinement to focus on staged changes only. Omit on the first diff call."),
  unstaged: z.boolean().optional().describe("Second-pass refinement to focus on unstaged changes only. Omit on the first diff call."),
  paths: z.array(z.string()).optional().describe("Second-pass refinement for explicit repo-relative paths. Omit on the first diff call unless the user asks for specific paths."),
  max_bytes: z.number().int().positive().optional().describe("Second-pass refinement for output size when the default diff is truncated or too broad. Omit on the first diff call."),
  max_files: z.number().int().positive().optional().describe("Limit the actual changed paths loaded from Git before diff content is produced."),
  context_lines: z.number().int().min(0).max(20).optional().describe("Second-pass refinement for hunk context when the default diff needs more or less context. Omit on the first diff call.")
});

export const GitStatusResultSchema = z.object({
  branch: z.string(),
  head_sha: z.string(),
  clean: z.boolean(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  files: z.array(z.object({
    path: z.string(),
    original_path: z.string().optional(),
    index: z.string(),
    worktree: z.string()
  }))
});

export const GitDiffResultSchema = z.object({
  base: z.string().optional(),
  compare: z.string().optional(),
  staged: z.boolean().optional(),
  unstaged: z.boolean().optional(),
  files: z.array(z.object({
    path: z.string(),
    original_path: z.string().optional(),
    status: z.string().optional(),
    hunks: z.array(z.string())
  })),
  total_file_count: z.number().int().nonnegative(),
  truncation_reason: z.enum(["max_files", "max_bytes", "max_files+max_bytes"]).optional(),
  truncated: z.boolean(),
  warnings: z.array(z.string()).default([])
});
