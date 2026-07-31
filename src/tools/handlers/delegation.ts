import { DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS } from "../../delegation/artifact-contracts.js";
import { AgentReplyService } from "../../services/agent-reply-service.js";
import { AgentRunsService } from "../../services/agent-runs-service.js";
import { CodexResultService } from "../../services/codex-result-service.js";
import { CodexReviewAttestationService } from "../../services/codex-review-attestation-service.js";
import { DelegationV3TaskService } from "../../services/delegation-v3-task-service.js";
import { GitReviewService } from "../../services/git-review-service.js";
import { IntegrationReviewService } from "../../services/integration-review-service.js";
import { OperationsPolicy } from "../../services/operations-policy.js";
import { PathSandbox } from "../../services/path-sandbox.js";
import { WritePolicy } from "../../services/write-policy.js";
import { createSuccessEnvelope } from "../../runtime/result-envelope.js";
import { audit } from "../../runtime/telemetry.js";
import type { AgentReplyInput } from "../../contracts/agent-reply.contract.js";
import type { AgentRunsInput } from "../../contracts/agent-runs.contract.js";
import type { CodexReviewWriteInput } from "../../contracts/codex-review-attestation.contract.js";
import type { CodexReviewInput } from "../../contracts/codex-task.contract.js";
import type { DelegationTaskV3ToolInput, DelegationTaskV3WriteToolInput } from "../../contracts/delegation-v3.contract.js";
import type { IntegrationReviewWriteInput } from "../../contracts/integration-review.contract.js";
import { safeTool, type ToolHandler } from "../handler-support.js";

export const prepareCodexTaskHandler: ToolHandler = async (input, context) => safeTool<DelegationTaskV3ToolInput>("repo_prepare_codex_task", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new DelegationV3TaskService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes)).prepare(args);
  audit({ tool: "repo_prepare_codex_task", repo_id: args.repo_id, paths: [result.prompt_path, result.result_json_path], warnings: result.warnings });
  return createSuccessEnvelope(result, `Prepared Delegation v3 task ${result.run_id}.`, { warnings: result.warnings });
});

export const writeCodexTaskHandler: ToolHandler = async (input, context) => safeTool<DelegationTaskV3WriteToolInput>("repo_write_codex_task", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new DelegationV3TaskService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes)).write(args);
  audit({ tool: "repo_write_codex_task", repo_id: args.repo_id, paths: result.written_paths, warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked Delegation v3 task ${result.run_id}.` : `Wrote Delegation v3 task ${result.run_id}.`, { warnings: result.warnings });
});

export const agentRunsHandler: ToolHandler = async (input, context) => safeTool<AgentRunsInput>("repo_agent_runs", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new AgentRunsService(repo.root, new PathSandbox(repo.root), {
    repository_max_runtime_ms: DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS
  }).read(args);
  audit({ tool: "repo_agent_runs", repo_id: args.repo_id, counts: { matched: result.matched_count, returned: result.returned_count }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, result.mode === "detail" ? `Read agent run ${result.run?.run_id}.` : `Returned ${result.returned_count} agent runs.`, { warnings: result.warnings, truncated: result.truncated });
});

export const writeAgentReplyHandler: ToolHandler = async (input, context) => safeTool<AgentReplyInput>("repo_write_agent_reply", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new AgentReplyService(repo.root, new PathSandbox(repo.root), {
    repository_max_runtime_ms: DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS
  }).write(args);
  audit({ tool: "repo_write_agent_reply", repo_id: args.repo_id, paths: [result.written_path], counts: { answers: args.answers.length }, warnings: result.warnings });
  return createSuccessEnvelope(result, `Wrote structured reply for agent run ${result.run_id}, turn ${result.turn_index}.`);
});

export const codexReviewHandler: ToolHandler = async (input, context) => safeTool<CodexReviewInput>("repo_codex_review", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new CodexResultService(new PathSandbox(repo.root), new GitReviewService(repo.root, new OperationsPolicy(repo.operations)), repo.root).review(args);
  audit({ tool: "repo_codex_review", repo_id: args.repo_id, paths: [result.result_json_path, ...(result.legacy_result_path ? [result.legacy_result_path] : [])], counts: result.git_review ? { changed: result.git_review.changed_paths.length } : undefined, warnings: result.warnings });
  return createSuccessEnvelope(result, result.result_found ? `Reviewed Codex result ${result.run_id}.` : `Codex result missing for ${result.run_id}.`, { warnings: result.warnings });
});

export const writeCodexReviewHandler: ToolHandler = async (input, context) => safeTool<CodexReviewWriteInput>("repo_write_codex_review", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new CodexReviewAttestationService(
    repo.root,
    new PathSandbox(repo.root),
    new GitReviewService(repo.root, new OperationsPolicy(repo.operations)),
    new WritePolicy(repo.writes)
  ).write(args);
  audit({ tool: "repo_write_codex_review", repo_id: args.repo_id, paths: result.written_paths.length > 0 ? result.written_paths : [result.review_path], counts: { evidence: args.evidence?.length ?? 0 }, warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked review attestation for ${result.run_id}.` : `Wrote state-bound review attestation for ${result.run_id}.`, { warnings: result.warnings });
});

export const writeIntegrationReviewHandler: ToolHandler = async (input, context) => safeTool<IntegrationReviewWriteInput>("repo_write_integration_review", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new IntegrationReviewService(
    repo.root,
    new PathSandbox(repo.root),
    new OperationsPolicy(repo.operations),
    new WritePolicy(repo.writes)
  ).write(args);
  audit({ tool: "repo_write_integration_review", repo_id: args.repo_id, paths: result.reviewed_paths, counts: { runs: result.run_ids.length, paths: result.path_count }, warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked integration review for ${result.run_ids.length} runs.` : `Wrote integration review for ${result.run_ids.length} runs and ${result.path_count} paths.`, { warnings: result.warnings });
});
