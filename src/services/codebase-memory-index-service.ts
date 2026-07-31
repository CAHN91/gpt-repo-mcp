import type { CodeIndexAction, CodeIndexEvent, CodeIndexResult, CodeIndexStatus } from "../contracts/code-index.contract.js";
import type { RepoConfig } from "./root-registry.js";
import {
  findCodebaseMemoryProject,
  type CodebaseMemoryClient,
  type CodebaseMemoryClientFactory
} from "./codebase-memory-client.js";

const MAX_EVENTS = 20;

type IndexJob = {
  status: CodeIndexStatus;
  started_at?: string;
  finished_at?: string;
  events: CodeIndexEvent[];
  warnings: string[];
};

export class CodebaseMemoryIndexService {
  private readonly jobs = new Map<string, IndexJob>();

  constructor(
    private readonly clientFactory: CodebaseMemoryClientFactory,
    private readonly queryTimeoutMs: number,
    private readonly indexTimeoutMs: number
  ) {}

  isRunning(repoRoot: string): boolean {
    const status = this.jobs.get(repoRoot)?.status;
    return status === "queued" || status === "running";
  }

  async index(repo: RepoConfig, action: CodeIndexAction): Promise<CodeIndexResult> {
    return action === "start" ? this.start(repo) : this.status(repo);
  }

  private async start(repo: RepoConfig): Promise<CodeIndexResult> {
    const existing = this.jobs.get(repo.root);
    if (existing && (existing.status === "queued" || existing.status === "running")) {
      return result(repo.repo_id, "start", existing);
    }

    // Reserve before any await so concurrent starts cannot both pass the check.
    const queued = job("queued", "Indexing was queued after explicit user approval.");
    this.jobs.set(repo.root, queued);
    const indexed = await this.hasProject(repo).catch(() => false);
    if (indexed) {
      updateJob(queued, "ready", "The repository already has a Codebase Memory index.");
      queued.finished_at = new Date().toISOString();
      return result(repo.repo_id, "start", queued);
    }

    queueMicrotask(() => void this.run(repo, queued));
    return result(repo.repo_id, "start", queued);
  }

  private async status(repo: RepoConfig): Promise<CodeIndexResult> {
    const existing = this.jobs.get(repo.root);
    if (existing) return result(repo.repo_id, "status", existing);
    try {
      const state = await this.hasProject(repo) ? "ready" : "index_required";
      return result(repo.repo_id, "status", job(state, state === "ready"
        ? "The Codebase Memory index is ready."
        : "The repository has not been indexed."));
    } catch {
      return result(repo.repo_id, "status", job("provider_unavailable", "Codebase Memory is unavailable.", ["CODEBASE_MEMORY_UNAVAILABLE"]));
    }
  }

  private async run(repo: RepoConfig, current: IndexJob): Promise<void> {
    updateJob(current, "running", "Codebase Memory is indexing the approved repository root.");
    current.started_at = new Date().toISOString();
    let client: CodebaseMemoryClient | undefined;
    try {
      client = await this.clientFactory(repo.root);
      const response = await client.call("index_repository", {
        repo_path: repo.root,
        mode: "full",
        persistence: false
      }, this.indexTimeoutMs);
      const next = validatedIndexStatus(response);
      updateJob(current, next, next === "ready" ? "Codebase Memory indexing completed." : "Indexing completed with degraded coverage.");
    } catch {
      current.warnings.push("CODEBASE_MEMORY_INDEX_FAILED");
      updateJob(current, "failed", "Codebase Memory indexing failed.");
    } finally {
      current.finished_at = new Date().toISOString();
      await client?.close().catch(() => undefined);
    }
  }

  private async hasProject(repo: RepoConfig): Promise<boolean> {
    let client: CodebaseMemoryClient | undefined;
    try {
      client = await this.clientFactory(repo.root);
      return Boolean(await findCodebaseMemoryProject(client, repo.root, this.queryTimeoutMs));
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}

function validatedIndexStatus(response: Record<string, unknown>): "ready" | "degraded" {
  if (response.status === "degraded") return "degraded";
  if (typeof response.status === "string" && ["indexed", "ready", "completed", "success"].includes(response.status)) return "ready";
  throw new Error("Codebase Memory returned an unknown index status.");
}

function job(status: CodeIndexStatus, message: string, warnings: string[] = []): IndexJob {
  return { status, events: [{ at: new Date().toISOString(), status, message }], warnings };
}

function updateJob(jobState: IndexJob, status: CodeIndexStatus, message: string): void {
  jobState.status = status;
  jobState.events.push({ at: new Date().toISOString(), status, message });
  jobState.events = jobState.events.slice(-MAX_EVENTS);
}

function result(repoId: string, action: CodeIndexAction, state: IndexJob): CodeIndexResult {
  return {
    ok: true,
    repo_id: repoId,
    provider: "codebase_memory",
    action,
    status: state.status,
    started_at: state.started_at,
    finished_at: state.finished_at,
    events: [...state.events],
    warnings: [...state.warnings]
  };
}
