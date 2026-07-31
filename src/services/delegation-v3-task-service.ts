import {
  DelegationPreparedResultV3Schema,
  DelegationRunManifestV3Schema,
  DelegationTaskV3InputSchema,
  DelegationTaskV3ToolInputSchema,
  DelegationTaskV3WriteToolInputSchema,
  DelegationWriteResultV3Schema,
  type DelegationPreparedResultV3Schema as PreparedSchemaType,
  type DelegationProductBindingV3,
  type DelegationTaskV3,
  type DelegationTaskV3ToolInput,
  type DelegationTaskV3WriteToolInput
} from "../contracts/delegation-v3.contract.js";
import type { z } from "zod";
import { RepoReaderError } from "../runtime/errors.js";
import { FileWriter } from "./file-writer.js";
import { GitService } from "./git-service.js";
import { PathSandbox } from "./path-sandbox.js";
import { ProductContractService } from "./product-contract-service.js";
import { WritePolicy } from "./write-policy.js";
import { auditDelegationTaskV3 } from "./delegation-v3-audit.js";
import { DelegationDriftService } from "./delegation-drift-service.js";
import { renderDelegationPromptV3 } from "./delegation-v3-renderer.js";
import {
  DelegationV3LineageService,
  withDelegationV3LineageLock
} from "./delegation-v3-lineage-service.js";
import {
  buildDelegationProductBindingV3,
  delegationBaselineSha256V3,
  delegationTaskSha256V3,
  normalizeDelegationTaskV3,
  reviewRequirementForDelegationTaskV3
} from "./delegation-v3-normalizer.js";
import { codexRunPaths, createCodexRunId } from "./codex-run-paths.js";
import { DelegationGateService } from "./delegation-gate-service.js";
import {
  bindPromptToBaseline,
  effectiveForbiddenPatterns,
  isCodexRunArtifact,
  sha256Text,
  type CodexBaseline
} from "./codex-task-policy.js";

export type DelegationPreparedResultV3 = z.infer<typeof PreparedSchemaType>;

export class DelegationV3TaskService {
  private readonly writer: FileWriter;
  private readonly git: GitService;
  private readonly productContracts: ProductContractService;
  private readonly lineage: DelegationV3LineageService;
  private readonly gates: DelegationGateService;
  private readonly drift: DelegationDriftService;

  constructor(
    private readonly root: string,
    sandbox: PathSandbox,
    private readonly writePolicy: WritePolicy,
    private readonly now: () => Date = () => new Date()
  ) {
    this.writer = new FileWriter(root, sandbox, writePolicy);
    this.git = new GitService(root);
    this.productContracts = new ProductContractService(sandbox);
    this.lineage = new DelegationV3LineageService(root, sandbox);
    this.gates = new DelegationGateService(root);
    this.drift = new DelegationDriftService(root, sandbox);
  }

  async prepare(rawInput: DelegationTaskV3ToolInput): Promise<z.infer<typeof DelegationPreparedResultV3Schema>> {
    const input = DelegationTaskV3ToolInputSchema.parse(rawInput);
    const resolved = await this.resolveTask(input);
    return DelegationPreparedResultV3Schema.parse(this.preparedResult(resolved));
  }

  async write(rawInput: DelegationTaskV3WriteToolInput): Promise<z.infer<typeof DelegationWriteResultV3Schema>> {
    const input = DelegationTaskV3WriteToolInputSchema.parse(rawInput);
    const { dry_run: dryRunInput, reason, ...taskInput } = input;
    const parsedTask = DelegationTaskV3ToolInputSchema.parse(taskInput);
    const dryRun = dryRunInput ?? false;
    const writeTask = () => this.writeTask(parsedTask, dryRun, reason);
    if (!parsedTask.lineage) return writeTask();
    const rootRunId = await this.lineage.rootRunIdForParent(parsedTask.repo_id, parsedTask.lineage.parent_run_id);
    return withDelegationV3LineageLock(this.root, rootRunId, writeTask);
  }

