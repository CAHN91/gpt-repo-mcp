import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

const PolicyDecisionSchema = z.object({
  allowed: z.boolean().describe("Whether the requested policy check allows this path or operation."),
  code: z.string().describe("Stable policy result code such as ALLOWED, WRITE_DISABLED, WRITE_DENIED_GLOB, or SECRET_CANDIDATE_BLOCKED."),
  reason: z.string().describe("Short human-readable explanation optimized for ChatGPT to relay to the user."),
  matched_globs: z.array(z.string()).describe("Configured globs that matched the path for this policy check."),
  notes: z.array(z.string()).describe("Extra constraints, warnings, or follow-up facts relevant to this decision.")
});

export const PolicyExplainInputSchema = RepoInputSchema.extend({
  path: z.string().optional().describe("Optional repo-relative POSIX path to explain, for example README.md or app/page.tsx."),
  operation: z.enum(["read", "write", "cleanup", "validation"]).optional().describe("Optional policy area to focus on. Omit to explain read, write, cleanup, validation, and git operation settings together.")
});

export const PolicyExplainResultSchema = z.object({
  ok: z.literal(true).describe("True when policy explanation succeeded."),
  repo_id: z.string().describe("Approved repository id that was explained."),
  path: z.string().optional().describe("Normalized repo-relative path that was checked, when a path was supplied."),
  requested_operation: z.enum(["read", "write", "cleanup", "validation"]).optional().describe("Policy area requested by the caller, when provided."),
  summary: z.string().describe("One-sentence explanation of the most relevant policy result."),
  read: PolicyDecisionSchema.describe("Read policy decision for the path, or general read-policy status when no path was supplied."),
  write: PolicyDecisionSchema.describe("Write policy decision for the path, or general write-policy status when no path was supplied."),
  cleanup: PolicyDecisionSchema.describe("Cleanup policy decision for the path, or general cleanup-policy status when no path was supplied."),
  validation: PolicyDecisionSchema.describe("Validation policy decision for this repository."),
  operations: z.object({
    enabled: z.boolean().describe("Whether local repository operations are enabled."),
    git_stage_enabled: z.boolean().describe("Whether local git stage and unstage operations are enabled."),
    git_commit_enabled: z.boolean().describe("Whether local git commit operations are enabled."),
    validation_enabled: z.boolean().describe("Whether allowlisted local validation profiles are enabled."),
    cleanup_enabled: z.boolean().describe("Whether local cleanup operations are enabled."),
    max_paths_per_operation: z.number().int().positive().describe("Maximum explicit paths accepted by one local operation.")
  }).describe("Effective local operation policy toggles for this repository."),
  effective_policy: z.object({
    write_enabled: z.boolean().describe("Whether file writes are enabled for this repository."),
    write_allowed_globs: z.array(z.string()).describe("Effective allowed globs for file writes."),
    write_denied_globs: z.array(z.string()).describe("Effective denied globs for file writes."),
    max_bytes_per_write: z.number().int().positive().describe("Maximum resulting file size for one write."),
    default_read_excludes: z.array(z.string()).describe("Default read/tree/search excludes applied by read tools."),
    cleanup_allowed_globs: z.array(z.string()).describe("Effective cleanup allowed globs.")
  }).describe("Effective policy values useful for debugging blocked tool calls."),
  guidance: z.array(z.string()).describe("Actionable next steps for ChatGPT or the user.")
});

export type PolicyExplainInput = z.infer<typeof PolicyExplainInputSchema>;
