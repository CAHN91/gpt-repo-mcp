import type { ToolName } from "./contracts.js";

/**
 * Explicit OSS tool allowlist.
 *
 * This intentionally duplicates the canonical registry order so adding an
 * internal tool cannot expand the public surface without a separate review.
 * Agent-runner execution and the dev harness are runtime/package concerns,
 * not MCP tools, and are excluded by the export boundary.
 */
export const OSS_TOOL_ORDER = [
  "repo_list_roots",
  "repo_policy_explain",
  "repo_last_write",
  "repo_operation_ledger",
  "repo_tree",
  "repo_search",
  "repo_fetch_file",
  "repo_read_many",
  "repo_context_map",
  "repo_symbol_context",
  "repo_code_index",
  "repo_failure_diagnose",
  "repo_semantic_review",
  "repo_ship_review",
  "repo_git_status",
  "repo_git_diff",
  "repo_git_review",
  "repo_git_restore_paths",
  "repo_write_stage",
  "repo_write_unstage",
  "repo_write_commit",
  "repo_write_stage_commit",
  "repo_write_recover",
  "repo_cleanup_paths",
  "repo_project_brief",
  "repo_task_inventory",
  "repo_decision_memory",
  "repo_change_plan",
  "repo_prepare_codex_task",
  "repo_write_codex_task",
  "repo_agent_runs",
  "repo_write_agent_reply",
  "repo_codex_review",
  "repo_write_codex_review",
  "repo_write_integration_review",
  "repo_prepare_patchset",
  "repo_apply_patchset",
  "repo_review_patchset",
  "repo_rollback_patchset",
  "repo_validate",
  "repo_start_work_session",
  "repo_update_work_session",
  "repo_current_work_session",
  "repo_write_file",
  "repo_write_changes",
  "repo_write_handoff"
] as const satisfies readonly ToolName[];
