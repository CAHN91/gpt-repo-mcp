import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CurrentWorkSessionInputSchema,
  CurrentWorkSessionResultSchema,
  StartWorkSessionInputSchema,
  StartWorkSessionResultSchema,
  UpdateWorkSessionInputSchema,
  UpdateWorkSessionResultSchema,
  WorkSessionSchema,
  type CurrentWorkSessionInput,
  type CurrentWorkSessionResult,
  type StartWorkSessionInput,
  type StartWorkSessionResult,
  type UpdateWorkSessionInput,
  type UpdateWorkSessionResult,
  type WorkSession
} from "../contracts/work-session.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import { FileWriter } from "./file-writer.js";
import { formatUtcWorkSessionTimestamp, slugifyLabel } from "./local-id.js";
import { validateRepoPath, type PathSandbox } from "./path-sandbox.js";
import type { WritePolicy } from "./write-policy.js";

const WORK_SESSION_DIR = ".chatgpt/work-sessions";
const CURRENT_PATH = `${WORK_SESSION_DIR}/current.json`;

type CurrentPointer = {
  schema_version: 1;
  repo_id: string;
  work_session_id: string;
  session_path: string;
  title: string;
  objective: string;
  status: WorkSession["status"];
  next_action: string;
  updated_at: string;
};

export class WorkSessionService {
  private readonly writer?: FileWriter;

  constructor(
    private readonly root: string,
    sandbox?: PathSandbox,
    policy?: WritePolicy,
    private readonly now: () => Date = () => new Date()
  ) {
    if (sandbox && policy) this.writer = new FileWriter(root, sandbox, policy);
  }

  async start(rawInput: StartWorkSessionInput): Promise<StartWorkSessionResult> {
    const input = StartWorkSessionInputSchema.parse(rawInput);
    const timestamp = this.now().toISOString();
    const workSessionId = input.work_session_id ?? generatedId(input.title, this.now());
    const session: WorkSession = WorkSessionSchema.parse({
      schema_version: 1,
      work_session_id: workSessionId,
      repo_id: input.repo_id,
      title: input.title,
      objective: input.objective,
      status: "active",
      created_at: timestamp,
      updated_at: timestamp,
      constraints: uniqueStrings(input.constraints ?? []),
      files_inspected: uniquePaths(input.files_inspected ?? []),
      decisions: [],
      assumptions: [],
      touched_files: uniquePaths(input.touched_files ?? []),
      pending_patchsets: [],
      validation_results: [],
      unresolved_risks: [],
      next_action: input.next_action,
      warnings: []
    });
    assertSafeSessionText(session);
    return this.writeSession(session, input.dry_run ?? false);
  }

  async update(rawInput: UpdateWorkSessionInput): Promise<UpdateWorkSessionResult> {
    const input = UpdateWorkSessionInputSchema.parse(rawInput);
    const existing = await this.readSession(input.work_session_id);
    if (existing.repo_id !== input.repo_id) {
      throw new RepoReaderError("WORK_SESSION_REPO_MISMATCH", "Work session belongs to a different repository.");
    }
    const session: WorkSession = WorkSessionSchema.parse({
      ...existing,
      status: input.status ?? existing.status,
      updated_at: this.now().toISOString(),
      files_inspected: uniquePaths([...(existing.files_inspected ?? []), ...(input.append_files_inspected ?? [])]),
      touched_files: uniquePaths([...(existing.touched_files ?? []), ...(input.append_touched_files ?? [])]),
      decisions: uniqueStrings([...(existing.decisions ?? []), ...(input.append_decisions ?? [])]),
      assumptions: uniqueStrings([...(existing.assumptions ?? []), ...(input.append_assumptions ?? [])]),
      pending_patchsets: uniqueObjects([...(existing.pending_patchsets ?? []), ...(input.append_pending_patchsets ?? [])]),
      validation_results: uniqueObjects([...(existing.validation_results ?? []), ...(input.append_validation_results ?? [])]),
      unresolved_risks: uniqueStrings([...(existing.unresolved_risks ?? []), ...(input.append_unresolved_risks ?? [])]),
      next_action: input.next_action ?? existing.next_action
    });
    assertSafeSessionText(session);
    return UpdateWorkSessionResultSchema.parse(await this.writeSession(session, input.dry_run ?? false));
  }

  async current(rawInput: CurrentWorkSessionInput): Promise<CurrentWorkSessionResult> {
    const input = CurrentWorkSessionInputSchema.parse(rawInput);
    if (input.work_session_id) {
      return this.currentById(input.repo_id, input.work_session_id, "explicit_id");
    }

    let pointer: CurrentPointer;
    try {
      pointer = parseCurrentPointer(await readFile(join(this.root, CURRENT_PATH), "utf8"));
    } catch (error) {
      if (isNotFoundError(error)) {
        return CurrentWorkSessionResultSchema.parse({
          ok: true,
          repo_id: input.repo_id,
          lookup_source: "current_pointer",
          found: false,
          warnings: ["NO_CURRENT_WORK_SESSION"]
        });
      }
      throw error;
    }
    if (pointer.repo_id !== input.repo_id) {
      return CurrentWorkSessionResultSchema.parse({
        ok: true,
        repo_id: input.repo_id,
        lookup_source: "current_pointer",
        found: false,
        warnings: ["CURRENT_WORK_SESSION_REPO_MISMATCH"]
      });
    }
    return this.currentById(input.repo_id, pointer.work_session_id, "current_pointer", CURRENT_PATH);
  }

