import { ChangePlanService } from "../../services/change-plan-service.js";
import { ContextMapService } from "../../services/context-map-service.js";
import { FailureDiagnoseService } from "../../services/failure-diagnose-service.js";
import { FileReader } from "../../services/file-reader.js";
import { FileWriter } from "../../services/file-writer.js";
import { GitOperationsService } from "../../services/git-operations-service.js";
import { GitReviewService } from "../../services/git-review-service.js";
import { GitService } from "../../services/git-service.js";
import { HandoffService } from "../../services/handoff-service.js";
import { OperationReceiptService } from "../../services/operation-receipt-service.js";
import { OperationsPolicy } from "../../services/operations-policy.js";
import { PathSandbox } from "../../services/path-sandbox.js";
import { PolicyExplainService } from "../../services/policy-explain-service.js";
import { ProjectBriefService } from "../../services/project-brief-service.js";
import { ReadManyService } from "../../services/read-many-service.js";
import { RepoTreeService } from "../../services/repo-tree-service.js";
import { SearchService } from "../../services/search-service.js";
import { SemanticReviewService } from "../../services/semantic-review-service.js";
import { ShipReviewService } from "../../services/ship-review-service.js";
import { SymbolContextService } from "../../services/symbol-context-service.js";
import { ValidationService } from "../../services/validation-service.js";
import { WorkSessionService } from "../../services/work-session-service.js";
import { WriteChangesService } from "../../services/write-changes-service.js";
import { WritePolicy } from "../../services/write-policy.js";
import { createSuccessEnvelope } from "../../runtime/result-envelope.js";
import { audit } from "../../runtime/telemetry.js";
import type { ChangePlanInput } from "../../contracts/change-plan.contract.js";
import type { ContextMapInput } from "../../contracts/context-map.contract.js";
import type { GitRecoverInput, GitStageCommitInput } from "../../contracts/git-operations.contract.js";
import type { GitReviewInput } from "../../contracts/git-review.contract.js";
import type { HandoffInput } from "../../contracts/handoff.contract.js";
import type { LastWriteInput } from "../../contracts/operation-receipt.contract.js";
import type { PolicyExplainInput } from "../../contracts/policy.contract.js";
import type { ProjectBriefInput } from "../../contracts/project.contract.js";
import type { ShipReviewInput, ShipReviewToolInput } from "../../contracts/ship-review.contract.js";
import type { SymbolContextInput } from "../../contracts/symbol-context.contract.js";
import type { ValidateInput } from "../../contracts/validation.contract.js";
import type { CurrentWorkSessionInput, StartWorkSessionInput, UpdateWorkSessionInput } from "../../contracts/work-session.contract.js";
import type { WriteChangesInput, WriteFileInput } from "../../contracts/write.contract.js";
import type { FetchFileOptions } from "../../services/file-reader.js";
import type { SearchOptions } from "../../services/search-service.js";
import type { TreeOptions } from "../../services/repo-tree-service.js";
import { assertExpectedHead, readHeadSha, safeTool, type ToolHandler } from "../handler-support.js";

type RepoInput = { repo_id: string };
type ReadManyInput = RepoInput & {
  paths?: string[];
  include_globs?: string[];
  exclude_globs?: string[];
  max_files?: number;
  max_bytes_per_file?: number;
  max_total_bytes?: number;
  cursor?: string;
};
type GitDiffInput = RepoInput & {
  base?: string;
  compare?: string;
  staged?: boolean;
  unstaged?: boolean;
  paths?: string[];
  max_bytes?: number;
  max_files?: number;
  context_lines?: number;
};

export const listRootsHandler: ToolHandler = async (_input, context) => {
  const repos = context.registry.list();
  return createSuccessEnvelope({ repos }, `${repos.length} approved repositories available.`);
};

export const policyExplainHandler: ToolHandler = async (input, context) => safeTool<PolicyExplainInput>("repo_policy_explain", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = new PolicyExplainService(repo).explain(args);
  audit({ tool: "repo_policy_explain", repo_id: args.repo_id, paths: result.path ? [result.path] : undefined, warnings: [result.read, result.write, result.cleanup].filter((decision) => !decision.allowed).map((decision) => decision.code) });
  return createSuccessEnvelope(result, result.summary);
});

