import { CodexTaskInputSchema, CodexTaskWriteInputSchema, type CodexTask, type CodexTaskInput, type CodexTaskResult, type CodexTaskWrite, type CodexTaskWriteInput, type CodexTaskWriteResult } from "../contracts/codex-task.contract.js";
import { FileWriter } from "./file-writer.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { WritePolicy } from "./write-policy.js";

const CODEX_RUN_DIR = ".chatgpt/codex-runs";

export class CodexTaskService {
  private readonly writer: FileWriter;

  constructor(
    root: string,
    sandbox: PathSandbox,
    policy: WritePolicy,
    private readonly now: () => Date = () => new Date()
  ) {
    this.writer = new FileWriter(root, sandbox, policy);
  }

  prepare(rawInput: CodexTaskInput): CodexTaskResult {
    const input = CodexTaskInputSchema.parse(rawInput);
    const runId = input.run_id ?? createRunId(input.title, this.now());
    const paths = codexRunPaths(runId);
    const promptMarkdown = renderPrompt(input, runId, paths);
    return {
      ok: true,
      repo_id: input.repo_id,
      run_id: runId,
      prompt_path: paths.promptPath,
      result_path: paths.resultPath,
      manifest_path: paths.manifestPath,
      prompt_markdown: promptMarkdown,
      codex_user_prompt: `Implement ${paths.promptPath}`,
      next_steps: [
        "This tool did not write PROMPT.md. If Codex should implement from a repo path, call repo_write_codex_task with the same task fields before giving codex_user_prompt to Codex.",
        "Use codex_user_prompt directly only for chat-copy mode where you paste the rendered prompt into Codex yourself.",
        "After Codex finishes, run repo_codex_review for this run_id to review RESULT.md and the git diff."
      ],
      warnings: []
    };
  }

  async write(rawInput: CodexTaskWriteInput): Promise<CodexTaskWriteResult> {
    const input = CodexTaskWriteInputSchema.parse(rawInput);
    const prepared = this.prepare(input);
    const dryRun = input.dry_run ?? false;
    const manifest = renderManifest(input, prepared);
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
    if (!dryRun && promptWrite.changed) {
      writtenPaths.push(prepared.prompt_path);
    }

    const manifestWrite = await this.writer.write({
      path: prepared.manifest_path,
      action: "write",
      content: manifest,
      create_dirs: true,
      dry_run: dryRun,
      reason: input.reason
    });
    warnings.push(...manifestWrite.warnings);
    if (!dryRun && manifestWrite.changed) {
      writtenPaths.push(prepared.manifest_path);
    }

    return {
      ...prepared,
      dry_run: dryRun,
      written_paths: writtenPaths,
      warnings
    };
  }
}

export function codexRunPaths(runId: string) {
  const normalized = validateRepoPath(`${CODEX_RUN_DIR}/${runId}`);
  if (!normalized.startsWith(`${CODEX_RUN_DIR}/`) || normalized.split("/").length !== 3) {
    throw new Error("Invalid Codex run id.");
  }
  return {
    promptPath: `${normalized}/PROMPT.md`,
    resultPath: `${normalized}/RESULT.md`,
    manifestPath: `${normalized}/run.json`
  };
}

function createRunId(title: string, date: Date): string {
  const timestamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-") + "T" + [
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0")
  ].join("") + "Z";
  return `${timestamp}-${slugify(title)}`;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "codex-task";
}

function renderPrompt(input: CodexTask, runId: string, paths: ReturnType<typeof codexRunPaths>): string {
  const forbidden = input.forbidden_paths.length > 0 ? input.forbidden_paths : [
    ".env*",
    ".git/**",
    "node_modules/**",
    "**/node_modules/**",
    "dist/**",
    "**/dist/**",
    "coverage/**",
    "**/coverage/**",
    "test-results/**",
    "**/test-results/**",
    ".chatgpt/** except this run's RESULT.md"
  ];
  return [
    "# Codex Task",
    "",
    `Run ID: ${runId}`,
    "",
    "## Objective",
    input.objective,
    "",
    ...(input.context_summary ? ["## Context Summary", input.context_summary, ""] : []),
    renderList("Inspect First", input.inspect_first),
    renderList("Allowed Paths", input.allowed_paths),
    renderList("Forbidden Paths", forbidden),
    renderScope(input),
    renderList("Acceptance Criteria", input.acceptance_criteria),
    renderList("Verification Commands", input.verification_commands),
    "## Completion Contract",
    "",
    "Before your final chat response, write this file:",
    "",
    `\`${paths.resultPath}\``,
    "",
    "Use this exact structure:",
    "",
    "```md",
    "# CODEX_RESULT",
    "",
    "status: completed | blocked",
    "summary: <one-line summary>",
    "changed_files:",
    "commands_run:",
    "tests:",
    "acceptance_criteria:",
    "blockers:",
    "followups:",
    "```",
    "",
    "Then print the same result in the Codex chat.",
    "",
    "Do not stage, commit, push, or edit unrelated files.",
    "Do not edit `.chatgpt/**` except this run's `RESULT.md`.",
    ""
  ].filter((section) => section !== "").join("\n");
}

function renderManifest(input: CodexTaskWrite, prepared: CodexTaskResult): string {
  return `${JSON.stringify({
    schema_version: 1,
    repo_id: prepared.repo_id,
    run_id: prepared.run_id,
    title: input.title,
    objective: input.objective,
    prompt_path: prepared.prompt_path,
    result_path: prepared.result_path,
    inspect_first: input.inspect_first,
    allowed_paths: input.allowed_paths,
    forbidden_paths: input.forbidden_paths,
    verification_commands: input.verification_commands,
    created_at: prepared.run_id.match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z/)?.[0] ?? null
  }, null, 2)}\n`;
}

function renderList(title: string, values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }
  return [`## ${title}`, "", ...values.map((value) => `- ${value}`), ""].join("\n");
}

function renderScope(input: CodexTask): string {
  if (!input.implementation_scope || (input.implementation_scope.include.length === 0 && input.implementation_scope.exclude.length === 0)) {
    return "";
  }
  return [
    "## Implementation Scope",
    "",
    ...(input.implementation_scope.include.length > 0 ? ["Include:", ...input.implementation_scope.include.map((value) => `- ${value}`), ""] : []),
    ...(input.implementation_scope.exclude.length > 0 ? ["Exclude:", ...input.implementation_scope.exclude.map((value) => `- ${value}`), ""] : [])
  ].join("\n");
}