  private async currentById(
    repoId: string,
    workSessionId: string,
    lookupSource: "current_pointer" | "explicit_id",
    currentPath?: typeof CURRENT_PATH
  ): Promise<CurrentWorkSessionResult> {
    try {
      const session = await this.readSession(workSessionId);
      if (session.repo_id !== repoId) {
        throw new RepoReaderError("WORK_SESSION_REPO_MISMATCH", "Work session belongs to a different repository.");
      }
      assertSafeSessionText(session);
      const includeSession = lookupSource === "explicit_id" || session.status !== "completed";
      return CurrentWorkSessionResultSchema.parse({
        ok: true,
        repo_id: repoId,
        lookup_source: lookupSource,
        found: true,
        continuity_state: session.status === "completed" ? "completed_history" : session.status,
        work_session_id: workSessionId,
        session_path: sessionPath(workSessionId),
        ...(currentPath ? { current_path: currentPath } : {}),
        ...(includeSession ? { session } : {}),
        warnings: lookupSource === "current_pointer"
          ? session.status === "completed"
            ? ["CURRENT_WORK_SESSION_COMPLETED"]
            : session.status === "blocked"
              ? ["CURRENT_WORK_SESSION_BLOCKED"]
              : []
          : []
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return CurrentWorkSessionResultSchema.parse({
          ok: true,
          repo_id: repoId,
          lookup_source: lookupSource,
          found: false,
          warnings: ["WORK_SESSION_NOT_FOUND"]
        });
      }
      throw error;
    }
  }

  private async writeSession(session: WorkSession, dryRun: boolean): Promise<StartWorkSessionResult> {
    const writer = this.writer;
    if (!writer) {
      throw new RepoReaderError("WRITE_DISABLED", "Work-session mutation requires an enabled write policy.");
    }
    const path = sessionPath(session.work_session_id);
    const current = currentPointer(session, path);
    const warnings: string[] = [];
    const sessionWrite = await writer.write({
      path,
      action: "write",
      content: `${JSON.stringify(session, null, 2)}\n`,
      create_dirs: true,
      dry_run: dryRun
    });
    warnings.push(...sessionWrite.warnings);
    const currentWrite = await writer.write({
      path: CURRENT_PATH,
      action: "write",
      content: `${JSON.stringify(current, null, 2)}\n`,
      create_dirs: true,
      dry_run: dryRun
    });
    warnings.push(...currentWrite.warnings);

    return StartWorkSessionResultSchema.parse({
      ok: true,
      dry_run: dryRun,
      work_session_id: session.work_session_id,
      session_path: path,
      current_path: CURRENT_PATH,
      session,
      warnings,
      next_tool_payloads: {
        repo_current_work_session: {
          repo_id: session.repo_id,
          work_session_id: session.work_session_id
        }
      }
    });
  }

  private async readSession(workSessionId: string): Promise<WorkSession> {
    const raw = await readFile(join(this.root, sessionPath(workSessionId)), "utf8");
    return WorkSessionSchema.parse(JSON.parse(raw));
  }
}

function generatedId(title: string, date: Date): string {
  return `${formatUtcWorkSessionTimestamp(date)}-${slugifyLabel(title, "work-session")}`;
}

function sessionPath(workSessionId: string): string {
  return `${WORK_SESSION_DIR}/${workSessionId}.json`;
}

function currentPointer(session: WorkSession, path: string): CurrentPointer {
  return {
    schema_version: 1,
    repo_id: session.repo_id,
    work_session_id: session.work_session_id,
    session_path: path,
    title: session.title,
    objective: session.objective,
    status: session.status,
    next_action: session.next_action,
    updated_at: session.updated_at
  };
}

function parseCurrentPointer(raw: string): CurrentPointer {
  const parsed = JSON.parse(raw) as CurrentPointer;
  validateRepoPath(parsed.session_path);
  return parsed;
}

function uniquePaths(values: string[]): string[] {
  return uniqueStrings(values.map((value) => {
    try {
      return validateRepoPath(value);
    } catch {
      throw new RepoReaderError("VALIDATION_ERROR", `Unsafe work-session path: ${value}`);
    }
  }));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueObjects<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function assertSafeSessionText(session: WorkSession): void {
  const serialized = JSON.stringify(session);
  if (redactSensitiveText(serialized) !== serialized) {
    throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", "Work-session state contains secret-looking text.");
  }
}