  private async writeTask(
    taskInput: DelegationTaskV3ToolInput,
    dryRun: boolean,
    reason?: string
  ): Promise<z.infer<typeof DelegationWriteResultV3Schema>> {
    const resolved = await this.resolveTask(taskInput);
    const baseline = await this.captureBaseline(resolved.task.run_id!);
    const effectiveForbidden = effectiveForbiddenPatterns(resolved.task.forbidden_paths);
    const paths = codexRunPaths(resolved.task.run_id!);
    const promptWithoutBaseline = renderDelegationPromptV3({
      task: resolved.task,
      runId: resolved.task.run_id!,
      paths,
      productBinding: resolved.productBinding,
      effectiveForbiddenPaths: effectiveForbidden,
      audit: resolved.audit
    });
    const prompt = bindPromptToBaseline(promptWithoutBaseline, baseline);
    const promptSha256 = sha256Text(prompt);
    const manifest = DelegationRunManifestV3Schema.parse({
      schema_version: 3,
      repo_id: resolved.task.repo_id,
      run_id: resolved.task.run_id,
      title: resolved.task.title,
      task_kind: resolved.task.task_kind,
      task: resolved.task,
      prompt_path: paths.promptPath,
      result_json_path: paths.resultJsonPath,
      manifest_path: paths.manifestPath,
      product_binding: resolved.productBinding,
      review_requirement: resolved.reviewRequirement,
      delegation_audit: resolved.audit,
      authorization: {
        starting_points: resolved.task.starting_points,
        caller_scope: resolved.task.authorization_scope,
        effective_scope: resolved.task.authorization_scope,
        caller_forbidden_paths: resolved.task.forbidden_paths,
        effective_forbidden_paths: effectiveForbidden
      },
      baseline,
      baseline_sha256: delegationBaselineSha256V3(baseline),
      task_sha256: delegationTaskSha256V3(resolved.task),
      prompt_sha256: promptSha256,
      prompt_byte_count: Buffer.byteLength(prompt, "utf8"),
      created_at: this.now().toISOString()
    });
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const warnings = [...resolved.warnings];
    const writtenPaths: string[] = [];

    const promptWrite = await this.writer.write({
      path: paths.promptPath,
      action: "write",
      content: prompt,
      create_dirs: true,
      dry_run: dryRun,
      reason
    });
    warnings.push(...promptWrite.warnings);
    if (!dryRun && promptWrite.changed) writtenPaths.push(paths.promptPath);

    const manifestWrite = await this.writer.write({
      path: paths.manifestPath,
      action: "write",
      content: manifestText,
      create_dirs: true,
      dry_run: dryRun,
      reason
    });
    warnings.push(...manifestWrite.warnings);
    if (!dryRun && manifestWrite.changed) writtenPaths.push(paths.manifestPath);

    const gateWrite = await this.gates.ensureGate({
      manifest,
      write_policy: this.writePolicy,
      dry_run: dryRun
    });
    if (!dryRun && gateWrite.written) writtenPaths.push(gateWrite.gate_path);

    return DelegationWriteResultV3Schema.parse({
      ...this.preparedResult(resolved),
      dry_run: dryRun,
      written_paths: writtenPaths,
      ...(!dryRun ? {
        next_tool_payloads: {
          repo_agent_runs: { repo_id: resolved.task.repo_id, run_id: resolved.task.run_id }
        }
      } : {}),
      warnings: [...new Set(warnings)]
    });
  }

