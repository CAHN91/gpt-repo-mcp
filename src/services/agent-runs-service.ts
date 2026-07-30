import {
  AGENT_RUNNER_RUNS_DIR,
  type AgentRunnerStatus
} from "../delegation/artifact-contracts.js";
import { createHash } from "node:crypto";
import { DelegationRunStore, runPaths, type DelegationRunRecord } from "../delegation/run-store.js";
import { DelegationInteractionStore } from "../delegation/interaction-store.js";
import {
  AgentRunsInputSchema,
  type AgentRunDetail,
  type AgentRunEffectiveStatus,
  type AgentRunSummary,
  type AgentRunsInput,
  type AgentRunsResult
} from "../contracts/agent-runs.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import { AgentRunEventsReader } from "./agent-run-events-reader.js";
import { AgentRunRuntimeReader, type AgentRunRuntimeReaderOptions } from "./agent-run-runtime-reader.js";
import { DelegationSupervisorStore } from "../delegation/supervisor-store.js";
import type { AgentRunnerSupervisorState } from "../delegation/artifact-contracts.js";
import { encodeListCursor, parseListCursor } from "./agent-runs-cursor.js";
import {
  boundedAgentRunWarnings,
  publicAgentRunnerMetadata,
  sanitizeAgentRunScalar,
  sanitizeAgentRunStatus
} from "./agent-run-public-state.js";
import { PathSandbox } from "./path-sandbox.js";
import { DelegationDriftService } from "./delegation-drift-service.js";

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_EVENTS = 25;
const MAX_DISCOVERED_RUNS = 1_000;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_STATUS_BYTES = 256 * 1024;

type LoadedSummary = { summary: AgentRunSummary; status?: AgentRunnerStatus; record: DelegationRunRecord };

export type AgentRunsServiceOptions = AgentRunRuntimeReaderOptions;

type AgentRunsRuntimeOptions = AgentRunsServiceOptions & {
  sleep?: (milliseconds: number) => Promise<void>;
};

