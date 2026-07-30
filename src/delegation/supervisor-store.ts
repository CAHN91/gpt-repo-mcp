import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_RUNNER_RUNS_DIR,
  AgentRunnerSupervisorStateSchema,
  type AgentRunnerSupervisorState
} from "./artifact-contracts.js";
import { atomicWriteJson, isNotFoundError } from "../runtime/fs-helpers.js";
import { RepoReaderError } from "../runtime/errors.js";

export const AGENT_RUNNER_SUPERVISOR_STATE_PATH = `${AGENT_RUNNER_RUNS_DIR}/.runner-supervisor.json`;
const MAX_STATE_BYTES = 64 * 1024;

export class DelegationSupervisorStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async read(): Promise<AgentRunnerSupervisorState | undefined> {
    try {
      const absolutePath = join(this.root, AGENT_RUNNER_SUPERVISOR_STATE_PATH);
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
        throw unsafeStateError();
      }
      return AgentRunnerSupervisorStateSchema.parse(JSON.parse(await readFile(absolutePath, "utf8")));
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      if (error instanceof SyntaxError) throw unsafeStateError();
      throw error;
    }
  }

  write(input: Omit<AgentRunnerSupervisorState, "revision" | "updated_at" | "schema_version"> & {
    revision?: number;
    updated_at?: string;
  }): Promise<AgentRunnerSupervisorState> {
    const pending = this.writeQueue.then(() => this.writeNow(input));
    this.writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async writeNow(input: Omit<AgentRunnerSupervisorState, "revision" | "updated_at" | "schema_version"> & {
    revision?: number;
    updated_at?: string;
  }): Promise<AgentRunnerSupervisorState> {
    const current = await this.read().catch((error) => {
      if (error instanceof RepoReaderError && error.code === "AGENT_RUN_ARTIFACT_INVALID") return undefined;
      throw error;
    });
    const now = input.updated_at ?? new Date().toISOString();
    const state = AgentRunnerSupervisorStateSchema.parse({
      schema_version: 1,
      ...input,
      revision: input.revision ?? (current?.revision ?? 0) + 1,
      updated_at: now
    });
    const directory = join(this.root, AGENT_RUNNER_RUNS_DIR);
    await mkdir(directory, { recursive: true });
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw unsafeStateError();
    await atomicWriteJson(join(this.root, AGENT_RUNNER_SUPERVISOR_STATE_PATH), state);
    return state;
  }
}

function unsafeStateError(): RepoReaderError {
  return new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Runner supervisor state is missing, oversized, or unsafe.");
}
