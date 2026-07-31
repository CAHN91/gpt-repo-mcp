import { timingSafeEqual } from "node:crypto";
import { DelegationInteractionStore, interactionPaths } from "../delegation/interaction-store.js";
import { DelegationRunStore, runPaths } from "../delegation/run-store.js";
import { AgentReplyInputSchema, type AgentReplyInput, type AgentReplyResult } from "../contracts/agent-reply.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { AgentRunsService, type AgentRunsServiceOptions } from "./agent-runs-service.js";
import { PathSandbox } from "./path-sandbox.js";

export class AgentReplyService {
  private readonly runs: DelegationRunStore;
  private readonly interactions: DelegationInteractionStore;
  private readonly agentRuns: AgentRunsService;

  constructor(
    root: string,
    private readonly sandbox: PathSandbox,
    agentRunsOptions: AgentRunsServiceOptions = {}
  ) {
    this.runs = new DelegationRunStore(root);
    this.interactions = new DelegationInteractionStore(root);
    this.agentRuns = new AgentRunsService(root, sandbox, agentRunsOptions);
  }

  async write(rawInput: AgentReplyInput): Promise<AgentReplyResult> {
    const input = AgentReplyInputSchema.parse(rawInput);
    await this.assertRegular(runPaths(input.run_id).manifest_path);
    await this.assertRegular(runPaths(input.run_id).status_path);
    const [run, status, session, question] = await Promise.all([
      this.runs.readRun(input.run_id),
      this.runs.readStatus(input.run_id),
      this.interactions.readSession(input.repo_id, input.run_id),
      this.interactions.readQuestion(input.repo_id, input.run_id, input.turn_index)
    ]);
    if (
      run.repo_id !== input.repo_id
      || !status
      || status.repo_id !== input.repo_id
      || status.run_id !== input.run_id
      || status.status !== "awaiting_input"
      || !session
      || session.turn_index !== input.turn_index
    ) {
      throw new RepoReaderError("RUNNER_REPLY_STALE", "The selected run is not awaiting a reply for this turn.");
    }
    if (!question || !safeHashEqual(question.sha256, input.expected_question_sha256)) {
      throw new RepoReaderError("RUNNER_REPLY_STALE", "The expected question hash is stale or does not match the current question.");
    }
    const expectedIds = question.question.questions.map(({ question_id }) => question_id).sort();
    const suppliedIds = input.answers.map(({ question_id }) => question_id).sort();
    if (JSON.stringify(expectedIds) !== JSON.stringify(suppliedIds)) {
      throw new RepoReaderError("RUNNER_REPLY_STALE", "Answers must match every current question_id exactly once.");
    }

    await this.interactions.writeReply({
      repo_id: input.repo_id,
      run_id: input.run_id,
      turn_index: input.turn_index,
      question_sha256: question.sha256,
      answers: input.answers
    });
    const agentRun = await this.agentRuns.read({ repo_id: input.repo_id, run_id: input.run_id });
    return {
      ok: true,
      repo_id: input.repo_id,
      run_id: input.run_id,
      turn_index: input.turn_index,
      written_path: interactionPaths(input.run_id, input.turn_index).reply_path,
      agent_run: agentRun,
      next_tool_payloads: { repo_agent_runs: { repo_id: input.repo_id, run_id: input.run_id } },
      warnings: []
    };
  }

  private async assertRegular(path: string): Promise<void> {
    const resolved = await this.sandbox.resolve(path);
    if (!resolved.stat.isFile() || resolved.stat.isSymbolicLink()) {
      throw new RepoReaderError("RUNNER_INTERACTION_INVALID", "Required runner artifact is unsafe.");
    }
  }
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
