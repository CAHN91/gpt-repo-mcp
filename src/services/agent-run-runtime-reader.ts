import { DelegationAttemptStore } from "../delegation/attempt-store.js";
import { DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS, type AgentRunnerStatus } from "../delegation/artifact-contracts.js";
import { DelegationInteractionStore } from "../delegation/interaction-store.js";
import type { DelegationRunRecord } from "../delegation/run-store.js";
import { describeAgentRuntimeBudget, type DelegationRuntimeBudget } from "../delegation/runtime-budget.js";

export type AgentRunRuntimeReaderOptions = {
  repository_max_runtime_ms?: number;
  now?: () => Date;
};

export class AgentRunRuntimeReader {
  private readonly attempts: DelegationAttemptStore;
  private readonly interactions: DelegationInteractionStore;
  private readonly repositoryMaxRuntimeMs: number;
  private readonly now: () => Date;

  constructor(root: string, options: AgentRunRuntimeReaderOptions = {}) {
    this.attempts = new DelegationAttemptStore(root);
    this.interactions = new DelegationInteractionStore(root);
    this.repositoryMaxRuntimeMs = options.repository_max_runtime_ms ?? DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS;
    this.now = options.now ?? (() => new Date());
  }

  async read(
    record: DelegationRunRecord,
    status: AgentRunnerStatus | undefined,
    warnings: string[]
  ): Promise<DelegationRuntimeBudget> {
    let activeRuntimeMs = 0;
    let persistedMaxRuntimeMs: number | undefined;
    let sessionFound = false;
    try {
      const session = await this.interactions.readSession(record.repo_id, record.run_id);
      sessionFound = session !== undefined;
      activeRuntimeMs = session?.active_runtime_ms ?? 0;
      persistedMaxRuntimeMs = session?.max_runtime_ms;
    } catch {
      warnings.push("AGENT_RUN_RUNTIME_INVALID");
    }

    const effectiveStatus = status?.status ?? record.runner.mode;
    try {
      const attempt = await this.attempts.read(record.repo_id, record.run_id);
      if (attempt && attempt.provider === status?.runner) {
        if (attempt.state === "in_flight" && ["claimed", "running"].includes(effectiveStatus)) {
          const elapsed = elapsedMs(attempt.started_at, this.now().getTime());
          const provisional = describeAgentRuntimeBudget(
            this.repositoryMaxRuntimeMs,
            record.runner.max_runtime_ms,
            activeRuntimeMs,
            persistedMaxRuntimeMs
          );
          activeRuntimeMs += Math.min(elapsed, provisional.remaining_runtime_ms);
        } else if (attempt.state === "settled" && !sessionFound) {
          activeRuntimeMs += elapsedMs(attempt.started_at, Date.parse(attempt.updated_at));
        }
      }
    } catch {
      warnings.push("AGENT_RUN_RUNTIME_INVALID");
    }

    if (
      record.runner.max_runtime_ms !== undefined
      && record.runner.max_runtime_ms > this.repositoryMaxRuntimeMs
    ) warnings.push("AGENT_RUN_RUNTIME_CLAMPED");

    return describeAgentRuntimeBudget(
      this.repositoryMaxRuntimeMs,
      record.runner.max_runtime_ms,
      activeRuntimeMs,
      persistedMaxRuntimeMs
    );
  }
}

function elapsedMs(startedAt: string, endedAt: number): number {
  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAtMs)
    : 0;
}
