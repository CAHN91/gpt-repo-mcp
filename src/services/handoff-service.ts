import { HandoffInputSchema, type HandoffInput, type HandoffResult, type HandoffNextStep } from "../contracts/handoff.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { FileWriter } from "./file-writer.js";
import type { GitService } from "./git-service.js";
import { formatLocalHandoffMinuteTimestamp, slugifyLabel } from "./local-id.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { WritePolicy } from "./write-policy.js";

const HANDOFF_DIR = ".chatgpt/handoffs";
const CURRENT_PATH = `${HANDOFF_DIR}/current.local.md`;

type GitStatusService = Pick<GitService, "status">;

type GitStatus = Awaited<ReturnType<GitStatusService["status"]>>;

export class HandoffService {
  private readonly writer: FileWriter;

  constructor(
    root: string,
    sandbox: PathSandbox,
    policy: WritePolicy,
    private readonly gitService: GitStatusService,
    private readonly now: () => Date = () => new Date()
  ) {
    this.writer = new FileWriter(root, sandbox, policy);
  }

  async write(rawInput: HandoffInput): Promise<HandoffResult> {
    const input = HandoffInputSchema.parse(rawInput);
    const status = await this.gitService.status();
    const handoffPath = detailedHandoffPath(input.title, this.now());
    assertHandoffPath(handoffPath);
    assertCurrentPath(CURRENT_PATH);

    const updateCurrent = input.update_current !== false;
    const dryRun = input.dry_run ?? false;
    const startupPrompt = renderStartupPrompt(input.repo_id, handoffPath);
    const handoffMarkdown = renderDetailedHandoff(input, status, handoffPath, startupPrompt);
    const warnings: string[] = [];

    const handoffWrite = await this.writer.write({
      path: handoffPath,
      action: "write",
      content: handoffMarkdown,
      create_dirs: true,
      dry_run: dryRun
    });
    warnings.push(...handoffWrite.warnings);

    if (updateCurrent) {
      const currentWrite = await this.writer.write({
        path: CURRENT_PATH,
        action: "write",
        content: renderCurrentPointer(input, status, handoffPath, startupPrompt),
        create_dirs: true,
        dry_run: dryRun
      });
      warnings.push(...currentWrite.warnings);
    }

    return {
      ok: true,
      dry_run: dryRun,
      handoff_path: handoffPath,
      ...(updateCurrent ? { current_path: CURRENT_PATH } : {}),
      updated_current: updateCurrent,
      branch: status.branch,
      head_sha: status.head_sha,
      clean: status.clean,
      startup_prompt: startupPrompt,
      current_next_step: input.next_steps[0].title,
      warnings
    };
  }
}

function detailedHandoffPath(title: string, date: Date): string {
  return `${HANDOFF_DIR}/${formatLocalHandoffMinuteTimestamp(date)}-${slugifyLabel(title, "handoff")}.local.md`;
}

function assertHandoffPath(path: string): void {
  const normalized = validateRepoPath(path);
  if (!normalized.startsWith(`${HANDOFF_DIR}/`)) {
    throw new RepoReaderError("PATH_TRAVERSAL_REJECTED", `Handoff path must stay under ${HANDOFF_DIR}`);
  }
  if (!normalized.endsWith(".local.md")) {
    throw new RepoReaderError("VALIDATION_ERROR", "Detailed handoff path must end with .local.md");
  }
}

function assertCurrentPath(path: string): void {
  if (validateRepoPath(path) !== CURRENT_PATH) {
    throw new RepoReaderError("VALIDATION_ERROR", `Current handoff pointer must be ${CURRENT_PATH}`);
  }
}

function renderDetailedHandoff(input: HandoffInput, status: GitStatus, handoffPath: string, startupPrompt: string): string {
  return [
    `# ${input.title}`,
    "",
    "## Summary",
    optionalLine("Track", input.current_track),
    `State: ${input.current_state}`,
    `Why: ${input.why}`,
    "",
    "## Git",
    `- Branch: ${status.branch}`,
    `- Head: ${status.head_sha}`,
    `- Clean: ${status.clean}`,
    "",
    renderListSection("Completed Work", input.completed_work),
    renderListSection("Decisions", input.decisions),
    renderListSection("Workflow", input.workflow),
    renderListSection("Constraints", input.constraints),
    renderNextSteps(input.next_steps),
    renderListSection("Important Files", input.important_files),
    renderListSection("Risks", input.risks),
    renderListSection("Open Questions", input.open_questions),
    "## Startup Prompt",
    startupPrompt,
    "",
    "## Local Metadata",
    `- Handoff: ${handoffPath}`,
    `- Current pointer: ${CURRENT_PATH}`,
    ""
  ].filter((section) => section !== "").join("\n");
}

function renderCurrentPointer(input: HandoffInput, status: GitStatus, handoffPath: string, startupPrompt: string): string {
  return [
    "# Current Handoff",
    "",
    `- Title: ${input.title}`,
    `- Handoff: ${handoffPath}`,
    `- Branch: ${status.branch}`,
    `- Head: ${status.head_sha}`,
    `- Clean: ${status.clean}`,
    `- Current next step: ${input.next_steps[0].title}`,
    "",
    "## Startup Prompt",
    startupPrompt,
    ""
  ].join("\n");
}

function renderStartupPrompt(repoId: string, handoffPath: string): string {
  return [
    `Använd GPT-Repo-MCP mot repo_id \`${repoId}\`.`,
    `Läs \`${CURRENT_PATH}\` och sedan \`${handoffPath}\`.`,
    "Kör `repo_git_status`.",
    "Fortsätt från handoffens \"Next steps\"."
  ].join("\n");
}

function renderListSection(title: string, values?: string[]): string {
  if (!values?.length) {
    return "";
  }
  return [
    `## ${title}`,
    ...values.map((value) => `- ${value}`),
    ""
  ].join("\n");
}

function renderNextSteps(steps: HandoffNextStep[]): string {
  return [
    "## Next Steps",
    ...steps.flatMap((step, index) => [
      `### ${index + 1}. ${step.title}`,
      ...(step.goal ? [`- Goal: ${step.goal}`] : []),
      ...(step.done_when ? [`- Done when: ${step.done_when}`] : []),
      ""
    ])
  ].join("\n");
}

function optionalLine(label: string, value?: string): string {
  return value ? `${label}: ${value}` : "";
}