  private async resolveTask(input: DelegationTaskV3ToolInput): Promise<{
    task: DelegationTaskV3;
    productBinding: DelegationProductBindingV3;
    reviewRequirement: "product_required" | "technical_only";
    audit: ReturnType<typeof auditDelegationTaskV3>;
    warnings: string[];
  }> {
    const runId = input.run_id ?? createCodexRunId(input.title, this.now());
    if (input.lineage) {
      const child = await this.lineage.resolveChild(input, runId);
      const audit = await this.auditWithHistoricalDrift(child.task, child.productBinding, child.governanceMode);
      if (audit.verdict === "blocked") {
        throw new RepoReaderError("RUNNER_POLICY_BLOCKED", "Delegation v3 child task failed repository governance checks.");
      }
      return {
        task: child.task,
        productBinding: child.productBinding,
        reviewRequirement: child.reviewRequirement,
        audit,
        warnings: [...new Set([
          ...audit.warnings,
          child.task.lineage?.kind === "scope_amendment"
            ? "DELEGATION_V3_SCOPE_AMENDMENT_CHILD"
            : "DELEGATION_V3_CORRECTIVE_CHILD"
        ])]
      };
    }

    const task = normalizeDelegationTaskV3(DelegationTaskV3InputSchema.parse({ ...input, run_id: runId }));
    const warnings: string[] = [];
    let productBinding: DelegationProductBindingV3;
    let mode: "advisory" | "enforce" = "advisory";
    if ("product_alignment" in task) {
      const selection = await this.productContracts.select({
        primary_user_id: task.product_alignment.primary_user_id,
        job_ids: task.product_alignment.job_ids
      });
      productBinding = buildDelegationProductBindingV3(task, selection);
      mode = selection.snapshot.governance.mode;
    } else {
      const productContext = await this.productContracts.load();
      if (productContext.status === "configured") {
        mode = productContext.contract.governance.mode;
      } else {
        warnings.push(productContext.diagnostic.code);
      }
      productBinding = buildDelegationProductBindingV3(task);
    }

    const audit = await this.auditWithHistoricalDrift(task, productBinding, mode);
    warnings.push(...audit.warnings);
    if (audit.verdict === "blocked") {
      throw new RepoReaderError("RUNNER_POLICY_BLOCKED", "Delegation v3 task failed repository governance checks.");
    }
    return {
      task,
      productBinding,
      reviewRequirement: reviewRequirementForDelegationTaskV3(task),
      audit,
      warnings: [...new Set(warnings)]
    };
  }

  private async auditWithHistoricalDrift(
    task: DelegationTaskV3,
    productBinding: DelegationProductBindingV3,
    mode: "advisory" | "enforce"
  ): Promise<ReturnType<typeof auditDelegationTaskV3>> {
    const audit = auditDelegationTaskV3(task, productBinding, mode);
    const historical = await this.drift.analyze(task.repo_id);
    if (historical.signals.length === 0) return audit;
    const signals = [...new Set([...audit.signals, ...historical.signals])].slice(0, 50);
    const warnings = [...new Set([...audit.warnings, ...historical.signals])].slice(0, 50);
    return {
      ...audit,
      verdict: audit.verdict === "blocked" ? "blocked" : "passed_with_warnings",
      signals,
      warnings
    };
  }

  private preparedResult(resolved: {
    task: DelegationTaskV3;
    productBinding: DelegationProductBindingV3;
    reviewRequirement: "product_required" | "technical_only";
    audit: ReturnType<typeof auditDelegationTaskV3>;
    warnings: string[];
  }) {
    const paths = codexRunPaths(resolved.task.run_id!);
    return {
      ok: true as const,
      schema_version: 3 as const,
      repo_id: resolved.task.repo_id,
      run_id: resolved.task.run_id!,
      task_kind: resolved.task.task_kind,
      prompt_path: paths.promptPath,
      result_json_path: paths.resultJsonPath,
      manifest_path: paths.manifestPath,
      review_requirement: resolved.reviewRequirement,
      review_gate_path: paths.reviewGatePath,
      ...(resolved.task.lineage ? {
        lineage: {
          kind: resolved.task.lineage.kind,
          parent_run_id: resolved.task.lineage.parent_run_id,
          root_run_id: resolved.task.lineage.root_run_id,
          child_index: resolved.task.lineage.child_index,
          max_children: resolved.task.lineage.max_children
        }
      } : {}),
      ...(resolved.productBinding.kind === "selected"
        ? { product_contract_sha256: resolved.productBinding.contract_sha256 }
        : {}),
      delegation_audit: resolved.audit,
      warnings: resolved.warnings
    };
  }

  private async captureBaseline(runId: string): Promise<CodexBaseline> {
    const [status, worktreeFingerprint] = await Promise.all([
      this.git.status(),
      this.git.worktreeFingerprint()
    ]);
    const initialChangedPaths = status.files
      .flatMap((file) => [file.original_path, file.path])
      .filter((path): path is string => typeof path === "string")
      .filter((path) => !isCodexRunArtifact(path, runId) && !path.startsWith(".chatgpt/"));
    const paths = [...new Set(initialChangedPaths)].sort((left, right) => left.localeCompare(right));
    return {
      head_sha: status.head_sha,
      worktree_fingerprint: worktreeFingerprint,
      initial_changed_paths: paths,
      initial_path_states: await this.git.pathStates(paths)
    };
  }
}
