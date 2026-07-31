import { CodexTaskInputSchema, CodexTaskWriteInputSchema, type CodexTask, type CodexTaskInput, type CodexTaskResult, type CodexTaskWrite, type CodexTaskWriteInput, type CodexTaskWriteResult } from "../../src/contracts/codex-task.contract.js";
import { FileWriter } from "../../src/services/file-writer.js";
import { GitService } from "../../src/services/git-service.js";
import { PathSandbox } from "../../src/services/path-sandbox.js";
import { codexRunPaths, createCodexRunId } from "../../src/services/codex-run-paths.js";
import { bindPromptToBaseline, isCodexRunArtifact, sha256Text, taskWarnings } from "../../src/services/codex-task-policy.js";
import { renderCodexManifestWithLineage, renderCodexPrompt } from "../../src/legacy/codex-v2/renderer.js";
import { WritePolicy } from "../../src/services/write-policy.js";
import { RepoReaderError } from "../../src/runtime/errors.js";
import {
  assertCorrectiveScope,
  resolveCorrectiveLineage,
  withCorrectiveLineageLock,
  type CodexCorrectiveLineage
} from "../../src/services/codex-lineage-service.js";
import type { CodexRunManifestV2 } from "../../src/services/codex-run-manifest.js";

export class LegacyCodexV2TaskFixture {
  private readonly writer: FileWriter;
  private readonly git: GitService;

  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    policy: WritePolicy,
    private readonly now: () => Date = () => new Date()
  ) {
    this.writer = new FileWriter(root, sandbox, policy);
    this.git = new GitService(root);
  }

  prepare(rawInput: CodexTaskInput): CodexTaskResult {
    const input = CodexTaskInputSchema.parse(rawInput) as CodexTask;
    if (input.parent_run_id) {
      throw new RepoReaderError("RUNNER_POLICY_BLOCKED", "Corrective child tasks require repo_write_codex_task so the parent and fresh baseline can be verified.");
    }
    return this.prepareTask(input);
  }

  private prepareTask(input: CodexTask, lineage?: CodexCorrectiveLineage): CodexTaskResult {
    if (input.runner.mode === "queued" && input.runner.requested_runner !== "codex_sdk") {
      throw new RepoReaderError("RUNNER_PROVIDER_UNAVAILABLE", "New queued tasks may select only adapters runnable in this installation.");
    }
    const runId = input.run_id ?? createCodexRunId(input.title, this.now());
    const paths = codexRunPaths(runId);
    const promptMarkdown = renderCodexPrompt(input, runId, paths, lineage ? { lineage } : {});
    return {
      ok: true,
      repo_id: input.repo_id,
      run_id: runId,
      prompt_path: paths.promptPath,
      result_path: paths.resultPath,
      result_json_path: paths.resultJsonPath,
      manifest_path: paths.manifestPath,
      prompt_sha256: sha256Text(promptMarkdown),
      prompt_byte_count: Buffer.byteLength(promptMarkdown, "utf8"),
      prompt_markdown: promptMarkdown,
      codex_user_prompt: `Implement ${paths.promptPath}`,
      next_steps: [
        "This tool did not write PROMPT.md. If Codex should implement from a repo path, call repo_write_codex_task with the same task fields before giving codex_user_prompt to Codex.",
        "Use codex_user_prompt directly only for chat-copy mode where you paste the rendered prompt into Codex yourself.",
        "After Codex finishes, run repo_codex_review for this run_id to verify RESULT.json, task scope, and the git diff."
      ],
      warnings: taskWarnings(input)
    };
  }

  async write(rawInput: CodexTaskWriteInput): Promise<CodexTaskWriteResult> {
    const input = CodexTaskWriteInputSchema.parse(rawInput) as CodexTaskWrite;
    if (!input.parent_run_id) return this.writeTask(input);
    return withCorrectiveLineageLock(this.root, input.parent_run_id, async () => {
      const lineageContext = await resolveCorrectiveLineage(this.root, this.sandbox, input.repo_id, input.parent_run_id!);
      return this.writeTask(input, lineageContext);
    });
  }

  private async writeTask(
    input: CodexTaskWrite,
    lineageContext?: { lineage: CodexCorrectiveLineage; parent: CodexRunManifestV2; children_created: number }
  ): Promise<CodexTaskWriteResult> {
    const resolvedInput = lineageContext ? inheritCorrectiveTaskScope(input, lineageContext.parent) : input;
    const basePrepared = this.prepareTask(resolvedInput, lineageContext?.lineage);
    const dryRun = input.dry_run ?? false;
    const baseline = await this.captureBaseline(basePrepared.run_id);
    const promptMarkdown = bindPromptToBaseline(basePrepared.prompt_markdown, baseline);
    const prepared: CodexTaskResult = {
      ...basePrepared,
      prompt_markdown: promptMarkdown,
      prompt_sha256: sha256Text(promptMarkdown),
      prompt_byte_count: Buffer.byteLength(promptMarkdown, "utf8")
    };
    const manifest = renderCodexManifestWithLineage(resolvedInput, prepared, baseline, lineageContext?.lineage);
    const writtenPaths: string[] = [];
    const warnings: string[] = [...prepared.warnings];

    const promptWrite = await this.writer.write({
      path: prepared.prompt_path,
      action: "write",
      content: prepared.prompt_markdown,
      create_dirs: true,
      dry_run: dryRun,
      reason: input.reason
    });
    warnings.push(...promptWrite.warnings);
    if (!dryRun && promptWrite.changed) writtenPaths.push(prepared.prompt_path);

    const manifestWrite = await this.writer.write({
      path: prepared.manifest_path,
      action: "write",
      content: manifest,
      create_dirs: true,
      dry_run: dryRun,
      reason: input.reason
    });
    warnings.push(...manifestWrite.warnings);
    if (!dryRun && manifestWrite.changed) writtenPaths.push(prepared.manifest_path);

    const { prompt_markdown: returnedPromptMarkdown, ...compactPrepared } = prepared;
    return {
      ...compactPrepared,
      ...(input.include_prompt ? { prompt_markdown: returnedPromptMarkdown } : {}),
      dry_run: dryRun,
      written_paths: writtenPaths,
      ...(!dryRun ? {
        next_tool_payloads: {
          repo_agent_runs: { repo_id: prepared.repo_id, run_id: prepared.run_id }
        }
      } : {}),
      warnings
    };
  }

  private async captureBaseline(runId: string) {
    const [status, worktreeFingerprint] = await Promise.all([
      this.git.status(),
      this.git.worktreeFingerprint()
    ]);
    const initialChangedPaths = status.files
      .flatMap((file) => [file.original_path, file.path])
      .filter((path): path is string => typeof path === "string")
      .filter((path) => !isCodexRunArtifact(path, runId) && !path.startsWith(".chatgpt/"));
    return {
      head_sha: status.head_sha,
      worktree_fingerprint: worktreeFingerprint,
      initial_changed_paths: [...new Set(initialChangedPaths)].sort((left, right) => left.localeCompare(right))
    };
  }

}