export const lastWriteHandler: ToolHandler = async (input, context) => safeTool<LastWriteInput>("repo_last_write", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new OperationReceiptService(repo.root).readLastWrite(args.repo_id);
  audit({ tool: "repo_last_write", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, result.found ? `Last write receipt found for ${args.repo_id}.` : "No last write receipt found.");
});

export const treeHandler: ToolHandler = async (input, context) => safeTool<TreeOptions & RepoInput>("repo_tree", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new RepoTreeService(new PathSandbox(repo.root)).tree(args);
  audit({ tool: "repo_tree", repo_id: args.repo_id, counts: { entries: result.entries.length }, truncated: result.truncated });
  return createSuccessEnvelope(result, `Returned ${result.entries.length} tree entries.`);
});

export const searchHandler: ToolHandler = async (input, context) => safeTool<SearchOptions & RepoInput>("repo_search", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new SearchService(new PathSandbox(repo.root)).search(args);
  audit({ tool: "repo_search", repo_id: args.repo_id, counts: { results: result.returned_count }, truncated: result.truncated });
  return createSuccessEnvelope(result, `Returned ${result.returned_count} search results.`);
});

export const fetchFileHandler: ToolHandler = async (input, context) => safeTool<FetchFileOptions & RepoInput>("repo_fetch_file", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new FileReader(new PathSandbox(repo.root)).read(args);
  audit({ tool: "repo_fetch_file", repo_id: args.repo_id, paths: [result.path], counts: { bytes: result.size_bytes }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Read ${result.path}.`, { warnings: result.warnings });
});

export const readManyHandler: ToolHandler = async (input, context) => safeTool<ReadManyInput>("repo_read_many", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new ReadManyService(new PathSandbox(repo.root), context.registry.limits).readMany(args);
  audit({ tool: "repo_read_many", repo_id: args.repo_id, paths: result.files.map((file) => file.path), counts: { returned: result.files.length, skipped: result.skipped.length }, truncated: result.truncated });
  return createSuccessEnvelope(result, `Read ${result.files.length} files; skipped ${result.skipped.length}.`);
});

export const contextMapHandler: ToolHandler = async (input, context) => safeTool<ContextMapInput>("repo_context_map", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new ContextMapService(new PathSandbox(repo.root)).map({ goal: args.goal, focus_paths: args.focus_paths, max_files: args.max_files });
  audit({ tool: "repo_context_map", repo_id: args.repo_id, paths: args.focus_paths, counts: { edges: result.import_edges.length, tests: result.affected_tests.length }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Returned context map with ${result.import_edges.length} import edges.`);
});

export const symbolContextHandler: ToolHandler = async (input, context) => safeTool<SymbolContextInput>("repo_symbol_context", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const native = await new SymbolContextService(repo.root, new PathSandbox(repo.root)).analyze(args);
  const provider = context.codeIntelligence
    ? await context.codeIntelligence.enrich(repo, args)
    : { name: "native" as const, status: "native_only" as const, index_available: false, warnings: [] };
  const result = { ...native, provider, warnings: [...new Set([...native.warnings, ...provider.warnings])].sort() };
  audit({ tool: "repo_symbol_context", repo_id: args.repo_id, paths: args.paths, counts: { definitions: result.definitions.length, relations: result.references.length + result.calls.length }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Returned ${result.definitions.length} symbol definitions with ${result.calls.length} call edges.`);
});

export const shipReviewHandler: ToolHandler = async (input, context) => safeTool<ShipReviewInput>("repo_ship_review", input, async (args) => {
  const toolArgs = args as ShipReviewToolInput;
  const repo = context.registry.get(toolArgs.repo_id);
  const sandbox = new PathSandbox(repo.root);
  const result = await new ShipReviewService({
    gitReview: new GitReviewService(repo.root, new OperationsPolicy(repo.operations)),
    semanticReview: new SemanticReviewService(repo.root, sandbox),
    failureDiagnose: new FailureDiagnoseService(repo.root, sandbox, new OperationsPolicy(repo.operations))
  }).review(toolArgs);
  audit({ tool: "repo_ship_review", repo_id: toolArgs.repo_id, paths: result.semantic_review.reviewed_paths, counts: { changed: result.git_review.changed_paths.length, findings: result.semantic_review.findings.length, diagnostics: result.failure_diagnosis?.diagnostics.length ?? 0 }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Ship review is ${result.ship_readiness.status} with ${result.ship_readiness.reasons.length} readiness reasons.`);
});

