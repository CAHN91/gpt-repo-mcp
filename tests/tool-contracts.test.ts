import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AgentRunsInputSchema, AgentRunsResultSchema } from "../src/contracts/agent-runs.contract.js";
import { AgentReplyInputSchema, AgentReplyResultSchema } from "../src/contracts/agent-reply.contract.js";
import {
  WriteChangesInputSchema,
  WriteChangesResultSchema,
  WriteFileInputSchema,
  WriteFileResultSchema
} from "../src/contracts/write.contract.js";
import {
  GitCommitInputSchema,
  GitCommitResultSchema,
  GitRecoverInputSchema,
  GitRecoverResultSchema,
  GitRestorePathsInputSchema,
  GitRestorePathsResultSchema,
  GitStageCommitInputSchema,
  GitStageCommitResultSchema,
  GitStageInputSchema,
  GitStageResultSchema,
  GitUnstageInputSchema,
  GitUnstageResultSchema
} from "../src/contracts/git-operations.contract.js";
import { CleanupPathsInputSchema, CleanupPathsResultSchema } from "../src/contracts/cleanup.contract.js";
import { CodexReviewInputSchema, CodexReviewResultSchema } from "../src/contracts/codex-task.contract.js";
import { CodexReviewWriteInputSchema, CodexReviewWriteResultSchema } from "../src/contracts/codex-review-attestation.contract.js";
import {
  DelegationPreparedResultV3Schema,
  DelegationTaskV3ToolInputSchema,
  DelegationTaskV3WriteToolInputSchema,
  DelegationWriteResultV3Schema
} from "../src/contracts/delegation-v3.contract.js";
import { DecisionLogInputSchema, DecisionLogResultSchema } from "../src/contracts/decision.contract.js";
import { GitReviewResultSchema } from "../src/contracts/git-review.contract.js";
import { HandoffInputSchema, HandoffResultSchema } from "../src/contracts/handoff.contract.js";
import { LastWriteInputSchema, LastWriteResultSchema } from "../src/contracts/operation-receipt.contract.js";
import { OperationLedgerInputSchema, OperationLedgerResultSchema } from "../src/contracts/operation-ledger.contract.js";
import { PolicyExplainInputSchema, PolicyExplainResultSchema } from "../src/contracts/policy.contract.js";
import { ContextMapInputSchema, ContextMapResultSchema } from "../src/contracts/context-map.contract.js";
import { SymbolContextInputSchema, SymbolContextResultSchema } from "../src/contracts/symbol-context.contract.js";
import { FailureDiagnoseInputSchema, FailureDiagnoseResultSchema } from "../src/contracts/failure-diagnose.contract.js";
import { SemanticReviewInputSchema, SemanticReviewResultSchema } from "../src/contracts/semantic-review.contract.js";
import { ShipReviewInputSchema, ShipReviewResultSchema, ShipReviewToolInputSchema } from "../src/contracts/ship-review.contract.js";
import { PatchsetApplyInputSchema, PatchsetApplyResultSchema, PatchsetPrepareInputSchema, PatchsetPrepareResultSchema, PatchsetReviewInputSchema, PatchsetReviewResultSchema, PatchsetRollbackInputSchema, PatchsetRollbackResultSchema } from "../src/contracts/patchset.contract.js";
import { ValidateInputSchema, ValidateResultSchema } from "../src/contracts/validation.contract.js";
import { CurrentWorkSessionInputSchema, CurrentWorkSessionResultSchema, StartWorkSessionInputSchema, StartWorkSessionResultSchema, UpdateWorkSessionInputSchema, UpdateWorkSessionResultSchema } from "../src/contracts/work-session.contract.js";
import { RepoReaderConfigSchema } from "../src/config/schema.js";
import { nonDestructiveMutationAnnotations, readOnlyAnnotations, safeMutationAnnotations, writeAnnotations } from "../src/tools/annotations.js";
import { toolCatalog } from "../src/tools/catalog.js";
import { CANONICAL_TOOL_ORDER, toolRegistry, toolsForPackage } from "../src/tools/registry.js";
import * as handlerExports from "../src/tools/handlers.js";
import type { ToolDefinition } from "../src/tools/catalog.js";
import type { ToolName } from "../src/tools/contracts.js";
import { toolContracts } from "../src/tools/contracts.js";
import { MUTATING_TOOL_NAMES, isMutatingToolName } from "../src/tools/mutating-tools.js";
import { createAuditEvent } from "../src/runtime/telemetry.js";

function expectFieldDescriptions(fields: Array<[string, { description?: string }]>): void {
  for (const [field, schema] of fields) {
    expect(schema.description, `${field} should have a field description`).toBeTypeOf("string");
    expect(schema.description?.length, `${field} should have a non-empty field description`).toBeGreaterThan(10);
  }
}

function schemaDescription(schema: unknown): string | undefined {
  return (schema as { description?: string }).description;
}