function inheritCorrectiveTaskScope(
  input: CodexTaskWrite,
  parent: import("../../src/services/codex-run-manifest.js").CodexRunManifestV2
): CodexTaskWrite {
  const allowedPaths = input.allowed_paths.length > 0 ? input.allowed_paths : parent.allowed_paths;
  assertCorrectiveScope(parent, allowedPaths);
  const forbiddenPaths = [...new Set([...parent.caller_forbidden_paths, ...input.forbidden_paths])];
  const acceptanceCriteria = input.acceptance_criteria.length > 0
    ? input.acceptance_criteria
    : parent.acceptance_criteria;
  return {
    ...input,
    allowed_paths: allowedPaths,
    forbidden_paths: forbiddenPaths,
    inspect_first: input.inspect_first.length > 0 ? input.inspect_first : parent.inspect_first,
    acceptance_criteria: acceptanceCriteria,
    ...(input.implementation_scope ? {} : parent.implementation_scope ? { implementation_scope: parent.implementation_scope } : {}),
    runner: input.runner.mode === "manual" && parent.runner ? parent.runner : input.runner,
    parent_run_id: undefined,
    run_id: input.run_id === parent.run_id ? undefined : input.run_id
  };
}

export { codexRunPaths } from "../../src/services/codex-run-paths.js";