export const gitStatusHandler: ToolHandler = async (input, context) => safeTool<RepoInput>("repo_git_status", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new GitService(repo.root).status();
  audit({ tool: "repo_git_status", repo_id: args.repo_id, counts: result.counts });
  return createSuccessEnvelope(result, result.clean ? "Repository is clean." : `Repository has ${result.files.length} changed files.`);
});

export const gitDiffHandler: ToolHandler = async (input, context) => safeTool<GitDiffInput>("repo_git_diff", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new GitService(repo.root).diff(args);
  audit({ tool: "repo_git_diff", repo_id: args.repo_id, paths: args.paths, counts: { files: result.files.length }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Returned diff for ${result.files.length} files.`);
});

export const gitReviewHandler: ToolHandler = async (input, context) => safeTool<GitReviewInput>("repo_git_review", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new GitReviewService(repo.root, new OperationsPolicy(repo.operations)).review({
    ...args,
    detail: args.detail ?? "compact"
  });
  audit({ tool: "repo_git_review", repo_id: args.repo_id, counts: { changed: result.changed_paths.length, recommended: result.recommendation.recommended_stage_paths.length }, truncated: result.diff_summary.truncated, warnings: result.recommendation.warnings });
  return createSuccessEnvelope(result, result.clean ? "Repository is clean." : `Reviewed ${result.changed_paths.length} changed paths.`);
});

export const writeStageCommitHandler: ToolHandler = async (input, context) => safeTool<GitStageCommitInput>("repo_write_stage_commit", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new GitOperationsService(repo.root, new OperationsPolicy(repo.operations)).stageCommit(args);
  audit({ tool: "repo_write_stage_commit", repo_id: args.repo_id, paths: result.committed_paths, warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked stage and commit for ${result.committed_paths.length} paths.` : `Staged and committed ${result.committed_paths.length} paths.`);
});

export const writeRecoverHandler: ToolHandler = async (input, context) => safeTool<GitRecoverInput>("repo_write_recover", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new GitOperationsService(repo.root, new OperationsPolicy(repo.operations)).recover(args);
  audit({ tool: "repo_write_recover", repo_id: args.repo_id, paths: [...result.unstaged_paths, ...result.restored_paths, ...result.deleted.map((entry) => entry.path)], warnings: result.warnings });
  const recoveredCount = result.unstaged_paths.length + result.restored_paths.length + result.deleted.length;
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked recovery for ${recoveredCount} paths.` : `Recovered ${recoveredCount} paths.`);
});

export const projectBriefHandler: ToolHandler = async (input, context) => safeTool<ProjectBriefInput>("repo_project_brief", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new ProjectBriefService(repo, new PathSandbox(repo.root)).brief(args);
  audit({ tool: "repo_project_brief", repo_id: args.repo_id, counts: { docs: result.key_docs.length, scripts: result.scripts.length, product_grounded: result.product_brief.status === "configured" ? 1 : 0 }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Returned ${result.product_brief.status} product brief and technical project signals for ${repo.display_name}.`);
});

export const changePlanHandler: ToolHandler = async (input, context) => safeTool<ChangePlanInput>("repo_change_plan", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new ChangePlanService(new PathSandbox(repo.root)).plan({ goal: args.goal, include_globs: args.include_globs, max_files_to_inspect: args.max_files_to_inspect, planning_depth: args.planning_depth });
  audit({ tool: "repo_change_plan", repo_id: args.repo_id, counts: { relevant_files: result.relevant_files.length, steps: result.proposed_steps.length }, warnings: result.warnings });
  return createSuccessEnvelope(result, `Returned change plan with ${result.proposed_steps.length} steps.`);
});