describe("tool catalog contracts", () => {
  test("all tools have required metadata and appropriate annotations", () => {
    expect(toolCatalog.map((tool) => tool.name)).toEqual([
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
    ]);

    for (const tool of toolCatalog) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.startsWith("Use this when")).toBe(true);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      if (isMutatingToolName(tool.name)) {
        expect(tool.annotations).toEqual(
          tool.name === "repo_code_index"
            ? safeMutationAnnotations
            : tool.name === "repo_prepare_patchset"
              ? nonDestructiveMutationAnnotations
              : writeAnnotations
        );
      } else {
        expect(tool.annotations).toEqual(readOnlyAnnotations);
      }
      expect(tool.handler).toBeTypeOf("function");
    }
  });

  test("connector metadata stays materially smaller and contrastive", () => {
    const instructionSourceBytes = readFileSync("src/instructions.ts").byteLength;
    const descriptionSourceBytes = readFileSync("src/tools/descriptions.ts").byteLength;
    const descriptionPayloadBytes = Buffer.byteLength(toolCatalog.map((tool) => tool.description).join(" "), "utf8");

    expect(instructionSourceBytes).toBeLessThan(6_000);
    expect(descriptionSourceBytes).toBeLessThan(8_500);
    expect(descriptionPayloadBytes).toBeLessThan(7_500);
    expect(instructionSourceBytes).toBeLessThan(Math.floor(15_644 * 0.4));
    expect(descriptionSourceBytes).toBeLessThan(Math.floor(16_819 * 0.5));

    const description = (name: string) => toolCatalog.find((tool) => tool.name === name)?.description ?? "";
    expect(description("repo_context_map")).toContain("file-level impact");
    expect(description("repo_context_map")).toContain("repo_symbol_context");
    expect(description("repo_symbol_context")).toContain("symbol-level evidence");
    expect(description("repo_git_diff")).toContain("raw Git diff");
    expect(description("repo_git_review")).toContain("planning commit and recovery");
    expect(description("repo_ship_review")).toContain("combined final readiness");
    expect(description("repo_write_stage")).toContain("separately");
    expect(description("repo_write_stage_commit")).toContain("canonical stage-and-commit payload");
    expect(description("repo_prepare_codex_task")).toContain("previewing");
    expect(description("repo_write_codex_task")).toContain("durable Codex");
  });

  test("mutating tools use central contracts and annotations", () => {
    expect(MUTATING_TOOL_NAMES).toEqual([
      "repo_code_index",
      "repo_git_restore_paths",
      "repo_write_stage",
      "repo_write_unstage",
      "repo_write_commit",
      "repo_write_stage_commit",
      "repo_write_recover",
      "repo_cleanup_paths",
      "repo_write_codex_task",
      "repo_write_agent_reply",
      "repo_write_codex_review",
      "repo_write_integration_review",
      "repo_prepare_patchset",
      "repo_apply_patchset",
      "repo_rollback_patchset",
      "repo_validate",
      "repo_start_work_session",
      "repo_update_work_session",
      "repo_write_file",
      "repo_write_changes",
      "repo_write_handoff"
    ]);
    expect(MUTATING_TOOL_NAMES).toEqual(toolCatalog
      .filter((tool) => tool.annotations.readOnlyHint === false)
      .map((tool) => tool.name));
    const writeFile = toolCatalog.find((tool) => tool.name === "repo_write_file");
    const policyExplain = toolCatalog.find((tool) => tool.name === "repo_policy_explain");
    const prepareCodexTask = toolCatalog.find((tool) => tool.name === "repo_prepare_codex_task");
    const writeCodexTask = toolCatalog.find((tool) => tool.name === "repo_write_codex_task");
    const agentRuns = toolCatalog.find((tool) => tool.name === "repo_agent_runs");
    const writeAgentReply = toolCatalog.find((tool) => tool.name === "repo_write_agent_reply");
    const codexReview = toolCatalog.find((tool) => tool.name === "repo_codex_review");
    const writeCodexReview = toolCatalog.find((tool) => tool.name === "repo_write_codex_review");
    const writeChanges = toolCatalog.find((tool) => tool.name === "repo_write_changes");
    const writeHandoff = toolCatalog.find((tool) => tool.name === "repo_write_handoff");
    const stageCommit = toolCatalog.find((tool) => tool.name === "repo_write_stage_commit");
    const recover = toolCatalog.find((tool) => tool.name === "repo_write_recover");
    const validate = toolCatalog.find((tool) => tool.name === "repo_validate");
    const startWorkSession = toolCatalog.find((tool) => tool.name === "repo_start_work_session");
    const updateWorkSession = toolCatalog.find((tool) => tool.name === "repo_update_work_session");
    const currentWorkSession = toolCatalog.find((tool) => tool.name === "repo_current_work_session");
    const lastWrite = toolCatalog.find((tool) => tool.name === "repo_last_write");
    const decisionMemory = toolCatalog.find((tool) => tool.name === "repo_decision_memory");
    const contextMap = toolCatalog.find((tool) => tool.name === "repo_context_map");
    const symbolContext = toolCatalog.find((tool) => tool.name === "repo_symbol_context");
    const failureDiagnose = toolCatalog.find((tool) => tool.name === "repo_failure_diagnose");
    const semanticReview = toolCatalog.find((tool) => tool.name === "repo_semantic_review");
    const shipReview = toolCatalog.find((tool) => tool.name === "repo_ship_review");

    expect(policyExplain).toBeDefined();
    expect(policyExplain?.inputSchema).toBe(PolicyExplainInputSchema);
    expect(policyExplain?.outputSchema).toBe(PolicyExplainResultSchema);
    expect(policyExplain?.annotations).toEqual(readOnlyAnnotations);
    expect(prepareCodexTask).toBeDefined();
    expect(prepareCodexTask?.inputSchema).toBe(DelegationTaskV3ToolInputSchema);
    expect(prepareCodexTask?.outputSchema).toBe(DelegationPreparedResultV3Schema);
    expect(prepareCodexTask?.annotations).toEqual(readOnlyAnnotations);
    expect(writeCodexTask).toBeDefined();
    expect(writeCodexTask?.inputSchema).toBe(DelegationTaskV3WriteToolInputSchema);
    expect(writeCodexTask?.outputSchema).toBe(DelegationWriteResultV3Schema);
    expect(writeCodexTask?.annotations).toEqual(writeAnnotations);
    expect(agentRuns).toBeDefined();
    expect(agentRuns?.inputSchema).toBe(AgentRunsInputSchema);
    expect(agentRuns?.outputSchema).toBe(AgentRunsResultSchema);
    expect(agentRuns?.annotations).toEqual(readOnlyAnnotations);
    expect(writeAgentReply).toBeDefined();
    expect(writeAgentReply?.inputSchema).toBe(AgentReplyInputSchema);
    expect(writeAgentReply?.outputSchema).toBe(AgentReplyResultSchema);
    expect(writeAgentReply?.annotations).toEqual(writeAnnotations);
    expect(codexReview).toBeDefined();
    expect(codexReview?.inputSchema).toBe(CodexReviewInputSchema);
    expect(codexReview?.outputSchema).toBe(CodexReviewResultSchema);
    expect(codexReview?.annotations).toEqual(readOnlyAnnotations);
    expect(writeCodexReview).toBeDefined();
    expect(writeCodexReview?.inputSchema).toBe(CodexReviewWriteInputSchema);
    expect(writeCodexReview?.outputSchema).toBe(CodexReviewWriteResultSchema);
    expect(writeCodexReview?.annotations).toEqual(writeAnnotations);
    expect(lastWrite).toBeDefined();
    expect(lastWrite?.inputSchema).toBe(LastWriteInputSchema);
    expect(lastWrite?.outputSchema).toBe(LastWriteResultSchema);
    expect(lastWrite?.annotations).toEqual(readOnlyAnnotations);
    expect(decisionMemory).toBeDefined();
    expect(decisionMemory?.inputSchema).toBe(DecisionLogInputSchema);
    expect(decisionMemory?.outputSchema).toBe(DecisionLogResultSchema);
    expect(decisionMemory?.annotations).toEqual(readOnlyAnnotations);
    expect(contextMap).toBeDefined();
    expect(contextMap?.inputSchema).toBe(ContextMapInputSchema);
    expect(contextMap?.outputSchema).toBe(ContextMapResultSchema);
    expect(contextMap?.annotations).toEqual(readOnlyAnnotations);
    expect(symbolContext).toBeDefined();
    expect(symbolContext?.inputSchema).toBe(SymbolContextInputSchema);
    expect(symbolContext?.outputSchema).toBe(SymbolContextResultSchema);
    expect(symbolContext?.annotations).toEqual(readOnlyAnnotations);
    expect(failureDiagnose).toBeDefined();
    expect(failureDiagnose?.inputSchema).toBe(FailureDiagnoseInputSchema);
    expect(failureDiagnose?.outputSchema).toBe(FailureDiagnoseResultSchema);
    expect(failureDiagnose?.annotations).toEqual(readOnlyAnnotations);
    expect(semanticReview).toBeDefined();
    expect(semanticReview?.inputSchema).toBe(SemanticReviewInputSchema);
    expect(semanticReview?.outputSchema).toBe(SemanticReviewResultSchema);
    expect(semanticReview?.annotations).toEqual(readOnlyAnnotations);
    expect(shipReview).toBeDefined();
    expect(ShipReviewInputSchema).toBe(SemanticReviewInputSchema);
    expect(shipReview?.inputSchema).toBe(ShipReviewToolInputSchema);
    expect(shipReview?.outputSchema).toBe(ShipReviewResultSchema);
    expect(shipReview?.annotations).toEqual(readOnlyAnnotations);
    expect(toolCatalog.some((tool) => (tool.name as string) === "repo_decision_log")).toBe(false);
    expect((toolContracts as Record<string, unknown>).repo_decision_log).toBeUndefined();
    expect(toolCatalog.some((tool) => (tool.name as string) === "repo_plan_review")).toBe(false);
    expect((toolContracts as Record<string, unknown>).repo_plan_review).toBeUndefined();
    for (const removedTool of ["repo_git_stage", "repo_git_unstage", "repo_git_commit", "repo_next_action"]) {
      expect(toolCatalog.some((tool) => (tool.name as string) === removedTool)).toBe(false);
      expect((toolContracts as Record<string, unknown>)[removedTool]).toBeUndefined();
    }
    expect(writeFile).toBeDefined();
    expect(writeFile?.inputSchema).toBe(WriteFileInputSchema);
    expect(writeFile?.outputSchema).toBe(WriteFileResultSchema);
    expect(writeFile?.annotations).toEqual(writeAnnotations);
    expect(writeChanges).toBeDefined();
    expect(writeChanges?.inputSchema).toBe(WriteChangesInputSchema);
    expect(writeChanges?.outputSchema).toBe(WriteChangesResultSchema);
    expect(writeChanges?.annotations).toEqual(writeAnnotations);
    expect(writeHandoff).toBeDefined();
    expect(writeHandoff?.inputSchema).toBe(HandoffInputSchema);
    expect(writeHandoff?.outputSchema).toBe(HandoffResultSchema);
    expect(writeHandoff?.annotations).toEqual(writeAnnotations);
    expect(stageCommit).toBeDefined();
    expect(stageCommit?.inputSchema).toBe(GitStageCommitInputSchema);
    expect(stageCommit?.outputSchema).toBe(GitStageCommitResultSchema);
    expect(stageCommit?.annotations).toEqual(writeAnnotations);
    expect(recover).toBeDefined();
    expect(recover?.inputSchema).toBe(GitRecoverInputSchema);
    expect(recover?.outputSchema).toBe(GitRecoverResultSchema);
    expect(recover?.annotations).toEqual(writeAnnotations);
    expect(validate).toBeDefined();
    expect(validate?.inputSchema).toBe(ValidateInputSchema);
    expect(validate?.outputSchema).toBe(ValidateResultSchema);
    expect(validate?.annotations).toEqual(writeAnnotations);
    expect(startWorkSession).toBeDefined();
    expect(startWorkSession?.inputSchema).toBe(StartWorkSessionInputSchema);
    expect(startWorkSession?.outputSchema).toBe(StartWorkSessionResultSchema);
    expect(startWorkSession?.annotations).toEqual(writeAnnotations);
    expect(updateWorkSession).toBeDefined();
    expect(updateWorkSession?.inputSchema).toBe(UpdateWorkSessionInputSchema);
    expect(updateWorkSession?.outputSchema).toBe(UpdateWorkSessionResultSchema);
    expect(updateWorkSession?.annotations).toEqual(writeAnnotations);
    expect(currentWorkSession).toBeDefined();
    expect(currentWorkSession?.inputSchema).toBe(CurrentWorkSessionInputSchema);
    expect(currentWorkSession?.outputSchema).toBe(CurrentWorkSessionResultSchema);
    expect(currentWorkSession?.annotations).toEqual(readOnlyAnnotations);
    const restorePaths = toolCatalog.find((tool) => tool.name === "repo_git_restore_paths");
    expect(restorePaths).toBeDefined();
    expect(restorePaths?.inputSchema).toBe(GitRestorePathsInputSchema);
    expect(restorePaths?.outputSchema).toBe(GitRestorePathsResultSchema);
    expect(restorePaths?.annotations).toEqual(writeAnnotations);

    expect(isMutatingToolName("repo_git_review")).toBe(false);
    expect(isMutatingToolName("repo_last_write")).toBe(false);
  });

  test("internal registry composes exact packages without changing the canonical surface", () => {
    expect(toolRegistry).toBe(toolCatalog);
    expect(toolRegistry.map((tool) => tool.name)).toEqual(CANONICAL_TOOL_ORDER);
    expect(new Set(CANONICAL_TOOL_ORDER).size).toBe(46);
    expect([...CANONICAL_TOOL_ORDER].sort()).toEqual(Object.keys(toolContracts).sort());

    expect(toolsForPackage("developer").map((tool) => tool.name)).toEqual([
      "repo_list_roots",
      "repo_policy_explain",
      "repo_last_write",
      "repo_tree",
      "repo_search",
      "repo_fetch_file",
      "repo_read_many",
      "repo_context_map",
      "repo_symbol_context",
      "repo_ship_review",
      "repo_git_status",
      "repo_git_diff",
      "repo_git_review",
      "repo_write_stage_commit",
      "repo_write_recover",
      "repo_project_brief",
      "repo_change_plan",
      "repo_validate",
      "repo_start_work_session",
      "repo_update_work_session",
      "repo_current_work_session",
      "repo_write_file",
      "repo_write_changes",
      "repo_write_handoff"
    ]);
    expect(toolsForPackage("delegation")).toHaveLength(7);
    expect(toolsForPackage("patchsets")).toHaveLength(4);
    expect(toolsForPackage("advanced_operations")).toHaveLength(6);
    expect(toolsForPackage("diagnostics_and_discovery")).toHaveLength(4);
    expect(toolsForPackage("code_index")).toHaveLength(1);

    for (const tool of toolRegistry) {
      expect(tool.tier).toBe(tool.package === "developer" ? "default" : "specialist");
      expect(tool.requiredCapabilities).toEqual(tool.name === "repo_code_index" ? ["code_intelligence"] : []);
    }
  });

  test("public delegation tools accept v3 tasks and reject removed v2 creation fields", () => {
    const common = {
      repo_id: "fixture",
      title: "Product-grounded delegation",
      assignment: "Create a coherent outcome without prescribing every internal implementation step.",
      outcome: {
        beneficiary: "Repository operator",
        current_problem: "Repeated technical tasks can lose the intended product outcome.",
        desired_outcome: "The implementation remains product-aware and complete.",
        why_now: "New task creation is being cut over to Delegation v3."
      },
      starting_points: ["src/**"],
      authorization_scope: ["src/**", "tests/**"],
      forbidden_paths: [],
      hard_constraints: ["Preserve repository safety boundaries."],
      must_preserve: ["Historical v1 and v2 runs remain reviewable."],
      explicit_exclusions: ["Do not add arbitrary shell execution."],
      technical_acceptance_criteria: ["Typecheck and tests pass."],
      runner: { mode: "manual" as const }
    };

    expect(DelegationTaskV3ToolInputSchema.safeParse({
      ...common,
      task_kind: "product_slice",
      product_alignment: {
        primary_user_id: "repo-operator",
        job_ids: ["delegate-coherent-work"],
        user_problem: "The operator must repeatedly supervise implementation details.",
        product_goal: "Preserve product intent while delegating coherent work.",
        additional_must_not_become: [],
        product_acceptance_criteria: ["The user and product outcome remain explicit."]
      }
    }).success).toBe(true);
    expect(DelegationTaskV3ToolInputSchema.safeParse({
      ...common,
      task_kind: "technical_infrastructure",
      technical_context: { enabling_value: "Give delegation services one product-aware contract." }
    }).success).toBe(true);
    expect(DelegationTaskV3ToolInputSchema.safeParse({
      ...common,
      task_kind: "security_or_migration",
      security_context: {
        protected_contract: "Prompt and manifest identity remain bound.",
        failure_risk: "A compatibility fallback could write an unsafe task."
      }
    }).success).toBe(true);

    for (const legacy of [
      { objective: "legacy" },
      { context_summary: "legacy" },
      { inspect_first: ["src/app.ts"] },
      { allowed_paths: ["src/**"] },
      { implementation_scope: { include: ["legacy"] } },
      { acceptance_criteria: ["legacy"] },
      { verification_commands: ["npm test"] },
      { parent_run_id: "2026-01-01T000000Z-parent" },
      { include_prompt: true }
    ]) {
      expect(DelegationTaskV3WriteToolInputSchema.safeParse({
        ...common,
        task_kind: "technical_infrastructure",
        technical_context: { enabling_value: "Enable coherent delegation." },
        ...legacy
      }).success).toBe(false);
    }
  });

  test("v3 task service does not import legacy task or renderer implementations", () => {
    const source = readFileSync("src/services/delegation-v3-task-service.ts", "utf8");
    expect(source).not.toContain("codex-task-service");
    expect(source).not.toContain("codex-task-renderer");
    expect(source).not.toContain("legacy/codex-v2");
  });

  test("handoff intent is routed to repo_write_handoff description only", () => {
    const writeFile = toolCatalog.find((tool) => tool.name === "repo_write_file");
    const writeChanges = toolCatalog.find((tool) => tool.name === "repo_write_changes");
    const writeHandoff = toolCatalog.find((tool) => tool.name === "repo_write_handoff");
    const handoffTerms = /handoff|handoffs|resume note|session handoff/i;

    expect(writeFile?.description).not.toMatch(handoffTerms);
    expect(writeChanges?.description).not.toMatch(handoffTerms);

    expect(writeHandoff?.description).toContain("skapa handoff");
    expect(writeHandoff?.description).toContain("create handoff");
    expect(writeHandoff?.description).toContain("skriv handoff");
    expect(writeHandoff?.description).toContain("session handoff");
    expect(writeHandoff?.description).toContain("resume note");
    expect(writeHandoff?.description).toContain("local-only ChatGPT handoff");
    expect(writeHandoff?.description).toContain("current.local.md");
    expect(writeHandoff?.description).toContain(".chatgpt/handoffs/*.local.md");
  });

  test("receipt files are ignored by git", () => {
    const gitignore = readFileSync(".gitignore", "utf8");

    expect(gitignore).toContain(".chatgpt/operations/*.json");
  });

  test("repo_git_review is read-only and does not expose no-op diff hunk input", () => {
    const reviewTool = toolCatalog.find((tool) => tool.name === "repo_git_review");

    expect(reviewTool?.annotations).toEqual(readOnlyAnnotations);
    expect(Object.keys(reviewTool?.inputSchema.shape ?? {}).sort()).toEqual([
      "detail",
      "max_files",
      "mode",
      "paths",
      "repo_id"
    ]);
  });

  test("repo_git_review audit metadata omits changed path lists", () => {
    const event = createAuditEvent({
      tool: "repo_git_review",
      repo_id: "fixture",
      counts: { changed: 2, recommended: 1 },
      truncated: false,
      warnings: []
    });

    expect(event).toEqual({
      tool: "repo_git_review",
      repo_id: "fixture",
      counts: { changed: 2, recommended: 1 },
      truncated: false,
      warnings: []
    });
    expect("paths" in event).toBe(false);
  });

  test("mutating tool schemas describe every input and output field", () => {
    expectFieldDescriptions([
      ["repo_last_write.repo_id", LastWriteInputSchema.shape.repo_id],
      ["repo_last_write.ok", LastWriteResultSchema.shape.ok],
      ["repo_last_write.found", LastWriteResultSchema.shape.found],
      ["repo_last_write.receipt", LastWriteResultSchema.shape.receipt],
      ["repo_last_write.next_tool_payloads", LastWriteResultSchema.shape.next_tool_payloads],
      ["repo_last_write.warnings", LastWriteResultSchema.shape.warnings],
      ["repo_operation_ledger.repo_id", OperationLedgerInputSchema.shape.repo_id],
      ["repo_operation_ledger.limit", OperationLedgerInputSchema.shape.limit],
      ["repo_operation_ledger.cursor", OperationLedgerInputSchema.shape.cursor],
      ["repo_operation_ledger.after_operation_id", OperationLedgerInputSchema.shape.after_operation_id],
      ["repo_operation_ledger.ok", OperationLedgerResultSchema.shape.ok],
      ["repo_operation_ledger.repo_id", OperationLedgerResultSchema.shape.repo_id],
      ["repo_operation_ledger.events", OperationLedgerResultSchema.shape.events],
      ["repo_operation_ledger.next_cursor", OperationLedgerResultSchema.shape.next_cursor],
      ["repo_operation_ledger.warnings", OperationLedgerResultSchema.shape.warnings],
      ["repo_write_file.repo_id", WriteFileInputSchema.shape.repo_id],
      ["repo_write_file.path", WriteFileInputSchema.shape.path],
      ["repo_write_file.action", WriteFileInputSchema.shape.action],
      ["repo_write_file.content", WriteFileInputSchema.shape.content],
      ["repo_write_file.find", WriteFileInputSchema.shape.find],
      ["repo_write_file.replace", WriteFileInputSchema.shape.replace],
      ["repo_write_file.create_dirs", WriteFileInputSchema.shape.create_dirs],
      ["repo_write_file.dry_run", WriteFileInputSchema.shape.dry_run],
      ["repo_write_file.expected_old_sha256", WriteFileInputSchema.shape.expected_old_sha256],
      ["repo_write_file.expected_missing", WriteFileInputSchema.shape.expected_missing],
      ["repo_write_file.expected_head_sha", WriteFileInputSchema.shape.expected_head_sha],
      ["repo_write_file.reason", WriteFileInputSchema.shape.reason],
      ["repo_write_file.ok", WriteFileResultSchema.shape.ok],
      ["repo_write_file.path", WriteFileResultSchema.shape.path],
      ["repo_write_file.action", WriteFileResultSchema.shape.action],
      ["repo_write_file.dry_run", WriteFileResultSchema.shape.dry_run],
      ["repo_write_file.changed", WriteFileResultSchema.shape.changed],
      ["repo_write_file.created", WriteFileResultSchema.shape.created],
      ["repo_write_file.bytes_written", WriteFileResultSchema.shape.bytes_written],
      ["repo_write_file.old_sha256", WriteFileResultSchema.shape.old_sha256],
      ["repo_write_file.new_sha256", WriteFileResultSchema.shape.new_sha256],
      ["repo_write_file.summary", WriteFileResultSchema.shape.summary],
      ["repo_write_file.warnings", WriteFileResultSchema.shape.warnings],
      ["repo_write_file.operation_receipt", WriteFileResultSchema.shape.operation_receipt]
    ]);

    expectFieldDescriptions([
      ["repo_prepare_patchset.repo_id", PatchsetPrepareInputSchema.shape.repo_id],
      ["repo_prepare_patchset.intent", PatchsetPrepareInputSchema.shape.intent],
      ["repo_prepare_patchset.base_head_sha", PatchsetPrepareInputSchema.shape.base_head_sha],
      ["repo_prepare_patchset.files", PatchsetPrepareInputSchema.shape.files],
      ["repo_prepare_patchset.ok", PatchsetPrepareResultSchema.shape.ok],
      ["repo_prepare_patchset.patchset_id", PatchsetPrepareResultSchema.shape.patchset_id],
      ["repo_prepare_patchset.manifest_path", PatchsetPrepareResultSchema.shape.manifest_path],
      ["repo_apply_patchset.repo_id", PatchsetApplyInputSchema.shape.repo_id],
      ["repo_apply_patchset.patchset_id", PatchsetApplyInputSchema.shape.patchset_id],
      ["repo_apply_patchset.expected_head_sha", PatchsetApplyInputSchema.shape.expected_head_sha],
      ["repo_apply_patchset.ok", PatchsetApplyResultSchema.shape.ok],
      ["repo_apply_patchset.operation_id", PatchsetApplyResultSchema.shape.operation_id],
      ["repo_review_patchset.repo_id", PatchsetReviewInputSchema.shape.repo_id],
      ["repo_review_patchset.patchset_id", PatchsetReviewInputSchema.shape.patchset_id],
      ["repo_review_patchset.ok", PatchsetReviewResultSchema.shape.ok],
      ["repo_review_patchset.git_review", PatchsetReviewResultSchema.shape.git_review],
      ["repo_review_patchset.rolled_back", PatchsetReviewResultSchema.shape.rolled_back],
      ["repo_rollback_patchset.repo_id", PatchsetRollbackInputSchema.shape.repo_id],
      ["repo_rollback_patchset.patchset_id", PatchsetRollbackInputSchema.shape.patchset_id],
      ["repo_rollback_patchset.expected_head_sha", PatchsetRollbackInputSchema.shape.expected_head_sha],
      ["repo_rollback_patchset.dry_run", PatchsetRollbackInputSchema.shape.dry_run],
      ["repo_rollback_patchset.ok", PatchsetRollbackResultSchema.shape.ok],
      ["repo_rollback_patchset.restored_paths", PatchsetRollbackResultSchema.shape.restored_paths],
      ["repo_rollback_patchset.deleted_paths", PatchsetRollbackResultSchema.shape.deleted_paths],
      ["repo_rollback_patchset.operation_receipt", PatchsetRollbackResultSchema.shape.operation_receipt],
      ["repo_validate.repo_id", ValidateInputSchema.shape.repo_id],
      ["repo_validate.profile", ValidateInputSchema.shape.profile],
      ["repo_validate.dry_run", ValidateInputSchema.shape.dry_run],
      ["repo_validate.timeout_ms", ValidateInputSchema.shape.timeout_ms],
      ["repo_validate.ok", ValidateResultSchema.shape.ok],
      ["repo_validate.status", ValidateResultSchema.shape.status],
      ["repo_validate.commands", ValidateResultSchema.shape.commands],
      ["repo_validate.counts", ValidateResultSchema.shape.counts],
      ["repo_validate.warnings", ValidateResultSchema.shape.warnings],
      ["repo_start_work_session.repo_id", StartWorkSessionInputSchema.shape.repo_id],
      ["repo_start_work_session.title", StartWorkSessionInputSchema.shape.title],
      ["repo_start_work_session.objective", StartWorkSessionInputSchema.shape.objective],
      ["repo_start_work_session.next_action", StartWorkSessionInputSchema.shape.next_action],
      ["repo_start_work_session.dry_run", StartWorkSessionInputSchema.shape.dry_run],
      ["repo_start_work_session.ok", StartWorkSessionResultSchema.shape.ok],
      ["repo_start_work_session.session", StartWorkSessionResultSchema.shape.session],
      ["repo_start_work_session.next_tool_payloads", StartWorkSessionResultSchema.shape.next_tool_payloads],
      ["repo_update_work_session.repo_id", UpdateWorkSessionInputSchema.shape.repo_id],
      ["repo_update_work_session.work_session_id", UpdateWorkSessionInputSchema.shape.work_session_id],
      ["repo_update_work_session.next_action", UpdateWorkSessionInputSchema.shape.next_action],
      ["repo_update_work_session.ok", UpdateWorkSessionResultSchema.shape.ok],
      ["repo_update_work_session.session", UpdateWorkSessionResultSchema.shape.session],
      ["repo_current_work_session.repo_id", CurrentWorkSessionInputSchema.shape.repo_id],
      ["repo_current_work_session.work_session_id", CurrentWorkSessionInputSchema.shape.work_session_id],
      ["repo_current_work_session.ok", CurrentWorkSessionResultSchema.shape.ok],
      ["repo_current_work_session.lookup_source", CurrentWorkSessionResultSchema.shape.lookup_source],
      ["repo_current_work_session.found", CurrentWorkSessionResultSchema.shape.found],
      ["repo_current_work_session.continuity_state", CurrentWorkSessionResultSchema.shape.continuity_state],
      ["repo_current_work_session.session", CurrentWorkSessionResultSchema.shape.session],
      ["repo_current_work_session.warnings", CurrentWorkSessionResultSchema.shape.warnings]
    ]);

    expectFieldDescriptions([
      ["repo_write_changes.repo_id", WriteChangesInputSchema.shape.repo_id],
      ["repo_write_changes.changes", WriteChangesInputSchema.shape.changes],
      ["repo_write_changes.dry_run", WriteChangesInputSchema.shape.dry_run],
      ["repo_write_changes.expected_head_sha", WriteChangesInputSchema.shape.expected_head_sha],
      ["repo_write_changes.reason", WriteChangesInputSchema.shape.reason],
      ["repo_write_changes.ok", WriteChangesResultSchema.shape.ok],
      ["repo_write_changes.dry_run", WriteChangesResultSchema.shape.dry_run],
      ["repo_write_changes.changed_paths", WriteChangesResultSchema.shape.changed_paths],
      ["repo_write_changes.files", WriteChangesResultSchema.shape.files],
      ["repo_write_changes.files.path", WriteChangesResultSchema.shape.files.element.shape.path],
      ["repo_write_changes.files.type", WriteChangesResultSchema.shape.files.element.shape.type],
      ["repo_write_changes.files.changed", WriteChangesResultSchema.shape.files.element.shape.changed],
      ["repo_write_changes.files.created", WriteChangesResultSchema.shape.files.element.shape.created],
      ["repo_write_changes.files.bytes_written", WriteChangesResultSchema.shape.files.element.shape.bytes_written],
      ["repo_write_changes.files.old_sha256", WriteChangesResultSchema.shape.files.element.shape.old_sha256],
      ["repo_write_changes.files.new_sha256", WriteChangesResultSchema.shape.files.element.shape.new_sha256],
      ["repo_write_changes.files.summary", WriteChangesResultSchema.shape.files.element.shape.summary],
      ["repo_write_changes.counts", WriteChangesResultSchema.shape.counts],
      ["repo_write_changes.counts.requested", WriteChangesResultSchema.shape.counts.shape.requested],
      ["repo_write_changes.counts.changed", WriteChangesResultSchema.shape.counts.shape.changed],
      ["repo_write_changes.counts.created", WriteChangesResultSchema.shape.counts.shape.created],
      ["repo_write_changes.counts.unchanged", WriteChangesResultSchema.shape.counts.shape.unchanged],
      ["repo_write_changes.summary", WriteChangesResultSchema.shape.summary],
      ["repo_write_changes.warnings", WriteChangesResultSchema.shape.warnings],
      ["repo_write_changes.next_steps", WriteChangesResultSchema.shape.next_steps],
      ["repo_write_changes.operation_receipt", WriteChangesResultSchema.shape.operation_receipt]
    ]);

    expectFieldDescriptions([
      ["repo_write_handoff.repo_id", HandoffInputSchema.shape.repo_id],
      ["repo_write_handoff.title", HandoffInputSchema.shape.title],
      ["repo_write_handoff.current_track", HandoffInputSchema.shape.current_track],
      ["repo_write_handoff.current_state", HandoffInputSchema.shape.current_state],
      ["repo_write_handoff.why", HandoffInputSchema.shape.why],
      ["repo_write_handoff.completed_work", HandoffInputSchema.shape.completed_work],
      ["repo_write_handoff.decisions", HandoffInputSchema.shape.decisions],
      ["repo_write_handoff.workflow", HandoffInputSchema.shape.workflow],
      ["repo_write_handoff.constraints", HandoffInputSchema.shape.constraints],
      ["repo_write_handoff.next_steps", HandoffInputSchema.shape.next_steps],
      ["repo_write_handoff.important_files", HandoffInputSchema.shape.important_files],
      ["repo_write_handoff.risks", HandoffInputSchema.shape.risks],
      ["repo_write_handoff.open_questions", HandoffInputSchema.shape.open_questions],
      ["repo_write_handoff.update_current", HandoffInputSchema.shape.update_current],
      ["repo_write_handoff.dry_run", HandoffInputSchema.shape.dry_run],
      ["repo_write_handoff.ok", HandoffResultSchema.shape.ok],
      ["repo_write_handoff.dry_run", HandoffResultSchema.shape.dry_run],
      ["repo_write_handoff.handoff_path", HandoffResultSchema.shape.handoff_path],
      ["repo_write_handoff.current_path", HandoffResultSchema.shape.current_path],
      ["repo_write_handoff.updated_current", HandoffResultSchema.shape.updated_current],
      ["repo_write_handoff.branch", HandoffResultSchema.shape.branch],
      ["repo_write_handoff.head_sha", HandoffResultSchema.shape.head_sha],
      ["repo_write_handoff.clean", HandoffResultSchema.shape.clean],
      ["repo_write_handoff.startup_prompt", HandoffResultSchema.shape.startup_prompt],
      ["repo_write_handoff.current_next_step", HandoffResultSchema.shape.current_next_step],
      ["repo_write_handoff.warnings", HandoffResultSchema.shape.warnings]
    ]);

    expectFieldDescriptions([
      ["repo_write_stage.repo_id", GitStageInputSchema.shape.repo_id],
      ["repo_write_stage.paths", GitStageInputSchema.shape.paths],
      ["repo_write_stage.expected_head_sha", GitStageInputSchema.shape.expected_head_sha],
      ["repo_write_stage.dry_run", GitStageInputSchema.shape.dry_run],
      ["repo_write_stage.reason", GitStageInputSchema.shape.reason],
      ["repo_write_stage.ok", GitStageResultSchema.shape.ok],
      ["repo_write_stage.dry_run", GitStageResultSchema.shape.dry_run],
      ["repo_write_stage.head_sha", GitStageResultSchema.shape.head_sha],
      ["repo_write_stage.staged_paths", GitStageResultSchema.shape.staged_paths],
      ["repo_write_stage.skipped", GitStageResultSchema.shape.skipped],
      ["repo_write_stage.skipped.path", GitStageResultSchema.shape.skipped.element.shape.path],
      ["repo_write_stage.skipped.reason", GitStageResultSchema.shape.skipped.element.shape.reason],
      ["repo_write_stage.warnings", GitStageResultSchema.shape.warnings]
    ]);

    expectFieldDescriptions([
      ["repo_write_unstage.repo_id", GitUnstageInputSchema.shape.repo_id],
      ["repo_write_unstage.paths", GitUnstageInputSchema.shape.paths],
      ["repo_write_unstage.expected_head_sha", GitUnstageInputSchema.shape.expected_head_sha],
      ["repo_write_unstage.dry_run", GitUnstageInputSchema.shape.dry_run],
      ["repo_write_unstage.reason", GitUnstageInputSchema.shape.reason],
      ["repo_write_unstage.ok", GitUnstageResultSchema.shape.ok],
      ["repo_write_unstage.dry_run", GitUnstageResultSchema.shape.dry_run],
      ["repo_write_unstage.head_sha", GitUnstageResultSchema.shape.head_sha],
      ["repo_write_unstage.unstaged_paths", GitUnstageResultSchema.shape.unstaged_paths],
      ["repo_write_unstage.skipped", GitUnstageResultSchema.shape.skipped],
      ["repo_write_unstage.skipped.path", GitUnstageResultSchema.shape.skipped.element.shape.path],
      ["repo_write_unstage.skipped.reason", GitUnstageResultSchema.shape.skipped.element.shape.reason],
      ["repo_write_unstage.warnings", GitUnstageResultSchema.shape.warnings]
    ]);

    expectFieldDescriptions([
      ["repo_git_restore_paths.repo_id", GitRestorePathsInputSchema.shape.repo_id],
      ["repo_git_restore_paths.paths", GitRestorePathsInputSchema.shape.paths],
      ["repo_git_restore_paths.expected_head_sha", GitRestorePathsInputSchema.shape.expected_head_sha],
      ["repo_git_restore_paths.dry_run", GitRestorePathsInputSchema.shape.dry_run],
      ["repo_git_restore_paths.reason", GitRestorePathsInputSchema.shape.reason],
      ["repo_git_restore_paths.ok", GitRestorePathsResultSchema.shape.ok],
      ["repo_git_restore_paths.dry_run", GitRestorePathsResultSchema.shape.dry_run],
      ["repo_git_restore_paths.head_sha", GitRestorePathsResultSchema.shape.head_sha],
      ["repo_git_restore_paths.restored_paths", GitRestorePathsResultSchema.shape.restored_paths],
      ["repo_git_restore_paths.skipped", GitRestorePathsResultSchema.shape.skipped],
      ["repo_git_restore_paths.skipped.path", GitRestorePathsResultSchema.shape.skipped.element.shape.path],
      ["repo_git_restore_paths.skipped.reason", GitRestorePathsResultSchema.shape.skipped.element.shape.reason],
      ["repo_git_restore_paths.warnings", GitRestorePathsResultSchema.shape.warnings]
    ]);

    expectFieldDescriptions([
      ["repo_write_commit.repo_id", GitCommitInputSchema.shape.repo_id],
      ["repo_write_commit.message", GitCommitInputSchema.shape.message],
      ["repo_write_commit.expected_head_sha", GitCommitInputSchema.shape.expected_head_sha],
      ["repo_write_commit.expected_staged_paths", GitCommitInputSchema.shape.expected_staged_paths],
      ["repo_write_commit.dry_run", GitCommitInputSchema.shape.dry_run],
      ["repo_write_commit.reason", GitCommitInputSchema.shape.reason],
      ["repo_write_commit.ok", GitCommitResultSchema.shape.ok],
      ["repo_write_commit.dry_run", GitCommitResultSchema.shape.dry_run],
      ["repo_write_commit.head_before", GitCommitResultSchema.shape.head_before],
      ["repo_write_commit.head_after", GitCommitResultSchema.shape.head_after],
      ["repo_write_commit.commit_sha", GitCommitResultSchema.shape.commit_sha],
      ["repo_write_commit.committed_paths", GitCommitResultSchema.shape.committed_paths],
      ["repo_write_commit.warnings", GitCommitResultSchema.shape.warnings]
    ]);

    expectFieldDescriptions([
      ["repo_write_stage_commit.repo_id", GitStageCommitInputSchema.shape.repo_id],
      ["repo_write_stage_commit.paths", GitStageCommitInputSchema.shape.paths],
      ["repo_write_stage_commit.message", GitStageCommitInputSchema.shape.message],
      ["repo_write_stage_commit.expected_head_sha", GitStageCommitInputSchema.shape.expected_head_sha],
      ["repo_write_stage_commit.dry_run", GitStageCommitInputSchema.shape.dry_run],
      ["repo_write_stage_commit.reason", GitStageCommitInputSchema.shape.reason],
      ["repo_write_stage_commit.ok", GitStageCommitResultSchema.shape.ok],
      ["repo_write_stage_commit.dry_run", GitStageCommitResultSchema.shape.dry_run],
      ["repo_write_stage_commit.head_before", GitStageCommitResultSchema.shape.head_before],
      ["repo_write_stage_commit.head_after", GitStageCommitResultSchema.shape.head_after],
      ["repo_write_stage_commit.commit_sha", GitStageCommitResultSchema.shape.commit_sha],
      ["repo_write_stage_commit.staged_paths", GitStageCommitResultSchema.shape.staged_paths],
      ["repo_write_stage_commit.committed_paths", GitStageCommitResultSchema.shape.committed_paths],
      ["repo_write_stage_commit.remaining_changes", GitStageCommitResultSchema.shape.remaining_changes],
      ["repo_write_stage_commit.clean_after", GitStageCommitResultSchema.shape.clean_after],
      ["repo_write_stage_commit.warnings", GitStageCommitResultSchema.shape.warnings]
    ]);

    expectFieldDescriptions([
      ["repo_write_recover.repo_id", GitRecoverInputSchema.shape.repo_id],
      ["repo_write_recover.expected_head_sha", GitRecoverInputSchema.shape.expected_head_sha],
      ["repo_write_recover.unstage_paths", GitRecoverInputSchema.shape.unstage_paths],
      ["repo_write_recover.restore_paths", GitRecoverInputSchema.shape.restore_paths],
      ["repo_write_recover.cleanup_paths", GitRecoverInputSchema.shape.cleanup_paths],
      ["repo_write_recover.dry_run", GitRecoverInputSchema.shape.dry_run],
      ["repo_write_recover.reason", GitRecoverInputSchema.shape.reason],
      ["repo_write_recover.ok", GitRecoverResultSchema.shape.ok],
      ["repo_write_recover.dry_run", GitRecoverResultSchema.shape.dry_run],
      ["repo_write_recover.head_sha", GitRecoverResultSchema.shape.head_sha],
      ["repo_write_recover.unstaged_paths", GitRecoverResultSchema.shape.unstaged_paths],
      ["repo_write_recover.restored_paths", GitRecoverResultSchema.shape.restored_paths],
      ["repo_write_recover.deleted", GitRecoverResultSchema.shape.deleted],
      ["repo_write_recover.deleted.path", GitRecoverResultSchema.shape.deleted.element.shape.path],
      ["repo_write_recover.deleted.type", GitRecoverResultSchema.shape.deleted.element.shape.type],
      ["repo_write_recover.skipped", GitRecoverResultSchema.shape.skipped],
      ["repo_write_recover.skipped.path", GitRecoverResultSchema.shape.skipped.element.shape.path],
      ["repo_write_recover.skipped.reason", GitRecoverResultSchema.shape.skipped.element.shape.reason],
      ["repo_write_recover.remaining_changes", GitRecoverResultSchema.shape.remaining_changes],
      ["repo_write_recover.clean_after", GitRecoverResultSchema.shape.clean_after],
      ["repo_write_recover.warnings", GitRecoverResultSchema.shape.warnings]
    ]);

    expectFieldDescriptions([
      ["repo_cleanup_paths.repo_id", CleanupPathsInputSchema.shape.repo_id],
      ["repo_cleanup_paths.paths", CleanupPathsInputSchema.shape.paths],
      ["repo_cleanup_paths.dry_run", CleanupPathsInputSchema.shape.dry_run],
      ["repo_cleanup_paths.reason", CleanupPathsInputSchema.shape.reason],
      ["repo_cleanup_paths.ok", CleanupPathsResultSchema.shape.ok],
      ["repo_cleanup_paths.dry_run", CleanupPathsResultSchema.shape.dry_run],
      ["repo_cleanup_paths.deleted", CleanupPathsResultSchema.shape.deleted],
      ["repo_cleanup_paths.deleted.path", CleanupPathsResultSchema.shape.deleted.element.shape.path],
      ["repo_cleanup_paths.deleted.type", CleanupPathsResultSchema.shape.deleted.element.shape.type],
      ["repo_cleanup_paths.skipped", CleanupPathsResultSchema.shape.skipped],
      ["repo_cleanup_paths.skipped.path", CleanupPathsResultSchema.shape.skipped.element.shape.path],
      ["repo_cleanup_paths.skipped.reason", CleanupPathsResultSchema.shape.skipped.element.shape.reason],
      ["repo_cleanup_paths.warnings", CleanupPathsResultSchema.shape.warnings]
    ]);
  });

  test("repo_write_changes schema accepts grouped same-file exact-match edits", () => {
    const parsed = WriteChangesInputSchema.safeParse({
      repo_id: "fixture",
      changes: [
        {
          type: "edit",
          path: "src/app.ts",
          edits: [
            { type: "replace", find: "const enabled = false;", replace: "const enabled = true;" },
            { type: "insert_before", find: "export function run() {", content: "const started = true;\n" },
            { type: "insert_after", find: "export function run() {", content: "\n  console.log('running');" }
          ]
        }
      ]
    });

    expect(parsed.error?.issues).toBeUndefined();
  });

  test("repo_write_changes schema rejects unsupported grouped edit operations", () => {
    const parsed = WriteChangesInputSchema.safeParse({
      repo_id: "fixture",
      changes: [
        {
          type: "edit",
          path: "src/app.ts",
          edits: [
            { type: "append", find: "export function run() {", content: "unsupported\n" }
          ]
        }
      ]
    });

    expect(parsed.success).toBe(false);
  });

  test("repo_git_review schema accepts composite recover payloads", () => {
    const parsed = GitReviewResultSchema.safeParse({
      ok: true,
      detail: "full",
      branch: "main",
      head_sha: "0".repeat(40),
      clean: false,
      changed_paths: [],
      diff_summary: {
        file_count: 0,
        truncated: false,
        files: []
      },
      recommendation: {
        ready_to_stage: false,
        recommended_stage_paths: [],
        excluded_paths: [],
        suggested_commit_message: "No changes to commit",
        risk_level: "low",
        warnings: []
      },
      delegation_gate: {
        status: "not_applicable",
        requested_paths: [],
        applicable_runs: [],
        blocking_reasons: [],
        warnings: [],
        truncated: false
      },
      ship_readiness: {
        validation: { status: "missing" }
      },
      next_tool_payloads: {
        repo_write_recover_dry_run: {
          repo_id: "fixture",
          expected_head_sha: "0".repeat(40),
          unstage_paths: ["docs/a.md"],
          restore_paths: ["docs/a.md"],
          cleanup_paths: [".chatgpt/tool-tests/generated.md"],
          dry_run: true
        },
        repo_write_recover_actual: {
          repo_id: "fixture",
          expected_head_sha: "0".repeat(40),
          unstage_paths: ["docs/a.md"],
          restore_paths: ["docs/a.md"],
          cleanup_paths: [".chatgpt/tool-tests/generated.md"],
          dry_run: false
        }
      }
    });

    expect(parsed.error?.issues).toBeUndefined();
  });

  test("operations policy schema includes safe git operation defaults", () => {
    const parsed = RepoReaderConfigSchema.safeParse({
      repos: [{
        repo_id: "fixture",
        display_name: "Fixture",
        root: "/tmp/fixture",
        operations: {
          enabled: true,
          git_stage_enabled: true,
          git_commit_enabled: true,
          validation_enabled: true,
          max_paths_per_operation: 25
        }
      }],
      limits: {}
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.repos[0]?.operations).toMatchObject({
      enabled: true,
      git_stage_enabled: true,
      git_commit_enabled: true,
      validation_enabled: true,
      max_paths_per_operation: 25
    });

    expect(parsed.data?.repos[0]?.operations).toMatchObject({
      cleanup_enabled: false,
      cleanup_allowed_globs: [
        ".chatgpt/tool-tests/**",
        ".chatgpt/backups/**",
        ".chatgpt/audits/**",
        ".chatgpt/backlog/**",
        ".chatgpt/codex-runs/**",
        "coverage/**",
        "dist/**",
        "test-results/**"
      ]
    });
    expect(RepoReaderConfigSchema.parse({
      repos: [{ repo_id: "fixture", display_name: "Fixture", root: "/tmp/fixture" }],
      limits: {}
    }).repos[0]?.operations).toEqual({
      enabled: false,
      git_stage_enabled: false,
      git_commit_enabled: false,
      max_paths_per_operation: 50,
      validation_enabled: false,
      validation_test_path_globs: [],
      validation_profiles: {},
      cleanup_enabled: false,
      cleanup_allowed_globs: [
        ".chatgpt/tool-tests/**",
        ".chatgpt/backups/**",
        ".chatgpt/audits/**",
        ".chatgpt/backlog/**",
        ".chatgpt/codex-runs/**",
        "coverage/**",
        "dist/**",
        "test-results/**"
      ]
    });
  });

  test("write policy schema exposes current defaults without legacy backup config", () => {
    const parsed = RepoReaderConfigSchema.safeParse({
      repos: [{
        repo_id: "fixture",
        display_name: "Fixture",
        root: "/tmp/fixture",
        writes: {
          enabled: true
        }
      }],
      limits: {}
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.repos[0]?.writes.max_bytes_per_write).toBe(1048576);

    const defaultWrites = RepoReaderConfigSchema.parse({
      repos: [{ repo_id: "fixture", display_name: "Fixture", root: "/tmp/fixture" }],
      limits: {}
    }).repos[0]?.writes;
    expect(defaultWrites?.max_bytes_per_write).toBe(1048576);
    expect(defaultWrites?.allowed_globs).toEqual([
      ".chatgpt/**",
      ".codex/**",
      "docs/**",
      "README.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "SUPPORT.md",
      "LICENSE",
      ".gitignore"
    ]);
    expect(defaultWrites?.allowed_globs).toContain(".gitignore");
    expect(defaultWrites).not.toHaveProperty("require_expected_sha256_for_overwrite");
    expect(defaultWrites).not.toHaveProperty("create_backup_on_overwrite");
    expect(defaultWrites).not.toHaveProperty("backup_dir");
    expect(defaultWrites?.denied_globs).toContain("**/node_modules/**");
    expect(defaultWrites?.denied_globs).toContain("**/dist/**");
    expect(defaultWrites?.denied_globs).toContain("**/.next/**");
    expect(defaultWrites?.denied_globs).toContain("**/coverage/**");
    expect(defaultWrites?.denied_globs).not.toContain("**/*secret*");
    expect(defaultWrites?.denied_globs).not.toContain("**/*credential*");
  });

  test("code intelligence config requires an explicit absolute executable and accepts no command arguments", () => {
    const valid = RepoReaderConfigSchema.safeParse({
      repos: [],
      limits: {},
      code_intelligence: {
        provider: "codebase_memory",
        executable: "/usr/local/bin/codebase-memory-mcp"
      }
    });
    expect(valid.success).toBe(true);
    expect(valid.data?.code_intelligence).toMatchObject({ query_timeout_ms: 3_000, index_timeout_ms: 1_800_000 });

    expect(RepoReaderConfigSchema.safeParse({
      repos: [],
      limits: {},
      code_intelligence: { provider: "codebase_memory", executable: "codebase-memory-mcp" }
    }).success).toBe(false);
    expect(RepoReaderConfigSchema.safeParse({
      repos: [],
      limits: {},
      code_intelligence: {
        provider: "codebase_memory",
        executable: "/usr/local/bin/codebase-memory-mcp",
        args: ["--unsafe"]
      }
    }).success).toBe(false);
    const indexTool = toolCatalog.find((tool) => tool.name === "repo_code_index");
    expect(indexTool?.inputSchema.safeParse({ repo_id: "fixture", action: "status" }).success).toBe(true);
    expect(indexTool?.inputSchema.safeParse({ repo_id: "fixture", action: "start", path: "/tmp/other" }).success).toBe(false);
    expect(indexTool?.description).toContain("explicitly ask the user");
  });

  test("code intelligence transport has no shell or client-controlled command surface", () => {
    const source = readFileSync("src/services/codebase-memory-client.ts", "utf8");
    expect(source).toContain("new StdioClientTransport");
    expect(source).toContain("args: []");
    expect(source).not.toMatch(/exec\s*\(|execSync\s*\(|shell\s*:\s*true/);
    expect(toolContracts.repo_code_index.input.keyof().options.sort()).toEqual(["action", "repo_id"]);
  });

  test("config example is a valid empty starter config", () => {
    const raw = readFileSync("config.example.json", "utf8");
    const example = JSON.parse(raw) as { repos?: unknown[]; limits?: Record<string, unknown> };
    const parsed = RepoReaderConfigSchema.safeParse(example);

    expect(parsed.success).toBe(true);
    expect(example.repos).toEqual([]);
    expect(example.limits).toEqual({
      max_files: 50,
      max_bytes_per_file: 128000,
      max_total_bytes: 750000
    });
    expect(raw).not.toContain("/absolute/path/to/repo");
  });

  test("repo_read_many advertises exclude globs and file content output", () => {
    const readMany = toolCatalog.find((tool) => tool.name === "repo_read_many");
    expect(readMany?.inputSchema.shape.exclude_globs).toBeDefined();
    expect(readMany?.inputSchema.safeParse({ repo_id: "fixture" }).success).toBe(false);
    expect(readMany?.inputSchema.safeParse({ repo_id: "fixture", paths: ["README.md"] }).success).toBe(true);
    expect(readMany?.inputSchema.safeParse({ repo_id: "fixture", include_globs: ["src/**/*.ts"] }).success).toBe(true);

    const outputSchema = readMany!.outputSchema;
    const parsed = outputSchema.safeParse({
      files: [{
        path: "README.md",
        size_bytes: 10,
        sha256: "abc",
        total_lines: 1,
        start_line: 1,
        end_line: 1,
        truncated: false,
        text: "hello",
        warnings: []
      }],
      skipped: [],
      matched_count: 1,
      returned_count: 1,
      truncated: false
    });
    expect(parsed.success).toBe(true);

    const missingFileFields = outputSchema.safeParse({
      files: [{ path: "README.md" }],
      skipped: [],
      matched_count: 1,
      returned_count: 1,
      truncated: false
    });
    expect(missingFileFields.success).toBe(false);
  });

  test("repo_git_diff advertises minimal first-call guidance", () => {
    const gitDiff = toolCatalog.find((tool) => tool.name === "repo_git_diff");

    expect(gitDiff?.description).toContain("Default first call should pass only repo_id");
    expect(gitDiff?.description).toContain("add filters only for a second pass");
    expect(schemaDescription(gitDiff!.inputSchema.shape.max_bytes)).toContain("Second-pass refinement");
    expect(schemaDescription(gitDiff!.inputSchema.shape.context_lines)).toContain("Omit on the first diff call");
  });

  test("every tool uses the central contract objects", () => {
    expect(toolCatalog.map((tool) => tool.name).sort()).toEqual(Object.keys(toolContracts).sort());

    for (const tool of toolCatalog) {
      const contract = toolContracts[tool.name];
      expect(tool.inputSchema).toBe(contract.input);
      expect(tool.outputSchema).toBe(contract.output);
    }
  });

  test("critical workflow surfaces have reviewable contract summaries", () => {
    expect(contractSummaries([
      "repo_git_review",
      "repo_write_stage_commit",
      "repo_write_recover",
      "repo_prepare_patchset",
      "repo_apply_patchset",
      "repo_rollback_patchset",
      "repo_validate"
    ])).toEqual([
      {
        name: "repo_git_review",
        mutating: false,
        inputKeys: ["detail", "max_files", "mode", "paths", "repo_id"],
        outputKeys: ["branch", "changed_paths", "clean", "delegation_gate", "detail", "diff_summary", "head_sha", "next_tool_payloads", "ok", "recommendation", "ship_readiness"]
      },
      {
        name: "repo_write_stage_commit",
        mutating: true,
        inputKeys: ["dry_run", "expected_head_sha", "message", "paths", "reason", "repo_id", "review_pathset_id"],
        outputKeys: ["clean_after", "commit_sha", "committed_paths", "dry_run", "head_after", "head_before", "ok", "remaining_changes", "review_pathset_id", "staged_paths", "warnings"]
      },
      {
        name: "repo_write_recover",
        mutating: true,
        inputKeys: ["cleanup_paths", "discard_paths", "dry_run", "expected_head_sha", "reason", "repo_id", "restore_paths", "unstage_paths"],
        outputKeys: ["clean_after", "deleted", "discarded", "dry_run", "head_sha", "ok", "remaining_changes", "restored_paths", "skipped", "unstaged_paths", "warnings"]
      },
      {
        name: "repo_prepare_patchset",
        mutating: true,
        inputKeys: ["base_head_sha", "files", "intent", "repo_id", "work_session_id"],
        outputKeys: ["affected_paths", "manifest", "manifest_path", "next_tool_payloads", "ok", "patchset_id", "warnings"]
      },
      {
        name: "repo_apply_patchset",
        mutating: true,
        inputKeys: ["dry_run", "expected_head_sha", "patchset_id", "repo_id"],
        outputKeys: ["changed_paths", "counts", "created_paths", "deleted_paths", "dry_run", "hunk_diagnostics", "modified_paths", "next_tool_payloads", "ok", "operation_id", "operation_receipt", "patchset_id", "renamed_paths", "rollback_hint", "warnings"]
      },
      {
        name: "repo_rollback_patchset",
        mutating: true,
        inputKeys: ["dry_run", "expected_head_sha", "patchset_id", "repo_id"],
        outputKeys: ["counts", "deleted_paths", "dry_run", "next_tool_payloads", "ok", "operation_id", "operation_receipt", "patchset_id", "restored_paths", "skipped", "warnings"]
      },
      {
        name: "repo_validate",
        mutating: true,
        inputKeys: ["dry_run", "profile", "repo_id", "test_paths", "timeout_ms"],
        outputKeys: ["commands", "counts", "dry_run", "focused", "ok", "profile", "repo_id", "status", "test_paths", "validation_artifact", "validation_id", "warnings"]
      }
    ]);
  });

  test("exposed tool surface shape stays stable", () => {
    expect(toolCatalog.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
      inputKeys: Object.keys(tool.inputSchema.shape).sort(),
      outputKeys: Object.keys(tool.outputSchema.shape).sort()
    }))).toMatchInlineSnapshot(`
      [
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when listing approved repositories. It does not read repository contents.",
          "inputKeys": [],
          "name": "repo_list_roots",
          "outputKeys": [
            "repos",
          ],
          "title": "List approved repositories",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when repository access is blocked or policy capabilities are unclear. It explains effective read, write, cleanup, validation, and Git-operation policy without mutation.",
          "inputKeys": [
            "operation",
            "path",
            "repo_id",
          ],
          "name": "repo_policy_explain",
          "outputKeys": [
            "cleanup",
            "effective_policy",
            "guidance",
            "ok",
            "operations",
            "path",
            "read",
            "repo_id",
            "requested_operation",
            "summary",
            "validation",
            "write",
          ],
          "title": "Explain repository policy",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when resuming after a write or checking what the latest write changed. It returns safe receipt metadata only.",
          "inputKeys": [
            "repo_id",
          ],
          "name": "repo_last_write",
          "outputKeys": [
            "found",
            "next_tool_payloads",
            "ok",
            "receipt",
            "warnings",
          ],
          "title": "Read last write receipt",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when inspecting bounded historical write and operation receipts. Prefer repo_last_write for only the latest operation.",
          "inputKeys": [
            "after_operation_id",
            "cursor",
            "limit",
            "repo_id",
          ],
          "name": "repo_operation_ledger",
          "outputKeys": [
            "events",
            "next_cursor",
            "ok",
            "repo_id",
            "warnings",
          ],
          "title": "Read operation ledger",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when locating directories and likely files by repository structure. Use repo_fetch_file to read contents.",
          "inputKeys": [
            "cursor",
            "include_dependencies",
            "include_files",
            "include_generated",
            "max_depth",
            "page_size",
            "path",
            "repo_id",
            "respect_default_excludes",
          ],
          "name": "repo_tree",
          "outputKeys": [
            "entries",
            "excluded_summary",
            "next_cursor",
            "truncated",
          ],
          "title": "Inspect repository tree",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when locating code, text, usages, or likely files. Prefer it before reading multiple files.",
          "inputKeys": [
            "context_lines",
            "cursor",
            "exclude_globs",
            "include_globs",
            "max_results",
            "mode",
            "query",
            "repo_id",
          ],
          "name": "repo_search",
          "outputKeys": [
            "matched_count",
            "next_cursor",
            "results",
            "returned_count",
            "truncated",
            "warnings",
          ],
          "title": "Search repository text",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when reading one known file or line range. Do not use it for broad repository review.",
          "inputKeys": [
            "end_line",
            "max_bytes",
            "override_default_excludes",
            "path",
            "repo_id",
            "start_line",
          ],
          "name": "repo_fetch_file",
          "outputKeys": [
            "end_line",
            "language",
            "path",
            "sha256",
            "size_bytes",
            "start_line",
            "text",
            "total_lines",
            "truncated",
            "warnings",
          ],
          "title": "Fetch one file",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when reading a bounded known set of files or globs. Do not use it to read an entire repository.",
          "inputKeys": [
            "cursor",
            "exclude_globs",
            "include_globs",
            "max_bytes_per_file",
            "max_files",
            "max_total_bytes",
            "paths",
            "repo_id",
          ],
          "name": "repo_read_many",
          "outputKeys": [
            "files",
            "matched_count",
            "next_cursor",
            "returned_count",
            "skipped",
            "truncated",
          ],
          "title": "Read bounded files",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when mapping file-level impact, imports, dependents, entrypoints, routes, components, or affected tests. Use repo_symbol_context for symbol-level evidence.",
          "inputKeys": [
            "focus_paths",
            "goal",
            "max_files",
            "repo_id",
          ],
          "name": "repo_context_map",
          "outputKeys": [
            "affected_tests",
            "component_signals",
            "dependency_paths",
            "entrypoints",
            "framework_signals",
            "generated_paths",
            "import_edges",
            "reverse_dependents",
            "route_signals",
            "scanned_file_count",
            "truncated",
            "warnings",
          ],
          "title": "Map repository context",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when gathering symbol-level evidence for definitions, references, calls, implementations, reverse dependents, or affected tests. Ask before starting an optional index.",
          "inputKeys": [
            "depth",
            "direction",
            "max_files",
            "max_relations",
            "max_symbols",
            "paths",
            "repo_id",
            "symbols",
          ],
          "name": "repo_symbol_context",
          "outputKeys": [
            "affected_tests",
            "cache",
            "calls",
            "confidence",
            "definitions",
            "exports",
            "implementations",
            "imports",
            "ok",
            "provider",
            "references",
            "repo_id",
            "reverse_dependents",
            "scanned_file_count",
            "truncated",
            "warnings",
          ],
          "title": "Inspect symbol context",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when checking or managing the optional Codebase Memory index. Before action=start, explicitly ask the user; status is safe to inspect without approval.",
          "inputKeys": [
            "action",
            "repo_id",
          ],
          "name": "repo_code_index",
          "outputKeys": [
            "action",
            "events",
            "finished_at",
            "ok",
            "provider",
            "repo_id",
            "started_at",
            "status",
            "warnings",
          ],
          "title": "Manage optional code graph index",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when saved validation evidence needs normalized diagnostics and deterministic correlation. It does not run commands or claim an LLM root cause.",
          "inputKeys": [
            "max_candidates",
            "max_diagnostics",
            "repo_id",
            "scope_paths",
            "validation_id",
          ],
          "name": "repo_failure_diagnose",
          "outputKeys": [
            "candidates",
            "correlations",
            "diagnostics",
            "next_tool_payloads",
            "ok",
            "repo_id",
            "truncated",
            "validation",
            "warnings",
          ],
          "title": "Diagnose repository failure evidence",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when current changes need standalone evidence-based semantic risk review. Use repo_ship_review for combined final readiness.",
          "inputKeys": [
            "categories",
            "max_files",
            "max_findings",
            "paths",
            "repo_id",
          ],
          "name": "repo_semantic_review",
          "outputKeys": [
            "findings",
            "next_tool_payloads",
            "ok",
            "repo_id",
            "reviewed_paths",
            "ship_readiness",
            "summary",
            "truncated",
            "warnings",
          ],
          "title": "Review semantic change risks",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when combined final readiness across Git, validation, semantic, and delegation gates is needed before ship. Compact is default; detail=full adds granular expert evidence and payloads.",
          "inputKeys": [
            "categories",
            "detail",
            "max_files",
            "max_findings",
            "paths",
            "repo_id",
            "run_id",
          ],
          "name": "repo_ship_review",
          "outputKeys": [
            "delegation_gate",
            "detail",
            "failure_diagnosis",
            "git_review",
            "next_tool_payloads",
            "ok",
            "repo_id",
            "review_loop",
            "run_id",
            "semantic_review",
            "ship_readiness",
            "truncated",
            "warnings",
          ],
          "title": "Review ship readiness",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when checking branch, HEAD, cleanliness, or changed-file status. It does not read file contents.",
          "inputKeys": [
            "repo_id",
          ],
          "name": "repo_git_status",
          "outputKeys": [
            "branch",
            "clean",
            "counts",
            "files",
            "head_sha",
          ],
          "title": "Read git status",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when raw Git diff content is requested. Default first call should pass only repo_id; add filters only for a second pass.",
          "inputKeys": [
            "base",
            "compare",
            "context_lines",
            "max_bytes",
            "max_files",
            "paths",
            "repo_id",
            "staged",
            "unstaged",
          ],
          "name": "repo_git_diff",
          "outputKeys": [
            "base",
            "compare",
            "files",
            "staged",
            "total_file_count",
            "truncated",
            "truncation_reason",
            "unstaged",
            "warnings",
          ],
          "title": "Read git diff",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when reviewing current Git state or planning commit and recovery without mutation. Compact is default; detail=full adds granular and dry-run payloads.",
          "inputKeys": [
            "detail",
            "max_files",
            "mode",
            "paths",
            "repo_id",
          ],
          "name": "repo_git_review",
          "outputKeys": [
            "branch",
            "changed_paths",
            "clean",
            "delegation_gate",
            "detail",
            "diff_summary",
            "head_sha",
            "next_tool_payloads",
            "ok",
            "recommendation",
            "ship_readiness",
          ],
          "title": "Plan git review",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when explicitly restoring reviewed unstaged tracked paths. Prefer repo_write_recover for normal composite recovery.",
          "inputKeys": [
            "dry_run",
            "expected_head_sha",
            "paths",
            "reason",
            "repo_id",
          ],
          "name": "repo_git_restore_paths",
          "outputKeys": [
            "dry_run",
            "head_sha",
            "ok",
            "restored_paths",
            "skipped",
            "warnings",
          ],
          "title": "Restore explicit worktree paths",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when reviewed paths must be staged separately. Prefer the composite stage-and-commit payload when available.",
          "inputKeys": [
            "dry_run",
            "expected_head_sha",
            "paths",
            "reason",
            "repo_id",
          ],
          "name": "repo_write_stage",
          "outputKeys": [
            "dry_run",
            "head_sha",
            "ok",
            "skipped",
            "staged_paths",
            "warnings",
          ],
          "title": "Stage reviewed paths",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when reviewed paths must be unstaged separately. Prefer repo_write_recover for normal composite recovery.",
          "inputKeys": [
            "dry_run",
            "expected_head_sha",
            "paths",
            "reason",
            "repo_id",
          ],
          "name": "repo_write_unstage",
          "outputKeys": [
            "dry_run",
            "head_sha",
            "ok",
            "skipped",
            "unstaged_paths",
            "warnings",
          ],
          "title": "Unstage reviewed paths",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when committing an exact already-staged path set locally. It verifies HEAD and staged paths and never pushes.",
          "inputKeys": [
            "dry_run",
            "expected_head_sha",
            "expected_staged_paths",
            "message",
            "reason",
            "repo_id",
          ],
          "name": "repo_write_commit",
          "outputKeys": [
            "commit_sha",
            "committed_paths",
            "dry_run",
            "head_after",
            "head_before",
            "ok",
            "warnings",
          ],
          "title": "Create reviewed local commit",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when review returns the canonical stage-and-commit payload. Normal review supplies explicit paths; multi-run integration supplies only its opaque review_pathset_id. The server rechecks exact HEAD, bytes, paths, gates, and staged set, creates one local commit, and never pushes.",
          "inputKeys": [
            "dry_run",
            "expected_head_sha",
            "message",
            "paths",
            "reason",
            "repo_id",
            "review_pathset_id",
          ],
          "name": "repo_write_stage_commit",
          "outputKeys": [
            "clean_after",
            "commit_sha",
            "committed_paths",
            "dry_run",
            "head_after",
            "head_before",
            "ok",
            "remaining_changes",
            "review_pathset_id",
            "staged_paths",
            "warnings",
          ],
          "title": "Stage and commit reviewed paths",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when review returns canonical composite recovery for explicit unstage, restore, cleanup, or discard paths. It never resets, stashes, pushes, or runs a shell.",
          "inputKeys": [
            "cleanup_paths",
            "discard_paths",
            "dry_run",
            "expected_head_sha",
            "reason",
            "repo_id",
            "restore_paths",
            "unstage_paths",
          ],
          "name": "repo_write_recover",
          "outputKeys": [
            "clean_after",
            "deleted",
            "discarded",
            "dry_run",
            "head_sha",
            "ok",
            "remaining_changes",
            "restored_paths",
            "skipped",
            "unstaged_paths",
            "warnings",
          ],
          "title": "Recover reviewed paths",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when separately deleting reviewed untracked generated or local artifacts allowed by cleanup policy. Prefer composite recovery when available.",
          "inputKeys": [
            "dry_run",
            "paths",
            "reason",
            "repo_id",
          ],
          "name": "repo_cleanup_paths",
          "outputKeys": [
            "deleted",
            "dry_run",
            "ok",
            "skipped",
            "warnings",
          ],
          "title": "Clean up generated paths",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when onboarding into or summarizing a repository. It returns repository-owned product context before technical metadata and never chooses the next goal.",
          "inputKeys": [
            "include",
            "repo_id",
          ],
          "name": "repo_project_brief",
          "outputKeys": [
            "entrypoint_signals",
            "framework_signals",
            "key_docs",
            "languages",
            "likely_entrypoints",
            "package_managers",
            "product_brief",
            "project_type",
            "repo",
            "scripts",
            "test_commands",
            "truncated",
            "warnings",
          ],
          "title": "Create project brief",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when the user explicitly requests TODO, FIXME, checkbox, roadmap, or backlog evidence. It returns candidates, not priority.",
          "inputKeys": [
            "cursor",
            "exclude_globs",
            "include_globs",
            "labels",
            "max_results",
            "repo_id",
          ],
          "name": "repo_task_inventory",
          "outputKeys": [
            "matched_count",
            "next_cursor",
            "returned_count",
            "scan_complete",
            "scanned_file_count",
            "tasks",
            "truncated",
            "warnings",
          ],
          "title": "Inventory repository tasks",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when architecture rationale, conventions, or historical decisions are requested. It is supporting evidence, not product or active-work authority.",
          "inputKeys": [
            "include_sources",
            "repo_id",
          ],
          "name": "repo_decision_memory",
          "outputKeys": [
            "conventions",
            "decisions",
            "gaps",
            "warnings",
          ],
          "title": "Extract decision memory",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when the user and ChatGPT have already chosen an implementation goal. It plans how to execute that goal but never selects alternative work.",
          "inputKeys": [
            "goal",
            "include_globs",
            "max_files_to_inspect",
            "planning_depth",
            "repo_id",
          ],
          "name": "repo_change_plan",
          "outputKeys": [
            "estimated_cost",
            "goal",
            "open_questions",
            "proposed_steps",
            "relevant_files",
            "scan_complete",
            "test_strategy",
            "warnings",
          ],
          "title": "Plan repository change",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when previewing a product-grounded Delegation v3 task before writing it. Use complete review-provided payloads for lineage children.",
          "inputKeys": [
            "assignment",
            "authorization_scope",
            "explicit_exclusions",
            "forbidden_paths",
            "hard_constraints",
            "lineage",
            "must_preserve",
            "outcome",
            "product_alignment",
            "relevant_context",
            "repo_id",
            "run_id",
            "runner",
            "security_context",
            "starting_points",
            "task_kind",
            "technical_acceptance_criteria",
            "technical_context",
            "title",
            "validation",
          ],
          "name": "repo_prepare_codex_task",
          "outputKeys": [
            "delegation_audit",
            "lineage",
            "manifest_path",
            "ok",
            "product_contract_sha256",
            "prompt_path",
            "repo_id",
            "result_json_path",
            "review_gate_path",
            "review_requirement",
            "run_id",
            "schema_version",
            "task_kind",
            "warnings",
          ],
          "title": "Prepare Delegation v3 task",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when the user explicitly requests durable Codex or implementation-agent delegation. It writes bound Delegation v3 artifacts but never starts a runner, commits, or pushes.",
          "inputKeys": [
            "assignment",
            "authorization_scope",
            "dry_run",
            "explicit_exclusions",
            "forbidden_paths",
            "hard_constraints",
            "lineage",
            "must_preserve",
            "outcome",
            "product_alignment",
            "reason",
            "relevant_context",
            "repo_id",
            "run_id",
            "runner",
            "security_context",
            "starting_points",
            "task_kind",
            "technical_acceptance_criteria",
            "technical_context",
            "title",
            "validation",
          ],
          "name": "repo_write_codex_task",
          "outputKeys": [
            "delegation_audit",
            "dry_run",
            "lineage",
            "manifest_path",
            "next_tool_payloads",
            "ok",
            "product_contract_sha256",
            "prompt_path",
            "repo_id",
            "result_json_path",
            "review_gate_path",
            "review_requirement",
            "run_id",
            "schema_version",
            "task_kind",
            "warnings",
            "written_paths",
          ],
          "title": "Write Delegation v3 task",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when inspecting agent lifecycle, runtime, questions, events, drift, or checkpoint state. It is read-only and never selects work.",
          "inputKeys": [
            "cursor",
            "events_after",
            "max_events",
            "page_size",
            "repo_id",
            "run_id",
            "statuses",
            "wait_after_revision",
            "wait_timeout_ms",
          ],
          "name": "repo_agent_runs",
          "outputKeys": [
            "drift_summary",
            "matched_count",
            "mode",
            "next_cursor",
            "next_tool_payloads",
            "ok",
            "repo_id",
            "returned_count",
            "revision",
            "run",
            "runs",
            "supervisor",
            "truncated",
            "warnings",
          ],
          "title": "Inspect agent runs",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when answering the exact current structured questions for an awaiting-input run. It rejects stale or incomplete replies and only writes the reply artifact.",
          "inputKeys": [
            "answers",
            "expected_question_sha256",
            "repo_id",
            "run_id",
            "turn_index",
          ],
          "name": "repo_write_agent_reply",
          "outputKeys": [
            "agent_run",
            "next_tool_payloads",
            "ok",
            "repo_id",
            "run_id",
            "turn_index",
            "warnings",
            "written_path",
          ],
          "title": "Reply to an agent run",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when an implementation agent has finished. It validates bound result, scope, Git state, TAC/PAC evidence, technical readiness, and product-review requirements without self-approving product claims.",
          "inputKeys": [
            "max_files",
            "repo_id",
            "run_id",
          ],
          "name": "repo_codex_review",
          "outputKeys": [
            "acceptance_evidence",
            "codex_result",
            "git_review",
            "integrity",
            "legacy_result_path",
            "next_steps",
            "next_tool_payloads",
            "ok",
            "product_acceptance_evidence",
            "product_evidence",
            "product_review",
            "repo_id",
            "result_found",
            "result_json_path",
            "result_source",
            "review_attestation",
            "review_loop",
            "review_state",
            "run_id",
            "scope_evidence",
            "technical_acceptance_evidence",
            "technical_readiness",
            "warnings",
          ],
          "title": "Review Codex result",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when recording the state-bound qualitative review returned by repo_codex_review. It validates the exact state and writes review evidence without staging or committing.",
          "inputKeys": [
            "dry_run",
            "evidence",
            "expected_review_state_sha256",
            "product_verdict",
            "rationale",
            "reason",
            "repo_id",
            "run_id",
          ],
          "name": "repo_write_codex_review",
          "outputKeys": [
            "dry_run",
            "next_steps",
            "ok",
            "product_verdict",
            "repo_id",
            "review_gate_path",
            "review_gate_sha256",
            "review_path",
            "review_requirement",
            "review_sha256",
            "review_state_sha256",
            "reviewed_at",
            "run_id",
            "technical_readiness_status",
            "warnings",
            "written_paths",
          ],
          "title": "Write state-bound Codex review",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when the owner explicitly approves integrating multiple currently attested Delegation v3 runs in one worktree, and only for that integration case. It requires exact run, HEAD, pathset, validation, product-verdict, semantic, scope, and content state, then writes an opaque pathset for one atomic local commit; it is not a force or skip-review path.",
          "inputKeys": [
            "commit_message",
            "dry_run",
            "expected_head_sha",
            "reason",
            "repo_id",
            "run_ids",
            "validation_id",
          ],
          "name": "repo_write_integration_review",
          "outputKeys": [
            "dry_run",
            "head_sha",
            "integration_id",
            "integration_path",
            "next_tool_payloads",
            "ok",
            "path_count",
            "pathset_fingerprint",
            "repo_id",
            "review_pathset_id",
            "reviewed_paths",
            "run_ids",
            "validation_id",
            "warnings",
            "written_paths",
          ],
          "title": "Write multi-run integration review",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when preparing an atomic create, modify, edit, delete, or rename patchset. It writes only local manifest metadata, not target files.",
          "inputKeys": [
            "base_head_sha",
            "files",
            "intent",
            "repo_id",
            "work_session_id",
          ],
          "name": "repo_prepare_patchset",
          "outputKeys": [
            "affected_paths",
            "manifest",
            "manifest_path",
            "next_tool_payloads",
            "ok",
            "patchset_id",
            "warnings",
          ],
          "title": "Prepare patchset",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when applying a prepared patchset atomically with stale-state guards. A HEAD-bound apply returns first-class rollback guidance.",
          "inputKeys": [
            "dry_run",
            "expected_head_sha",
            "patchset_id",
            "repo_id",
          ],
          "name": "repo_apply_patchset",
          "outputKeys": [
            "changed_paths",
            "counts",
            "created_paths",
            "deleted_paths",
            "dry_run",
            "hunk_diagnostics",
            "modified_paths",
            "next_tool_payloads",
            "ok",
            "operation_id",
            "operation_receipt",
            "patchset_id",
            "renamed_paths",
            "rollback_hint",
            "warnings",
          ],
          "title": "Apply patchset",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when reviewing a prepared or applied patchset and its ledger/Git state. It does not mutate files or Git.",
          "inputKeys": [
            "max_files",
            "patchset_id",
            "repo_id",
          ],
          "name": "repo_review_patchset",
          "outputKeys": [
            "applied",
            "git_review",
            "manifest",
            "manifest_path",
            "ok",
            "patchset_id",
            "rolled_back",
            "warnings",
          ],
          "title": "Review patchset",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when the user explicitly approves rollback of an uncommitted, unchanged applied patchset. It requires the expected HEAD.",
          "inputKeys": [
            "dry_run",
            "expected_head_sha",
            "patchset_id",
            "repo_id",
          ],
          "name": "repo_rollback_patchset",
          "outputKeys": [
            "counts",
            "deleted_paths",
            "dry_run",
            "next_tool_payloads",
            "ok",
            "operation_id",
            "operation_receipt",
            "patchset_id",
            "restored_paths",
            "skipped",
            "warnings",
          ],
          "title": "Rollback patchset",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when running an allowlisted test, build, lint, typecheck, smoke, or all profile. A declared repo-owned make target takes priority; npm and safe pytest are fallbacks. Output is streamed into a bounded tail without a shell or arbitrary commands.",
          "inputKeys": [
            "dry_run",
            "profile",
            "repo_id",
            "test_paths",
            "timeout_ms",
          ],
          "name": "repo_validate",
          "outputKeys": [
            "commands",
            "counts",
            "dry_run",
            "focused",
            "ok",
            "profile",
            "repo_id",
            "status",
            "test_paths",
            "validation_artifact",
            "validation_id",
            "warnings",
          ],
          "title": "Validate repository",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when starting a focused multi-step slice that benefits from content-free local progress state.",
          "inputKeys": [
            "constraints",
            "dry_run",
            "files_inspected",
            "next_action",
            "objective",
            "repo_id",
            "title",
            "touched_files",
            "work_session_id",
          ],
          "name": "repo_start_work_session",
          "outputKeys": [
            "current_path",
            "dry_run",
            "next_tool_payloads",
            "ok",
            "session",
            "session_path",
            "warnings",
            "work_session_id",
          ],
          "title": "Start work session",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when appending decisions, inspected or touched paths, validation refs, risks, status, or next action to a work session.",
          "inputKeys": [
            "append_assumptions",
            "append_decisions",
            "append_files_inspected",
            "append_pending_patchsets",
            "append_touched_files",
            "append_unresolved_risks",
            "append_validation_results",
            "dry_run",
            "next_action",
            "repo_id",
            "status",
            "work_session_id",
          ],
          "name": "repo_update_work_session",
          "outputKeys": [
            "current_path",
            "dry_run",
            "next_tool_payloads",
            "ok",
            "session",
            "session_path",
            "warnings",
            "work_session_id",
          ],
          "title": "Update work session",
        },
        {
          "annotations": {
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
            "readOnlyHint": true,
          },
          "description": "Use this when resuming repository continuity. Current active or blocked work is full; completed history is compact unless work_session_id is supplied.",
          "inputKeys": [
            "repo_id",
            "work_session_id",
          ],
          "name": "repo_current_work_session",
          "outputKeys": [
            "continuity_state",
            "current_path",
            "found",
            "lookup_source",
            "ok",
            "repo_id",
            "session",
            "session_path",
            "warnings",
            "work_session_id",
          ],
          "title": "Read current work session",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when directly creating or precisely editing one allowed repository file. It supports stale-state guards and never runs Git, Codex, or a shell.",
          "inputKeys": [
            "action",
            "content",
            "create_dirs",
            "dry_run",
            "expected_head_sha",
            "expected_missing",
            "expected_old_sha256",
            "find",
            "path",
            "reason",
            "replace",
            "repo_id",
          ],
          "name": "repo_write_file",
          "outputKeys": [
            "action",
            "bytes_written",
            "changed",
            "created",
            "dry_run",
            "new_sha256",
            "ok",
            "old_sha256",
            "operation_receipt",
            "path",
            "summary",
            "warnings",
          ],
          "title": "Write one repository file",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when directly applying one cohesive multi-file write/edit pack. It supports stale-state guards and never stages, commits, restores, or runs a shell.",
          "inputKeys": [
            "changes",
            "dry_run",
            "expected_head_sha",
            "reason",
            "repo_id",
          ],
          "name": "repo_write_changes",
          "outputKeys": [
            "changed_paths",
            "counts",
            "dry_run",
            "files",
            "next_steps",
            "ok",
            "operation_receipt",
            "summary",
            "warnings",
          ],
          "title": "Apply repository edit pack",
        },
        {
          "annotations": {
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
            "readOnlyHint": false,
          },
          "description": "Use this when the user asks for a local-only ChatGPT handoff: skapa handoff, create handoff, skriv handoff, session handoff, or resume note. It writes .chatgpt/handoffs/*.local.md and updates current.local.md without Git mutation.",
          "inputKeys": [
            "completed_work",
            "constraints",
            "current_state",
            "current_track",
            "decisions",
            "dry_run",
            "important_files",
            "next_steps",
            "open_questions",
            "repo_id",
            "risks",
            "title",
            "update_current",
            "why",
            "workflow",
          ],
          "name": "repo_write_handoff",
          "outputKeys": [
            "branch",
            "clean",
            "current_next_step",
            "current_path",
            "dry_run",
            "handoff_path",
            "head_sha",
            "ok",
            "startup_prompt",
            "updated_current",
            "warnings",
          ],
          "title": "Create ChatGPT handoff",
        },
      ]
    `);
  });

  test("legacy catalog, handler, and tool-name imports preserve their complete compatibility surface", () => {
    const legacyDefinitions: readonly ToolDefinition[] = toolCatalog;
    const legacyNames: ToolName[] = legacyDefinitions.map((tool) => tool.name);

    expect(legacyNames).toEqual(CANONICAL_TOOL_ORDER);
    expect(Object.keys(handlerExports).sort()).toEqual([
      "agentRunsHandler",
      "applyPatchsetHandler",
      "changePlanHandler",
      "cleanupPathsHandler",
      "codeIndexHandler",
      "codexReviewHandler",
      "contextMapHandler",
      "currentWorkSessionHandler",
      "decisionMemoryHandler",
      "failureDiagnoseHandler",
      "fetchFileHandler",
      "gitDiffHandler",
      "gitRestorePathsHandler",
      "gitReviewHandler",
      "gitStatusHandler",
      "lastWriteHandler",
      "listRootsHandler",
      "operationLedgerHandler",
      "policyExplainHandler",
      "prepareCodexTaskHandler",
      "preparePatchsetHandler",
      "projectBriefHandler",
      "readManyHandler",
      "reviewPatchsetHandler",
      "rollbackPatchsetHandler",
      "searchHandler",
      "semanticReviewHandler",
      "shipReviewHandler",
      "startWorkSessionHandler",
      "symbolContextHandler",
      "taskInventoryHandler",
      "treeHandler",
      "updateWorkSessionHandler",
      "validateHandler",
      "writeAgentReplyHandler",
      "writeChangesHandler",
      "writeCodexReviewHandler",
      "writeCodexTaskHandler",
      "writeCommitHandler",
      "writeFileHandler",
      "writeHandoffHandler",
      "writeIntegrationReviewHandler",
      "writeRecoverHandler",
      "writeStageCommitHandler",
      "writeStageHandler",
      "writeUnstageHandler"
    ]);
    for (const handler of Object.values(handlerExports)) expect(handler).toBeTypeOf("function");
  });

  test("legacy catalog and handler imports are thin compatibility barrels", () => {
    const catalogSource = readFileSync("src/tools/catalog.ts", "utf8");
    const handlerSource = readFileSync("src/tools/handlers.ts", "utf8");

    expect(catalogSource).toContain("toolRegistry as toolCatalog");
    expect(catalogSource).not.toContain("name: \"repo_");
    expect(handlerSource).toContain("./handlers/developer.js");
    expect(handlerSource).toContain("./handlers/delegation.js");
    expect(handlerSource).toContain("./handlers/patchsets.js");
    expect(handlerSource).not.toMatch(/new\s+\w+Service\s*\(/);
    expect(handlerSource.split(/\r?\n/).filter(Boolean).length).toBeLessThanOrEqual(10);
  });

  test("catalog does not define inline zod schemas", () => {
    const source = readFileSync("src/tools/catalog.ts", "utf8");

    expect(source).not.toMatch(/\binputSchema:\s*{/);
    expect(source).not.toMatch(/\boutputSchema:\s*{/);
    expect(source).not.toMatch(/\bz\.(object|string|number|boolean|array|enum|record|union|literal)\s*\(/);
    expect(source).not.toMatch(/\.shape\b/);
  });
});

function contractSummaries(names: string[]) {
  return names.map((name) => {
    const tool = toolCatalog.find((candidate) => candidate.name === name);
    expect(tool, `${name} should exist`).toBeDefined();
    return {
      name,
      mutating: tool!.annotations.readOnlyHint === false,
      inputKeys: Object.keys(tool!.inputSchema.shape).sort(),
      outputKeys: Object.keys(tool!.outputSchema.shape).sort()
    };
  });
}
