import { open } from "node:fs/promises";
import { AgentRunnerEventSchema, type AgentRunnerEvent } from "../delegation/artifact-contracts.js";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import { PathSandbox } from "./path-sandbox.js";
import { encodeEventCursor, parseEventCursor } from "./agent-runs-cursor.js";

const MAX_EVENT_READ_BYTES = 512 * 1024;
const ESTIMATED_EVENT_BYTES = 4 * 1024;

export type AgentRunEventPage = {
  events: AgentRunnerEvent[];
  returned_count: number;
  skipped_count: number;
  truncated: boolean;
  next_cursor?: string;
  warnings: string[];
};

export class AgentRunEventsReader {
  constructor(private readonly sandbox: PathSandbox) {}

  async read(
    repoId: string,
    runId: string,
    eventsPath: string,
    cursor: string | undefined,
    maxEvents: number
  ): Promise<AgentRunEventPage> {
    const offset = parseEventCursor(cursor, repoId, runId);
    let resolved: Awaited<ReturnType<PathSandbox["resolve"]>>;
    try {
      resolved = await this.sandbox.resolve(eventsPath);
    } catch (error) {
      if (isNotFoundError(error)) return emptyPage();
      return emptyPage("AGENT_RUN_EVENTS_UNSAFE");
    }
    if (!resolved.stat.isFile() || resolved.stat.isSymbolicLink()) {
      return emptyPage("AGENT_RUN_EVENTS_UNSAFE");
    }

    const fileSize = Number(resolved.stat.size);
    if (offset > fileSize) {
      throw new RepoReaderError("VALIDATION_ERROR", "Event cursor is beyond the current event artifact.");
    }
    if (offset === fileSize) return emptyPage();

    const readLength = Math.min(MAX_EVENT_READ_BYTES, Math.max(ESTIMATED_EVENT_BYTES, maxEvents * ESTIMATED_EVENT_BYTES), fileSize - offset);
    const buffer = Buffer.alloc(readLength);
    const handle = await open(resolved.absolutePath, "r");
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, readLength, offset));
    } finally {
      await handle.close();
    }

    const events: AgentRunnerEvent[] = [];
    const warnings: string[] = [];
    let skippedCount = 0;
    let consumed = 0;
    while (consumed < bytesRead && events.length < maxEvents) {
      const newline = buffer.indexOf(0x0a, consumed);
      if (newline === -1 && offset + bytesRead < fileSize) break;
      const lineEnd = newline === -1 ? bytesRead : newline;
      const nextOffset = newline === -1 ? bytesRead : newline + 1;
      const line = buffer.subarray(consumed, lineEnd).toString("utf8").trim();
      consumed = nextOffset;
      if (!line) continue;
      const event = parseBoundEvent(line, repoId, runId);
      if (event.ok) {
        events.push(event.value);
      } else {
        skippedCount += 1;
        warnings.push(event.warning);
      }
    }

    if (consumed === 0 && bytesRead > 0) {
      consumed = bytesRead;
      skippedCount += 1;
      warnings.push("AGENT_RUN_EVENT_LINE_TOO_LARGE");
    }
    const absoluteOffset = offset + consumed;
    const truncated = absoluteOffset < fileSize;
    return {
      events,
      returned_count: events.length,
      skipped_count: skippedCount,
      truncated,
      ...(truncated ? { next_cursor: encodeEventCursor(repoId, runId, absoluteOffset) } : {}),
      warnings: [...new Set(warnings)]
    };
  }
}

function parseBoundEvent(
  line: string,
  repoId: string,
  runId: string
): { ok: true; value: AgentRunnerEvent } | { ok: false; warning: string } {
  try {
    const event = AgentRunnerEventSchema.parse(JSON.parse(line));
    if (event.repo_id !== repoId || event.run_id !== runId) {
      return { ok: false, warning: "AGENT_RUN_EVENT_ID_MISMATCH" };
    }
    return {
      ok: true,
      value: {
        ...event,
        ...(event.summary === undefined ? {} : { summary: redactSensitiveText(event.summary) })
      }
    };
  } catch {
    return { ok: false, warning: "AGENT_RUN_EVENT_INVALID" };
  }
}

function emptyPage(warning?: string): AgentRunEventPage {
  return {
    events: [],
    returned_count: 0,
    skipped_count: 0,
    truncated: false,
    warnings: warning ? [warning] : []
  };
}