export const validateHandler: ToolHandler = async (input, context) => safeTool<ValidateInput>("repo_validate", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new ValidationService(repo.root, new OperationsPolicy(repo.operations)).validate(args);
  audit({ tool: "repo_validate", repo_id: args.repo_id, counts: result.counts, warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run resolved ${result.commands.length} validation commands.` : `Validation ${result.status}: ${result.counts.passed}/${result.counts.total} commands passed.`, { warnings: result.warnings });
});

export const startWorkSessionHandler: ToolHandler = async (input, context) => safeTool<StartWorkSessionInput>("repo_start_work_session", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new WorkSessionService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes)).start(args);
  audit({ tool: "repo_start_work_session", repo_id: args.repo_id, paths: [result.session_path, result.current_path], warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run prepared work session ${result.work_session_id}.` : `Started work session ${result.work_session_id}.`, { warnings: result.warnings });
});

export const updateWorkSessionHandler: ToolHandler = async (input, context) => safeTool<UpdateWorkSessionInput>("repo_update_work_session", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new WorkSessionService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes)).update(args);
  audit({ tool: "repo_update_work_session", repo_id: args.repo_id, paths: [result.session_path, result.current_path], warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run updated work session ${result.work_session_id}.` : `Updated work session ${result.work_session_id}.`, { warnings: result.warnings });
});

export const currentWorkSessionHandler: ToolHandler = async (input, context) => safeTool<CurrentWorkSessionInput>("repo_current_work_session", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new WorkSessionService(repo.root).current(args);
  audit({ tool: "repo_current_work_session", repo_id: args.repo_id, paths: result.session_path ? [result.session_path] : undefined, warnings: result.warnings });
  const summary = result.found
    ? result.continuity_state === "completed_history"
      ? `Read completed work session ${result.work_session_id} as history.`
      : `Read ${result.continuity_state} work session ${result.work_session_id}.`
    : args.work_session_id
      ? `Work session ${args.work_session_id} was not found.`
      : "No current work session found.";
  return createSuccessEnvelope(result, summary, { warnings: result.warnings });
});

export const writeFileHandler: ToolHandler = async (input, context) => safeTool<WriteFileInput>("repo_write_file", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const headShaBefore = await readHeadSha(repo.root);
  assertExpectedHead(args.expected_head_sha, headShaBefore);
  const result = await new FileWriter(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes)).write(args);
  if (!result.dry_run && result.changed) {
    const headShaAfter = await readHeadSha(repo.root);
    const receipt = await new OperationReceiptService(repo.root).writeLastWrite({
      tool: "repo_write_file",
      repo_id: args.repo_id,
      ...(headShaBefore ? { head_sha_before: headShaBefore } : {}),
      ...(headShaAfter ? { head_sha_after: headShaAfter } : {}),
      touched_paths: [result.path],
      changed_paths: [result.path],
      created_paths: result.created ? [result.path] : [],
      modified_paths: result.created ? [] : [result.path],
      counts: { requested: 1, changed: 1, created: result.created ? 1 : 0, unchanged: 0 },
      summary: result.summary,
      files: [{ path: result.path, action: result.action, changed: result.changed, created: result.created, ...(result.old_sha256 ? { old_sha256: result.old_sha256 } : {}), ...(result.new_sha256 ? { new_sha256: result.new_sha256 } : {}) }],
      rollback_hint: {
        executable: false,
        reason: "First-class rollback is not implemented yet; use reviewed git restore or cleanup workflows.",
        paths: [{ path: result.path, strategy: result.created ? "cleanup_created" : "restore_tracked", reason: result.created ? "Created path can be removed through reviewed cleanup workflow." : "Modified tracked path can be restored through reviewed git restore workflow." }]
      }
    });
    const resultWithReceipt = { ...result, warnings: [...result.warnings, ...receipt.warnings], ...(receipt.operation_receipt ? { operation_receipt: receipt.operation_receipt } : {}) };
    audit({ tool: "repo_write_file", repo_id: args.repo_id, paths: [resultWithReceipt.path], counts: { bytes: resultWithReceipt.bytes_written }, warnings: resultWithReceipt.warnings });
    return createSuccessEnvelope(resultWithReceipt, resultWithReceipt.dry_run ? `Dry run checked write to ${resultWithReceipt.path}.` : `Wrote ${resultWithReceipt.path}.`, { warnings: resultWithReceipt.warnings });
  }
  audit({ tool: "repo_write_file", repo_id: args.repo_id, paths: [result.path], counts: { bytes: result.bytes_written }, warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked write to ${result.path}.` : `Wrote ${result.path}.`, { warnings: result.warnings });
});

