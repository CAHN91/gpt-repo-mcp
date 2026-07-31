import { z } from "zod";
import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";
import { AgentRunEffectiveStatusSchema, type AgentRunEffectiveStatus } from "../contracts/agent-runs.contract.js";
import { RepoReaderError } from "../runtime/errors.js";

const ListCursorSchema = z.object({
  v: z.literal(1),
  kind: z.literal("runs"),
  repo_id: z.string().min(1),
  statuses: z.array(AgentRunEffectiveStatusSchema),
  after_run_id: AgentRunnerRunIdSchema
}).strict();

const EventCursorSchema = z.object({
  v: z.literal(1),
  kind: z.literal("events"),
  repo_id: z.string().min(1),
  run_id: AgentRunnerRunIdSchema,
  offset: z.number().int().nonnegative()
}).strict();

export function encodeListCursor(repoId: string, statuses: readonly AgentRunEffectiveStatus[], afterRunId: string): string {
  return encode({ v: 1, kind: "runs", repo_id: repoId, statuses: normalizedStatuses(statuses), after_run_id: afterRunId });
}

export function parseListCursor(
  cursor: string | undefined,
  repoId: string,
  statuses: readonly AgentRunEffectiveStatus[]
): string | undefined {
  if (!cursor) return undefined;
  const parsed = parseCursor(cursor, ListCursorSchema);
  if (parsed.repo_id !== repoId || !sameValues(parsed.statuses, normalizedStatuses(statuses))) {
    throw invalidCursor();
  }
  return parsed.after_run_id;
}

export function encodeEventCursor(repoId: string, runId: string, offset: number): string {
  return encode({ v: 1, kind: "events", repo_id: repoId, run_id: runId, offset });
}

export function parseEventCursor(cursor: string | undefined, repoId: string, runId: string): number {
  if (!cursor) return 0;
  const parsed = parseCursor(cursor, EventCursorSchema);
  if (parsed.repo_id !== repoId || parsed.run_id !== runId) {
    throw invalidCursor();
  }
  return parsed.offset;
}

function parseCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw invalidCursor();
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function normalizedStatuses(statuses: readonly AgentRunEffectiveStatus[]): AgentRunEffectiveStatus[] {
  return [...new Set(statuses)].sort((left, right) => left.localeCompare(right));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalidCursor(): RepoReaderError {
  return new RepoReaderError("VALIDATION_ERROR", "Invalid or mismatched repo_agent_runs cursor.");
}
