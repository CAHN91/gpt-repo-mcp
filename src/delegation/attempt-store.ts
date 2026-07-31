import { AgentRunnerAttemptSchema, type AgentRunnerAttempt } from "./artifact-contracts.js";
import { readSafeRunArtifact, writeSafeRunJson } from "./safe-artifact.js";
import { runPaths } from "./run-store.js";
import { RepoReaderError } from "../runtime/errors.js";

const MAX_ATTEMPT_BYTES = 64 * 1024;

export class DelegationAttemptStore {
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  async read(repoId: string, runId: string): Promise<AgentRunnerAttempt | undefined> {
    const raw = await readSafeRunArtifact(this.root, attemptPath(runId), MAX_ATTEMPT_BYTES);
    if (raw === undefined) return undefined;
    const attempt = AgentRunnerAttemptSchema.parse(JSON.parse(raw));
    if (attempt.repo_id !== repoId || attempt.run_id !== runId) throw invalidAttempt();
    return attempt;
  }

  async write(input: Omit<AgentRunnerAttempt, "schema_version" | "updated_at"> & { updated_at?: string }): Promise<AgentRunnerAttempt> {
    const attempt = AgentRunnerAttemptSchema.parse({
      schema_version: 1,
      ...input,
      updated_at: input.updated_at ?? this.now().toISOString()
    });
    await writeSafeRunJson(this.root, attemptPath(attempt.run_id), attempt);
    return attempt;
  }
}

export function attemptPath(runId: string): string {
  return `${runPaths(runId).run_dir}/runner.attempt.json`;
}

function invalidAttempt(): RepoReaderError {
  return new RepoReaderError("RUNNER_INTERACTION_INVALID", "Runner attempt identity does not match the selected run.");
}
