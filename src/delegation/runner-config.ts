import { z } from "zod";
import {
  AgentRunnerNameSchema,
  DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS
} from "./artifact-contracts.js";

// Validated compatibility contract shared by delegation artifacts and the
// source-only runner. This module does not execute or load a runner.

export const AgentRunnerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowed_runners: z.array(AgentRunnerNameSchema).default(["opencode_sdk"]),
  auto_start_enabled: z.boolean().default(false),
  require_clean_worktree: z.boolean().default(true),
  max_concurrent_runs: z.number().int().positive().default(1),
  poll_interval_ms: z.number().int().positive().default(1000),
  heartbeat_interval_ms: z.number().int().positive().default(5000),
  stale_lock_ms: z.number().int().positive().default(120000),
  max_runtime_ms: z.number().int().positive().default(DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS),
  max_turns: z.number().int().min(1).max(32).default(8),
  max_changed_files: z.number().int().nonnegative().default(12),
  allowed_paths: z.array(z.string()).default([]),
  blocked_paths: z.array(z.string()).default([
    ".env*",
    ".git/**",
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "test-results/**"
  ]),
  validation_profile: z.enum(["test", "build", "lint", "typecheck", "smoke", "all"]).default("test"),
  validation_required: z.boolean().default(true),
  commit_after_green: z.boolean().default(false),
  push_after_commit: z.boolean().default(false)
}).strict().superRefine((value, context) => {
  if (value.heartbeat_interval_ms >= value.stale_lock_ms) {
    context.addIssue({ code: "custom", path: ["heartbeat_interval_ms"], message: "heartbeat_interval_ms must be lower than stale_lock_ms." });
  }
  if (value.commit_after_green) {
    context.addIssue({ code: "custom", path: ["commit_after_green"], message: "Runner auto-commit is disabled; reviewed commits must pass the shared Delegation v3 gate through MCP Git operations." });
  }
  if (value.push_after_commit) {
    context.addIssue({ code: "custom", path: ["push_after_commit"], message: "Runner auto-push is disabled and cannot bypass the shared Delegation v3 gate." });
  }
});

export type AgentRunnerConfig = z.infer<typeof AgentRunnerConfigSchema>;
