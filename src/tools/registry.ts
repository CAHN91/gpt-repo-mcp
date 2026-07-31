import type { ToolName } from "./contracts.js";
import { advancedOperationTools } from "./packages/advanced-operations.js";
import { codeIndexTools } from "./packages/code-index.js";
import { delegationTools } from "./packages/delegation.js";
import { developerTools } from "./packages/developer.js";
import { diagnosticAndDiscoveryTools } from "./packages/diagnostics-and-discovery.js";
import { patchsetTools } from "./packages/patchsets.js";
import type { ToolDefinition, ToolPackage } from "./tool-definition.js";

export const CANONICAL_TOOL_ORDER = [
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

const packageDefinitions = [
  ...developerTools,
  ...delegationTools,
  ...patchsetTools,
  ...advancedOperationTools,
  ...diagnosticAndDiscoveryTools,
  ...codeIndexTools
];

const definitionsByName = new Map<ToolName, ToolDefinition>();
for (const definition of packageDefinitions) {
  if (definitionsByName.has(definition.name)) {
    throw new Error(`Duplicate tool definition: ${definition.name}`);
  }
  definitionsByName.set(definition.name, definition);
}

const missingDefinitions = CANONICAL_TOOL_ORDER.filter((name) => !definitionsByName.has(name));
const unknownDefinitions = [...definitionsByName.keys()].filter((name) => !CANONICAL_TOOL_ORDER.includes(name));
if (missingDefinitions.length > 0 || unknownDefinitions.length > 0) {
  throw new Error(`Tool registry mismatch. Missing: ${missingDefinitions.join(", ") || "none"}; unknown: ${unknownDefinitions.join(", ") || "none"}.`);
}

export const toolRegistry: readonly ToolDefinition[] = CANONICAL_TOOL_ORDER.map((name) => definitionsByName.get(name)!);

export function toolsForPackage(packageName: ToolPackage): readonly ToolDefinition[] {
  return toolRegistry.filter((tool) => tool.package === packageName);
}
