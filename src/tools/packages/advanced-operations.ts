import { readOnlyAnnotations, writeAnnotations } from "../annotations.js";
import {
  cleanupPathsHandler,
  gitRestorePathsHandler,
  operationLedgerHandler,
  writeCommitHandler,
  writeStageHandler,
  writeUnstageHandler
} from "../handlers/advanced-operations.js";
import { defineTool } from "../tool-definition.js";

export const advancedOperationTools = [
  defineTool({ name: "repo_operation_ledger", title: "Read operation ledger", package: "advanced_operations", tier: "specialist", annotations: readOnlyAnnotations, handler: operationLedgerHandler }),
  defineTool({ name: "repo_git_restore_paths", title: "Restore explicit worktree paths", package: "advanced_operations", tier: "specialist", annotations: writeAnnotations, handler: gitRestorePathsHandler }),
  defineTool({ name: "repo_write_stage", title: "Stage reviewed paths", package: "advanced_operations", tier: "specialist", annotations: writeAnnotations, handler: writeStageHandler }),
  defineTool({ name: "repo_write_unstage", title: "Unstage reviewed paths", package: "advanced_operations", tier: "specialist", annotations: writeAnnotations, handler: writeUnstageHandler }),
  defineTool({ name: "repo_write_commit", title: "Create reviewed local commit", package: "advanced_operations", tier: "specialist", annotations: writeAnnotations, handler: writeCommitHandler }),
  defineTool({ name: "repo_cleanup_paths", title: "Clean up generated paths", package: "advanced_operations", tier: "specialist", annotations: writeAnnotations, handler: cleanupPathsHandler })
];
