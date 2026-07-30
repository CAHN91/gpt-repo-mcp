import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  AgentInteractionQuestionSchema,
  AgentInteractionReplySchema,
  AgentRunnerRunIdSchema,
  AgentRunnerSessionSchema,
  type AgentInteractionQuestion,
  type AgentInteractionReply,
  type AgentRunnerSession
} from "./artifact-contracts.js";
import { RepoReaderError } from "../runtime/errors.js";
import { atomicWriteJson, isAlreadyExistsError, isNotFoundError, writeExclusiveJson } from "../runtime/fs-helpers.js";

const MAX_INTERACTION_BYTES = 128 * 1024;

export class DelegationInteractionStore {
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  async readSession(repoId: string, runId: string): Promise<AgentRunnerSession | undefined> {
    const value = await this.readArtifact(sessionPath(runId), AgentRunnerSessionSchema);
    if (!value) return undefined;
    assertBinding(value.repo_id, value.run_id, repoId, runId);
    return value;
  }

  async writeSession(input: Omit<AgentRunnerSession, "schema_version" | "updated_at" | "active_runtime_ms"> & { updated_at?: string; active_runtime_ms?: number }): Promise<AgentRunnerSession> {
    await this.assertSafeRunDirectory(input.run_id);
    await this.assertAbsentOrRegular(sessionPath(input.run_id));
    const session = AgentRunnerSessionSchema.parse({
      schema_version: 1,
      ...input,
      updated_at: input.updated_at ?? this.now().toISOString()
    });
    await atomicWriteJson(join(this.root, sessionPath(session.run_id)), session);
    return session;
  }

  async readQuestion(repoId: string, runId: string, turnIndex: number): Promise<{ question: AgentInteractionQuestion; sha256: string } | undefined> {
    const path = interactionPaths(runId, turnIndex).question_path;
    const raw = await this.readRawArtifact(path);
    if (!raw) return undefined;
    const question = AgentInteractionQuestionSchema.parse(JSON.parse(raw));
    assertInteractionBinding(question, repoId, runId, turnIndex);
    return { question, sha256: sha256(raw) };
  }

  async writeQuestion(input: Omit<AgentInteractionQuestion, "schema_version" | "created_at"> & { created_at?: string }): Promise<{ question: AgentInteractionQuestion; sha256: string }> {
    const question = AgentInteractionQuestionSchema.parse({
      schema_version: 1,
      ...input,
      created_at: input.created_at ?? this.now().toISOString()
    });
    await this.assertSafeInteractionDirectory(question.run_id);
    const path = join(this.root, interactionPaths(question.run_id, question.turn_index).question_path);
    const raw = `${JSON.stringify(question, null, 2)}\n`;
    try {
      await writeExclusiveJson(path, question);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const existing = await this.readQuestion(question.repo_id, question.run_id, question.turn_index);
      if (!existing || JSON.stringify(existing.question) !== JSON.stringify(question)) {
        throw interactionError("Question artifact already exists with different content.");
      }
      return existing;
    }
    return { question, sha256: sha256(raw) };
  }

  async readReply(repoId: string, runId: string, turnIndex: number): Promise<AgentInteractionReply | undefined> {
    const reply = await this.readArtifact(interactionPaths(runId, turnIndex).reply_path, AgentInteractionReplySchema);
    if (!reply) return undefined;
    assertInteractionBinding(reply, repoId, runId, turnIndex);
    return reply;
  }

  async writeReply(input: Omit<AgentInteractionReply, "schema_version" | "created_at"> & { created_at?: string }): Promise<AgentInteractionReply> {
    const reply = AgentInteractionReplySchema.parse({
      schema_version: 1,
      ...input,
      created_at: input.created_at ?? this.now().toISOString()
    });
    await this.assertSafeInteractionDirectory(reply.run_id);
    try {
      await writeExclusiveJson(join(this.root, interactionPaths(reply.run_id, reply.turn_index).reply_path), reply);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new RepoReaderError("RUNNER_REPLY_ALREADY_EXISTS", "A reply already exists for this agent turn.");
      }
      throw error;
    }
    return reply;
  }

  private async readArtifact<T>(path: string, schema: { parse(value: unknown): T }): Promise<T | undefined> {
    const raw = await this.readRawArtifact(path);
    return raw === undefined ? undefined : schema.parse(JSON.parse(raw));
  }

  private async readRawArtifact(path: string): Promise<string | undefined> {
    const absolute = join(this.root, path);
    try {
      const [stat, rootReal, targetReal] = await Promise.all([lstat(absolute), realpath(this.root), realpath(absolute)]);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INTERACTION_BYTES || !isWithin(rootReal, targetReal)) {
        throw interactionError("Interaction artifact is not a safe bounded regular file.");
      }
      return await readFile(targetReal, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }

  private async assertSafeRunDirectory(runId: string): Promise<void> {
    const path = join(this.root, runDirectory(runId));
    const [stat, rootReal, targetReal] = await Promise.all([lstat(path), realpath(this.root), realpath(path)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(rootReal, targetReal)) {
      throw interactionError("Agent run directory is unsafe.");
    }
  }

  private async assertAbsentOrRegular(path: string): Promise<void> {
    try {
      const stat = await lstat(join(this.root, path));
      if (!stat.isFile() || stat.isSymbolicLink()) throw interactionError("Agent interaction artifact target is unsafe.");
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  private async assertSafeInteractionDirectory(runId: string): Promise<void> {
    await this.assertSafeRunDirectory(runId);
    const path = join(this.root, runDirectory(runId), "interactions");
    await mkdir(path, { recursive: true });
    const [stat, rootReal, targetReal] = await Promise.all([lstat(path), realpath(this.root), realpath(path)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(rootReal, targetReal)) {
      throw interactionError("Agent interaction directory is unsafe.");
    }
  }
}

export function interactionPaths(runId: string, turnIndex: number) {
  const dir = `${runDirectory(runId)}/interactions`;
  if (!Number.isInteger(turnIndex) || turnIndex < 1 || turnIndex > 32) {
    throw interactionError("Agent turn index is outside the supported range.");
  }
  const turn = String(turnIndex).padStart(4, "0");
  return { question_path: `${dir}/turn-${turn}.question.json`, reply_path: `${dir}/turn-${turn}.reply.json` };
}

export function sessionPath(runId: string): string {
  return `${runDirectory(runId)}/runner.session.json`;
}

function runDirectory(runId: string): string {
  const parsed = AgentRunnerRunIdSchema.safeParse(runId);
  if (!parsed.success) throw interactionError("Invalid agent runner run id.");
  return `.chatgpt/codex-runs/${parsed.data}`;
}

function assertBinding(actualRepo: string, actualRun: string, repoId: string, runId: string): void {
  if (actualRepo !== repoId || actualRun !== runId) throw interactionError("Agent interaction identity does not match the selected run.");
}

function assertInteractionBinding(
  value: { repo_id: string; run_id: string; turn_index: number },
  repoId: string,
  runId: string,
  turnIndex: number
): void {
  assertBinding(value.repo_id, value.run_id, repoId, runId);
  if (value.turn_index !== turnIndex) throw interactionError("Agent interaction turn does not match its artifact path.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isWithin(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function interactionError(message: string): RepoReaderError {
  return new RepoReaderError("RUNNER_INTERACTION_INVALID", message);
}