export class AgentRunsService {
  private readonly store: DelegationRunStore;
  private readonly eventReader: AgentRunEventsReader;
  private readonly interactions: DelegationInteractionStore;
  private readonly runtimeReader: AgentRunRuntimeReader;
  private readonly supervisor: DelegationSupervisorStore;
  private readonly drift: DelegationDriftService;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    root: string,
    private readonly sandbox: PathSandbox,
    options: AgentRunsRuntimeOptions = {}
  ) {
    this.store = new DelegationRunStore(root);
    this.eventReader = new AgentRunEventsReader(sandbox);
    this.interactions = new DelegationInteractionStore(root);
    this.runtimeReader = new AgentRunRuntimeReader(root, options);
    this.supervisor = new DelegationSupervisorStore(root);
    this.drift = new DelegationDriftService(root, sandbox);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async read(rawInput: AgentRunsInput): Promise<AgentRunsResult> {
    const input = AgentRunsInputSchema.parse(rawInput);
    await this.waitForRevision(input);
    const supervisor = await this.readSupervisor();
    return input.run_id ? this.detail(input, supervisor) : this.list(input, supervisor);
  }

  private async list(input: AgentRunsInput, supervisor: AgentRunsResult["supervisor"]): Promise<AgentRunsResult> {
    const rootState = await this.runsRootState();
    if (rootState !== "ready") {
      const driftSummary = await this.drift.analyze(input.repo_id, { records: [] });
      return emptyList(
        input.repo_id,
        rootState === "missing" ? [] : ["AGENT_RUNS_DIRECTORY_UNSAFE"],
        await this.listRevision(supervisor?.revision, []),
        supervisor,
        driftSummary
      );
    }

    const warnings: string[] = [];
    const discovered = (await this.store.discoverRunIds()).sort((left, right) => right.localeCompare(left));
    const runIds = discovered.slice(0, MAX_DISCOVERED_RUNS);
    if (discovered.length > runIds.length) warnings.push("AGENT_RUN_DISCOVERY_TRUNCATED");

    const loaded: LoadedSummary[] = [];
    for (const runId of runIds) {
      try {
        loaded.push(await this.loadSummary(input.repo_id, runId));
      } catch {
        warnings.push(`AGENT_RUN_INVALID:${runId}`);
      }
    }

    const statuses = normalizedStatuses(input.statuses ?? []);
    const afterRunId = parseListCursor(input.cursor, input.repo_id, statuses);
    const matching = loaded.filter(({ summary }) => statuses.length === 0 || statuses.includes(summary.effective_status));
    const afterCursor = afterRunId ? matching.filter(({ summary }) => summary.run_id < afterRunId) : matching;
    const pageSize = input.page_size ?? DEFAULT_PAGE_SIZE;
    const page = afterCursor.slice(0, pageSize);
    const truncated = afterCursor.length > page.length;
    const lastRunId = page.at(-1)?.summary.run_id;
    const reviewable = latestReviewable(loaded);
    warnings.push(...loaded.flatMap(({ summary }) => summary.warnings));
    const driftSummary = await this.drift.analyze(input.repo_id, { records: loaded.map(({ record }) => record) });

    return {
      ok: true,
      repo_id: input.repo_id,
      mode: "list",
      runs: page.map(({ summary }) => summary),
      drift_summary: driftSummary,
      matched_count: matching.length,
      returned_count: page.length,
      truncated,
      ...(truncated && lastRunId ? { next_cursor: encodeListCursor(input.repo_id, statuses, lastRunId) } : {}),
      next_tool_payloads: {
        ...(reviewable ? { repo_codex_review: { repo_id: input.repo_id, run_id: reviewable.summary.run_id } } : {}),
        ...(reviewable?.status?.review?.legacy_repo_ship_review
          ? { repo_ship_review: reviewable.status.review.legacy_repo_ship_review }
          : {})
      },
      revision: await this.listRevision(supervisor?.revision, runIds),
      ...(supervisor ? { supervisor } : {}),
      warnings: boundedAgentRunWarnings(warnings)
    };
  }

  private async detail(input: AgentRunsInput, supervisor: AgentRunsResult["supervisor"]): Promise<AgentRunsResult> {
    const runId = input.run_id!;
    if (await this.runsRootState() !== "ready") {
      throw invalidArtifact(runId);
    }
    let loaded: LoadedSummary;
    try {
      await this.assertRunDirectory(runId);
      loaded = await this.loadSummary(input.repo_id, runId);
    } catch {
      throw invalidArtifact(runId);
    }
    const eventPage = await this.eventReader.read(
      input.repo_id,
      runId,
      loaded.summary.events_path,
      input.events_after,
      input.max_events ?? DEFAULT_MAX_EVENTS
    );
    const interactionWarnings: string[] = [];
    const interaction = await this.readPendingInteraction(input.repo_id, runId, loaded.status, interactionWarnings);
    const warnings = boundedAgentRunWarnings([...loaded.summary.warnings, ...eventPage.warnings, ...interactionWarnings]);
    const run: AgentRunDetail = {
      ...loaded.summary,
      warnings,
      ...(loaded.status ? { status: loaded.status } : {}),
      events: eventPage.events,
      event_page: {
        returned_count: eventPage.returned_count,
        skipped_count: eventPage.skipped_count,
        truncated: eventPage.truncated,
        ...(eventPage.next_cursor ? { next_cursor: eventPage.next_cursor } : {})
      },
      ...(interaction ? { interaction } : {})
    };
    return {
      ok: true,
      repo_id: input.repo_id,
      mode: "detail",
      run,
      matched_count: 1,
      returned_count: 1,
      truncated: false,
      next_tool_payloads: {
        ...(run.result_presence.reviewable ? { repo_codex_review: { repo_id: input.repo_id, run_id: run.run_id } } : {}),
        ...(run.status?.review?.legacy_repo_ship_review
          ? { repo_ship_review: run.status.review.legacy_repo_ship_review }
          : {}),
        ...(interaction ? {
          repo_write_agent_reply: {
            repo_id: input.repo_id,
            run_id: run.run_id,
            turn_index: interaction.turn_index,
            expected_question_sha256: interaction.question_sha256,
            question_ids: interaction.questions.map(({ question_id }) => question_id)
          }
        } : {})
      },
      revision: run.status?.revision ?? 0,
      ...(supervisor ? { supervisor } : {}),
      warnings
    };
  }

  private async waitForRevision(input: AgentRunsInput): Promise<void> {
    if (input.wait_after_revision === undefined) return;
    const timeoutMs = input.wait_timeout_ms ?? 30_000;
    const deadline = Date.now() + Math.min(timeoutMs, 30_000);
    while (Date.now() < deadline) {
      const revision = await this.currentRevision(input);
      if (input.run_id ? revision > input.wait_after_revision : revision !== input.wait_after_revision) return;
      await this.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }

  private async currentRevision(input: AgentRunsInput): Promise<number> {
    if (input.run_id) {
      return (await this.store.readStatus(input.run_id))?.revision ?? 0;
    }
    const supervisor = await this.supervisor.read().catch(() => undefined);
    const runIds = (await this.store.discoverRunIds())
      .sort((left, right) => right.localeCompare(left))
      .slice(0, MAX_DISCOVERED_RUNS);
    return this.listRevision(supervisor?.revision, runIds);
  }

  private async listRevision(supervisorRevision: number | undefined, runIds: string[]): Promise<number> {
    if (supervisorRevision === undefined && runIds.length === 0) return 0;
    const runs = await Promise.all([...runIds].sort().map(async (runId) => ({
      run_id: runId,
      revision: (await this.store.readStatus(runId).catch(() => undefined))?.revision ?? 0
    })));
    const digest = createHash("sha256")
      .update(JSON.stringify({ supervisor_revision: supervisorRevision ?? 0, runs }))
      .digest();
    return digest.readUIntBE(0, 6);
  }

  private async readSupervisor(): Promise<AgentRunsResult["supervisor"]> {
    const state = await this.supervisor.read().catch(() => undefined);
    return state ? publicSupervisorState(state, this.now()) : undefined;
  }

  private async readPendingInteraction(
    repoId: string,
    runId: string,
    status: AgentRunnerStatus | undefined,
    warnings: string[]
  ): Promise<AgentRunDetail["interaction"]> {
    if (status?.status !== "awaiting_input") return undefined;
    try {
      const session = await this.interactions.readSession(repoId, runId);
      if (!session || session.turn_index < 1) throw new Error("Missing current runner session.");
      const pending = await this.interactions.readQuestion(repoId, runId, session.turn_index);
      if (!pending) throw new Error("Missing current runner question.");
      if (await this.interactions.readReply(repoId, runId, session.turn_index)) return undefined;
      return {
        status: "awaiting_input",
        turn_index: session.turn_index,
        questions: pending.question.questions.map((question) => ({
          question_id: question.question_id,
          prompt: redactSensitiveText(question.prompt).slice(0, 2_000),
          ...(question.options ? { options: question.options.map((option) => redactSensitiveText(option).slice(0, 500)) } : {})
        })),
        question_sha256: pending.sha256
      };
    } catch {
      warnings.push("AGENT_RUN_INTERACTION_INVALID");
      return undefined;
    }
  }

  private async loadSummary(repoId: string, runId: string): Promise<LoadedSummary> {
    const paths = runPaths(runId);
    await this.assertRegularArtifact(paths.manifest_path, MAX_MANIFEST_BYTES);
    const record = await this.store.readRun(runId);
    if (record.repo_id !== repoId) throw invalidArtifact(runId);

    const warnings: string[] = [];
    const [resultMd, resultJson, status] = await Promise.all([
      record.legacy_result_path ? this.artifactPresent(record.legacy_result_path, warnings) : Promise.resolve(false),
      this.artifactPresent(record.result_json_path, warnings),
      this.readTrustedStatus(record, warnings)
    ]);
    const rawCreatedAt = typeof record.manifest.created_at === "string" ? record.manifest.created_at : null;
    const createdAt = sanitizeAgentRunScalar(rawCreatedAt, 100);
    if (rawCreatedAt && createdAt !== rawCreatedAt) warnings.push("AGENT_RUN_TIMESTAMP_SANITIZED");
    const rawTitle = typeof record.manifest.title === "string" ? record.manifest.title : null;
    const title = sanitizeAgentRunScalar(rawTitle, 160) ?? undefined;
    if (rawTitle && title !== rawTitle) warnings.push("AGENT_RUN_TITLE_TRUNCATED");
    const manifestVersion = record.manifest.schema_version;
    if (manifestVersion === 3 && resultMd) warnings.push("DELEGATION_V3_LEGACY_RESULT_IGNORED");
    const effectiveStatus: AgentRunEffectiveStatus = status?.status ?? record.runner.mode;
    const runner = publicAgentRunnerMetadata(record.runner, warnings);
    const runtime = record.runner.mode === "queued"
      ? await this.runtimeReader.read(record, status, warnings)
      : undefined;
    return {
      summary: {
        run_id: record.run_id,
        ...(status ? { revision: status.revision } : {}),
        ...(title ? { title } : {}),
        manifest_version: manifestVersion,
        runner,
        effective_status: effectiveStatus,
        prompt_path: record.prompt_path,
        ...(record.legacy_result_path ? { legacy_result_path: record.legacy_result_path } : {}),
        result_json_path: record.result_json_path,
        status_path: record.status_path,
        events_path: record.events_path,
        ...(runtime ? { runtime } : {}),
        result_presence: {
          ...(manifestVersion === 3 ? {} : { legacy_result_md: resultMd }),
          result_json: resultJson,
          reviewable: manifestVersion === 3 ? resultJson : resultMd || resultJson
        },
        created_at: createdAt,
        updated_at: status?.updated_at ?? createdAt,
        completed_at: status?.completed_at ?? null,
        warnings: boundedAgentRunWarnings(warnings)
      },
      ...(status ? { status } : {}),
      record
    };
  }

  private async readTrustedStatus(record: DelegationRunRecord, warnings: string[]): Promise<AgentRunnerStatus | undefined> {
    try {
      await this.assertRegularArtifact(record.status_path, MAX_STATUS_BYTES);
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      warnings.push("AGENT_RUN_STATUS_INVALID");
      return undefined;
    }
    try {
      const status = await this.store.readStatus(record.run_id);
      if (!status || status.repo_id !== record.repo_id || status.run_id !== record.run_id) {
        warnings.push("AGENT_RUN_STATUS_ID_MISMATCH");
        return undefined;
      }
      if (
        status.manifest_version !== record.manifest.schema_version
        || status.prompt_path !== record.prompt_path
        || status.result_json_path !== record.result_json_path
        || status.legacy_result_path !== record.legacy_result_path
      ) {
        warnings.push("AGENT_RUN_STATUS_PATH_MISMATCH");
        return undefined;
      }
      return sanitizeAgentRunStatus(status, warnings);
    } catch {
      warnings.push("AGENT_RUN_STATUS_INVALID");
      return undefined;
    }
  }

  private async assertRegularArtifact(path: string, maxBytes: number): Promise<void> {
    const resolved = await this.sandbox.resolve(path);
    if (!resolved.stat.isFile() || resolved.stat.isSymbolicLink() || Number(resolved.stat.size) > maxBytes) {
      throw invalidArtifact(path);
    }
  }

  private async assertRunDirectory(runId: string): Promise<void> {
    const resolved = await this.sandbox.resolve(runPaths(runId).run_dir);
    if (!resolved.stat.isDirectory() || resolved.stat.isSymbolicLink()) {
      throw invalidArtifact(runId);
    }
  }

  private async artifactPresent(path: string, warnings: string[]): Promise<boolean> {
    try {
      const resolved = await this.sandbox.resolve(path);
      if (resolved.stat.isFile() && !resolved.stat.isSymbolicLink()) return true;
      warnings.push("AGENT_RUN_RESULT_UNSAFE");
      return false;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      warnings.push("AGENT_RUN_RESULT_UNSAFE");
      return false;
    }
  }

  private async runsRootState(): Promise<"ready" | "missing" | "unsafe"> {
    try {
      const resolved = await this.sandbox.resolve(AGENT_RUNNER_RUNS_DIR);
      return resolved.stat.isDirectory() && !resolved.stat.isSymbolicLink() ? "ready" : "unsafe";
    } catch (error) {
      return isNotFoundError(error) ? "missing" : "unsafe";
    }
  }
}

function latestReviewable(runs: readonly LoadedSummary[]): LoadedSummary | undefined {
  return runs.find(({ summary }) => summary.result_presence.reviewable && ["completed", "committed"].includes(summary.effective_status))
    ?? runs.find(({ summary }) => summary.result_presence.reviewable);
}

function normalizedStatuses(statuses: readonly AgentRunEffectiveStatus[]): AgentRunEffectiveStatus[] {
  return [...new Set(statuses)].sort((left, right) => left.localeCompare(right));
}

function emptyList(
  repoId: string,
  warnings: string[],
  revision = 0,
  supervisor?: AgentRunsResult["supervisor"],
  driftSummary?: AgentRunsResult["drift_summary"]
): AgentRunsResult {
  return {
    ok: true,
    repo_id: repoId,
    mode: "list",
    runs: [],
    ...(driftSummary ? { drift_summary: driftSummary } : {}),
    matched_count: 0,
    returned_count: 0,
    truncated: false,
    revision,
    ...(supervisor ? { supervisor } : {}),
    next_tool_payloads: {},
    warnings
  };
}

function publicSupervisorState(
  state: AgentRunnerSupervisorState,
  now: Date
): NonNullable<AgentRunsResult["supervisor"]> {
  const heartbeatMs = Date.parse(state.heartbeat_at);
  const stale = !Number.isFinite(heartbeatMs) || now.getTime() - heartbeatMs > state.stale_after_ms;
  const readiness = state.status === "ready" || state.status === "running" ? "ready" : state.status;
  return {
    readiness,
    liveness: stale ? "stale" : "alive",
    status: state.status,
    revision: state.revision,
    heartbeat_at: state.heartbeat_at,
    updated_at: state.updated_at,
    last_scan_at: state.last_scan_at,
    last_claimed_run_id: state.last_claimed_run_id,
    active_run_id: state.active_run_id,
    stale_after_ms: state.stale_after_ms,
    warnings: [...new Set([...state.warnings, ...(stale ? ["RUNNER_SUPERVISOR_STALE"] : [])])].slice(0, 20)
  };
}

function invalidArtifact(runId: string): RepoReaderError {
  return new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Selected agent run artifact is missing, malformed, mismatched, or unsafe.", {
    diagnostics: { run_id: runId }
  });
}
