import { readOnlyAnnotations, writeAnnotations } from "../annotations.js";
import {
  agentRunsHandler,
  codexReviewHandler,
  prepareCodexTaskHandler,
  writeAgentReplyHandler,
  writeCodexReviewHandler,
  writeIntegrationReviewHandler,
  writeCodexTaskHandler
} from "../handlers/delegation.js";
import { defineTool } from "../tool-definition.js";

export const delegationTools = [
  defineTool({ name: "repo_prepare_codex_task", title: "Prepare Delegation v3 task", package: "delegation", tier: "specialist", annotations: readOnlyAnnotations, handler: prepareCodexTaskHandler }),
  defineTool({ name: "repo_write_codex_task", title: "Write Delegation v3 task", package: "delegation", tier: "specialist", annotations: writeAnnotations, handler: writeCodexTaskHandler }),
  defineTool({ name: "repo_agent_runs", title: "Inspect agent runs", package: "delegation", tier: "specialist", annotations: readOnlyAnnotations, handler: agentRunsHandler }),
  defineTool({ name: "repo_write_agent_reply", title: "Reply to an agent run", package: "delegation", tier: "specialist", annotations: writeAnnotations, handler: writeAgentReplyHandler }),
  defineTool({ name: "repo_codex_review", title: "Review Codex result", package: "delegation", tier: "specialist", annotations: readOnlyAnnotations, handler: codexReviewHandler }),
  defineTool({ name: "repo_write_codex_review", title: "Write state-bound Codex review", package: "delegation", tier: "specialist", annotations: writeAnnotations, handler: writeCodexReviewHandler }),
  defineTool({ name: "repo_write_integration_review", title: "Write multi-run integration review", package: "delegation", tier: "specialist", annotations: writeAnnotations, handler: writeIntegrationReviewHandler })
];