export const writeChangesHandler: ToolHandler = async (input, context) => safeTool<WriteChangesInput>("repo_write_changes", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const headShaBefore = await readHeadSha(repo.root);
  assertExpectedHead(args.expected_head_sha, headShaBefore);
  const result = await new WriteChangesService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes)).apply(args);
  if (!result.dry_run && result.changed_paths.length > 0) {
    const headShaAfter = await readHeadSha(repo.root);
    const receipt = await new OperationReceiptService(repo.root).writeLastWrite({
      tool: "repo_write_changes",
      repo_id: args.repo_id,
      ...(headShaBefore ? { head_sha_before: headShaBefore } : {}),
      ...(headShaAfter ? { head_sha_after: headShaAfter } : {}),
      touched_paths: result.files.map((file) => file.path),
      changed_paths: result.changed_paths,
      created_paths: result.files.filter((file) => file.changed && file.created).map((file) => file.path),
      modified_paths: result.files.filter((file) => file.changed && !file.created).map((file) => file.path),
      counts: result.counts,
      summary: result.summary,
      files: result.files.map((file) => ({ path: file.path, action: file.type, changed: file.changed, created: file.created, ...(file.old_sha256 ? { old_sha256: file.old_sha256 } : {}), ...(file.new_sha256 ? { new_sha256: file.new_sha256 } : {}) })),
      rollback_hint: {
        executable: false,
        reason: "First-class rollback is not implemented yet; use reviewed git restore or cleanup workflows.",
        paths: result.files.filter((file) => file.changed).map((file) => ({ path: file.path, strategy: file.created ? "cleanup_created" : "restore_tracked", reason: file.created ? "Created path can be removed through reviewed cleanup workflow." : "Modified tracked path can be restored through reviewed git restore workflow." }))
      }
    });
    const resultWithReceipt = { ...result, warnings: [...result.warnings, ...receipt.warnings], ...(receipt.operation_receipt ? { operation_receipt: receipt.operation_receipt } : {}) };
    audit({ tool: "repo_write_changes", repo_id: args.repo_id, paths: resultWithReceipt.changed_paths, counts: resultWithReceipt.counts, warnings: resultWithReceipt.warnings });
    return createSuccessEnvelope(resultWithReceipt, resultWithReceipt.dry_run ? `Dry run checked ${resultWithReceipt.files.length} changes.` : resultWithReceipt.summary, { warnings: resultWithReceipt.warnings });
  }
  audit({ tool: "repo_write_changes", repo_id: args.repo_id, paths: result.changed_paths, counts: result.counts, warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked ${result.files.length} changes.` : result.summary, { warnings: result.warnings });
});

export const writeHandoffHandler: ToolHandler = async (input, context) => safeTool<HandoffInput>("repo_write_handoff", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new HandoffService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes), new GitService(repo.root)).write(args);
  audit({ tool: "repo_write_handoff", repo_id: args.repo_id, paths: result.current_path ? [result.handoff_path, result.current_path] : [result.handoff_path], warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked handoff ${result.handoff_path}.` : `Wrote handoff ${result.handoff_path}.`, { warnings: result.warnings });
});
