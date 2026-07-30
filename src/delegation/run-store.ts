import { mkdir, open, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { ZodError } from "zod";
import {
  AGENT_RUNNER_RUNS_DIR,
  AgentRunnerEventSchema,
  AgentRunnerMetadataSchema,
  AgentRunnerRunIdSchema,
  AgentRunnerStatusSchema,
  LegacyAgentRunnerStatusV1Schema,
  type AgentRunnerEvent,
  type AgentRunnerEventInput,
  type AgentRunnerMetadata,
  type AgentRunnerStatus,
  type AgentRunnerStatusInput,
  type LegacyAgentRunnerStatusV1
} from "./artifact-contracts.js";
import { RepoReaderError } from "../runtime/errors.js";
import { parseCodexRunManifest, type CodexRunManifest } from "../services/codex-run-manifest.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import { assertSafeRunDirectory, readSafeRunArtifact, writeSafeRunJson } from "./safe-artifact.js";

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_EVENTS_BYTES = 4 * 1024 * 1024;

export type DelegationRunRecord = {
  repo_id: string;
  run_id: string;
  manifest: CodexRunManifest;
  runner: AgentRunnerMetadata;
  run_dir: string;
  manifest_path: string;
  prompt_path: string;
  legacy_result_path?: string;
  result_json_path: string;
  status_path: string;
  events_path: string;
  lock_path: string;
};

export type DelegationRunStoreOptions = {
  now?: () => Date;
};

export class DelegationRunStore {
  private readonly now: () => Date;

  constructor(private readonly root: string, options: DelegationRunStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async discoverRuns(): Promise<DelegationRunRecord[]> {
    const runIds = await this.discoverRunIds();
    const records: DelegationRunRecord[] = [];
    for (const runId of runIds) {
      try {
        records.push(await this.readRun(runId));
      } catch (error) {
        if (error instanceof RepoReaderError && error.code === "RUNNER_RUN_ID_INVALID") {
          continue;
        }
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }
    }
    return records.sort((a, b) => a.run_id.localeCompare(b.run_id));
  }

  async discoverRunIds(): Promise<string[]> {
    const runsDir = join(this.root, AGENT_RUNNER_RUNS_DIR);
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const runIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (AgentRunnerRunIdSchema.safeParse(entry.name).success) {
        runIds.push(entry.name);
      }
    }
    return runIds.sort((a, b) => a.localeCompare(b));
  }

  async readRun(runId: string): Promise<DelegationRunRecord> {
    const paths = runPaths(runId);
    await assertSafeRunDirectory(this.root, paths.run_dir);
    const rawManifest = await readSafeRunArtifact(this.root, paths.manifest_path, MAX_MANIFEST_BYTES);
    if (rawManifest === undefined) throw new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Runner manifest is missing.");
    let manifest: CodexRunManifest;
    try {
      manifest = parseCodexRunManifest(JSON.parse(rawManifest));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError || error instanceof RepoReaderError) {
        throw invalidArtifact(paths.manifest_path);
      }
      throw error;
    }
    if (manifest.run_id !== runId) {
      throw new RepoReaderError("RUNNER_RUN_ID_INVALID", "Runner manifest run_id does not match its directory.");
    }
    const defaultPaths = runPaths(manifest.run_id);
    const legacyResultPath = manifest.schema_version === 3
      ? undefined
      : validateManifestArtifactPath(manifest.result_path, defaultPaths.legacy_result_path, "legacy_result_path");
    const resultJsonPathValue = manifest.schema_version === 3
      ? manifest.result_json_path
      : typeof manifest.result_json_path === "string" ? manifest.result_json_path : undefined;
    if (manifest.schema_version === 3 && manifest.manifest_path !== defaultPaths.manifest_path) {
      throw new RepoReaderError("RUNNER_RUN_ID_INVALID", "Delegation v3 manifest path must stay within its run artifact directory.");
    }
    return {
      repo_id: manifest.repo_id,
      run_id: manifest.run_id,
      manifest,
      runner: AgentRunnerMetadataSchema.parse(manifest.schema_version === 3 ? manifest.task.runner : manifest.runner ?? { mode: "manual" }),
      run_dir: defaultPaths.run_dir,
      manifest_path: defaultPaths.manifest_path,
      prompt_path: validateManifestArtifactPath(manifest.prompt_path, defaultPaths.prompt_path, "prompt_path"),
      ...(legacyResultPath ? { legacy_result_path: legacyResultPath } : {}),
      result_json_path: validateManifestArtifactPath(resultJsonPathValue, defaultPaths.result_json_path, "result_json_path"),
      status_path: defaultPaths.status_path,
      events_path: defaultPaths.events_path,
      lock_path: defaultPaths.lock_path
    };
  }

  async writeStatus(input: Omit<AgentRunnerStatusInput, "schema_version" | "updated_at"> & { updated_at?: string; schema_version?: 2 }): Promise<AgentRunnerStatus> {
    const status = AgentRunnerStatusSchema.parse({
      schema_version: 2,
      ...input,
      updated_at: input.updated_at ?? this.now().toISOString()
    });
    const path = runPaths(status.run_id).status_path;
    await writeSafeRunJson(this.root, path, status);
    return status;
  }

  async readStatus(runId: string): Promise<AgentRunnerStatus | undefined> {
    try {
      const raw = await readSafeRunArtifact(this.root, runPaths(runId).status_path, MAX_STATUS_BYTES);
      if (raw === undefined) return undefined;
      try {
        const value = JSON.parse(raw) as unknown;
        if (typeof value === "object" && value !== null && "schema_version" in value && value.schema_version === 1) {
          const legacy = LegacyAgentRunnerStatusV1Schema.parse(value);
          const run = await this.readRun(runId);
          return normalizeLegacyStatus(legacy, run);
        }
        return AgentRunnerStatusSchema.parse(value);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof ZodError || error instanceof RepoReaderError) {
          throw invalidArtifact(runPaths(runId).status_path);
        }
        throw error;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async appendEvent(input: Omit<AgentRunnerEventInput, "schema_version" | "timestamp"> & { timestamp?: string; schema_version?: 1 }): Promise<AgentRunnerEvent> {
    const event = AgentRunnerEventSchema.parse({
      schema_version: 1,
      ...input,
      timestamp: input.timestamp ?? this.now().toISOString(),
      ...(input.summary === undefined ? {} : { summary: redactSensitiveText(input.summary) })
    });
    const path = join(this.root, runPaths(event.run_id).events_path);
    const relativePath = runPaths(event.run_id).events_path;
    const existing = await readSafeRunArtifact(this.root, relativePath, MAX_EVENTS_BYTES);
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(existing ?? "", "utf8") + Buffer.byteLength(line, "utf8") > MAX_EVENTS_BYTES) {
      throw new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Runner event artifact exceeds its size limit.");
    }
    await assertSafeRunDirectory(this.root, runPaths(event.run_id).run_dir);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Runner event artifact is unsafe.");
      await handle.write(line, undefined, "utf8");
    } finally {
      await handle.close();
    }
    return event;
  }

}

