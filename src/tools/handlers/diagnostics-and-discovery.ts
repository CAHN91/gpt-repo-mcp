import { DecisionLogService } from "../../services/decision-log-service.js";
import { FailureDiagnoseService } from "../../services/failure-diagnose-service.js";
import { OperationsPolicy } from "../../services/operations-policy.js";
import { PathSandbox } from "../../services/path-sandbox.js";
import { SemanticReviewService } from "../../services/semantic-review-service.js";
import { TaskInventoryService } from "../../services/task-inventory-service.js";
import { createSuccessEnvelope } from "../../runtime/result-envelope.js";
import { audit } from "../../runtime/telemetry.js";
import type { DecisionLogInput } from "../../contracts/decision.contract.js";
import type { FailureDiagnoseInput } from "../../contracts/failure-diagnose.contract.js";
import type { SemanticReviewInput } from "../../contracts/semantic-review.contract.js";
import type { TaskInventoryInput } from "../../contracts/task.contract.js";
import { safeTool, type ToolHandler } from "../handler-support.js";

export const failureDiagnoseHandler: ToolHandler = async (input, context) => safeTool<FailureDiagnoseInput>("repo_failure_diagnose", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new FailureDiagnoseService(repo.root, new PathSandbox(repo.root), new OperationsPolicy(repo.operations)).diagnose(args);
  audit({ tool: "repo_failure_diagnose", repo_id: args.repo_id, paths: args.scope_paths, counts: { diagnostics: result.diagnostics.length, candidates: result.candidates.length }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Normalized ${result.diagnostics.length} diagnostics into ${result.candidates.length} evidence-ranked candidates.`);
});

export const semanticReviewHandler: ToolHandler = async (input, context) => safeTool<SemanticReviewInput>("repo_semantic_review", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new SemanticReviewService(repo.root, new PathSandbox(repo.root)).review(args);
  audit({ tool: "repo_semantic_review", repo_id: args.repo_id, paths: result.reviewed_paths, counts: { findings: result.findings.length, blocking: result.summary.blocking }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Returned ${result.findings.length} semantic findings; ${result.summary.blocking} are high-confidence ship blockers.`);
});

export const taskInventoryHandler: ToolHandler = async (input, context) => safeTool<TaskInventoryInput>("repo_task_inventory", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new TaskInventoryService(new PathSandbox(repo.root)).inventory(args);
  audit({ tool: "repo_task_inventory", repo_id: args.repo_id, counts: { tasks: result.returned_count }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Returned ${result.returned_count} task inventory items.`);
});

export const decisionMemoryHandler: ToolHandler = async (input, context) => safeTool<DecisionLogInput>("repo_decision_memory", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new DecisionLogService(new PathSandbox(repo.root)).decisionLog({ include_sources: args.include_sources });
  audit({ tool: "repo_decision_memory", repo_id: args.repo_id, counts: { decisions: result.decisions.length, conventions: result.conventions.length }, warnings: result.warnings });
  return createSuccessEnvelope(result, `Returned ${result.decisions.length} decisions and ${result.conventions.length} conventions.`);
});
