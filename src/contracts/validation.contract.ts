import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const ValidationProfileSchema = z.enum(["test", "build", "lint", "typecheck", "smoke", "all"]);
export const ValidationCommandStatusSchema = z.enum(["passed", "failed", "skipped"]);
export const NodeRuntimeSourceSchema = z.enum(["package.json#volta.node", ".node-version", ".nvmrc", "package.json#engines.node"]);
export const ValidationRuntimeSchema = z.object({
  name: z.literal("node").describe("Selected project runtime name."),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).describe("Exact selected Node.js version."),
  source: NodeRuntimeSourceSchema.describe("Repository metadata source that requested the Node.js version.")
});

export const ValidateInputSchema = RepoInputSchema.extend({
  profile: ValidationProfileSchema.describe("Allowlisted validation profile resolved first from the repo-owned runner contract, then npm, then the safe pytest test fallback."),
  test_paths: z.array(z.string().min(1)).optional().describe("Optional focused test paths. Only valid for profile test when allowed by repository validation policy."),
  dry_run: z.boolean().optional().describe("When true, resolve runners and verify any requested Node binary without executing project validation scripts."),
  timeout_ms: z.number().int().positive().max(300_000).optional().describe("Optional per-command timeout in milliseconds, capped at 300000.")
});

export const ValidateCommandResultSchema = z.object({
  profile: ValidationProfileSchema.describe("Validation profile represented by this command, including a repository-owned all profile."),
  script: z.string().min(1).describe("Selected validation runner name, such as an npm script name or pytest."),
  command: z.string().min(1).describe("Display-only command summary such as npm run test or .venv/bin/python -m pytest."),
  runtime: ValidationRuntimeSchema.optional().describe("Repo-selected Node.js runtime used for this npm validation command."),
  status: ValidationCommandStatusSchema.describe("Validation command result status."),
  exit_code: z.number().int().optional().describe("Process exit code when the validation runner completed with an exit code."),
  duration_ms: z.number().int().nonnegative().optional().describe("Elapsed command duration in milliseconds when the command executed."),
  stdout_tail: z.string().optional().describe("Redacted bounded tail of stdout from the command."),
  stderr_tail: z.string().optional().describe("Redacted bounded tail of stderr from the command.")
});

export const ValidateResultSchema = z.object({
  ok: z.literal(true).describe("True when validation planning or execution completed."),
  repo_id: z.string().describe("Approved repository id that validation targeted."),
  validation_id: z.string().optional().describe("Stable id for the saved validation artifact when validation executed."),
  profile: ValidationProfileSchema.describe("Requested validation profile."),
  focused: z.boolean().optional().describe("Whether validation was scoped to explicit test paths."),
  test_paths: z.array(z.string()).optional().describe("Validated focused test paths when supplied."),
  dry_run: z.boolean().describe("Whether validation resolved commands without executing project validation scripts."),
  status: ValidationCommandStatusSchema.describe("Overall validation status across all selected commands."),
  commands: z.array(ValidateCommandResultSchema).describe("Validation commands selected and their results."),
  counts: z.object({
    total: z.number().int().nonnegative().describe("Total selected validation commands."),
    passed: z.number().int().nonnegative().describe("Number of validation commands that passed."),
    failed: z.number().int().nonnegative().describe("Number of validation commands that failed."),
    skipped: z.number().int().nonnegative().describe("Number of validation commands skipped by dry-run mode.")
  }).describe("Validation command counts by status."),
  warnings: z.array(z.string()).describe("Stable warning codes produced during validation."),
  validation_artifact: z.object({
    path: z.string().describe("Repo-relative path to the saved redacted validation artifact.")
  }).optional().describe("Saved validation artifact metadata when validation executed.")
});

export type ValidateInput = z.infer<typeof ValidateInputSchema>;
export type ValidationProfile = z.infer<typeof ValidationProfileSchema>;
export type ValidateResult = z.infer<typeof ValidateResultSchema>;