function normalizeLegacyStatus(
  status: LegacyAgentRunnerStatusV1,
  run: DelegationRunRecord
): AgentRunnerStatus {
  const manifestVersion = run.manifest.schema_version;
  const reviewRequirement = manifestVersion === 3
    ? run.manifest.review_requirement
    : "legacy_unavailable" as const;
  const review = status.review
    ? {
        repo_codex_review: status.review.repo_codex_review,
        ...(manifestVersion === 3 ? {} : { legacy_repo_ship_review: status.review.repo_ship_review }),
        instructions: status.review.instructions
      }
    : undefined;
  return AgentRunnerStatusSchema.parse({
    schema_version: 2,
    manifest_version: manifestVersion,
    review_requirement: reviewRequirement,
    repo_id: status.repo_id,
    run_id: status.run_id,
    runner: status.runner,
    status: status.status,
    revision: status.revision,
    started_at: status.started_at,
    updated_at: status.updated_at,
    completed_at: status.completed_at,
    prompt_path: status.prompt_path,
    ...(manifestVersion === 3 || !run.legacy_result_path ? {} : { legacy_result_path: run.legacy_result_path }),
    result_json_path: run.result_json_path,
    result_found: status.result_found,
    head_before: status.head_before,
    head_after: status.head_after,
    worktree_fingerprint_before: status.worktree_fingerprint_before,
    worktree_fingerprint_after: status.worktree_fingerprint_after,
    changed_paths: status.changed_paths,
    validation: status.validation,
    commit: status.commit,
    ...(review ? { review } : {}),
    warnings: status.warnings
  });
}

function invalidArtifact(path: string): RepoReaderError {
  return new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Runner artifact is malformed or invalid.", {
    diagnostics: { path }
  });
}

export function runPaths(runId: string) {
  const parsedRunId = AgentRunnerRunIdSchema.safeParse(runId);
  if (!parsedRunId.success) {
    throw new RepoReaderError("RUNNER_RUN_ID_INVALID", "Invalid agent runner run id.");
  }
  const runDir = `${AGENT_RUNNER_RUNS_DIR}/${parsedRunId.data}`;
  return {
    run_dir: runDir,
    prompt_path: `${runDir}/PROMPT.md`,
    legacy_result_path: `${runDir}/RESULT.md`,
    result_json_path: `${runDir}/RESULT.json`,
    manifest_path: `${runDir}/run.json`,
    status_path: `${runDir}/runner.status.json`,
    events_path: `${runDir}/runner.events.jsonl`,
    lock_path: `${runDir}/runner.lock.json`
  };
}

function validateManifestArtifactPath(
  value: string | undefined,
  expectedPath: string,
  fieldName: "prompt_path" | "legacy_result_path" | "result_json_path"
): string {
  if (value === undefined) {
    return expectedPath;
  }
  if (!isSafeRepoRelativePath(value) || value !== expectedPath) {
    throw new RepoReaderError("RUNNER_RUN_ID_INVALID", `Runner manifest ${fieldName} must stay within its run artifact directory.`);
  }
  return value;
}

function isSafeRepoRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
