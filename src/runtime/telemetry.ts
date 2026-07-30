import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { redactSensitiveText } from "./result-envelope.js";

export type RequestTelemetryContext = {
  request_id: string;
  http_method?: string;
  route?: string;
  mcp_session?: "present" | "missing";
  mcp_method?: string;
  mcp_tool?: string;
};

export type AuditEvent = {
  tool: string;
  repo_id?: string;
  paths?: string[];
  globs?: string[];
  counts?: Record<string, number>;
  truncated?: boolean;
  warnings?: string[];
  request_id?: string;
  mcp_method?: string;
  mcp_tool?: string;
};

export type RequestAuditEvent = {
  event: "mcp_request_start" | "mcp_request_finish" | "mcp_request_error";
  request_id: string;
  http_method: string;
  route: string;
  status_code?: number;
  duration_ms?: number;
  error_category?: McpRequestErrorCategory;
  mcp_session?: "present" | "missing";
  mcp_method?: string;
  mcp_tool?: string;
};

export type McpRequestErrorCategory =
  | "invalid_session"
  | "session_capacity"
  | "transport_request"
  | "transport_close"
  | "server_initialization"
  | "internal";

const requestTelemetry = new AsyncLocalStorage<RequestTelemetryContext>();
const AUDIT_LABEL_MAX_LENGTH = 128;
const REQUEST_ID_PRETTY_LENGTH = 8;

type LogFormat = "json" | "pretty";
type LogColor = "auto" | "always" | "never";

export function createRequestId(): string {
  return randomUUID();
}

export function withRequestTelemetry<T>(
  context: RequestTelemetryContext,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return requestTelemetry.run(context, fn);
}

export function getRequestTelemetry(): RequestTelemetryContext | undefined {
  return requestTelemetry.getStore();
}

export function sanitizeAuditLabel(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return redactSensitiveText(value).slice(0, AUDIT_LABEL_MAX_LENGTH);
}

export function getLogFormat(): LogFormat {
  const value = process.env.GPT_REPO_LOG_FORMAT ?? process.env.REPO_READER_LOG_FORMAT;
  return value === "pretty" ? "pretty" : "json";
}

function getLogColor(): LogColor {
  const value = process.env.GPT_REPO_LOG_COLOR ?? process.env.REPO_READER_LOG_COLOR;
  return value === "always" || value === "never" ? value : "auto";
}

export function shouldColorize(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  const color = getLogColor();
  if (color === "always") {
    return true;
  }
  if (color === "never") {
    return false;
  }
  return Boolean(process.stderr.isTTY);
}

export function colorize(value: string, color: "green" | "red" | "cyan" | "dim"): string {
  if (!shouldColorize()) {
    return value;
  }
  const codes = {
    green: ["\u001b[32m", "\u001b[39m"],
    red: ["\u001b[31m", "\u001b[39m"],
    cyan: ["\u001b[36m", "\u001b[39m"],
    dim: ["\u001b[2m", "\u001b[22m"]
  } satisfies Record<string, [string, string]>;
  const [open, close] = codes[color];
  return `${open}${value}${close}`;
}

function shortRequestId(requestId: string | undefined): string | undefined {
  return requestId?.slice(0, REQUEST_ID_PRETTY_LENGTH);
}

function compactParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

export function formatAuditLine(event: AuditEvent): string {
  return compactParts([
    colorize("*", "cyan"),
    event.tool,
    event.repo_id ? `repo=${event.repo_id}` : undefined,
    event.truncated === true ? "truncated=true" : undefined,
    event.request_id ? `req=${shortRequestId(event.request_id)}` : undefined
  ]);
}

export function formatRequestAuditLine(event: RequestAuditEvent): string {
  if (event.event === "mcp_request_start") {
    return compactParts([
      colorize("->", "green"),
      event.http_method,
      event.route,
      event.mcp_method,
      event.mcp_tool,
      event.mcp_session ? `session=${event.mcp_session}` : undefined,
      `req=${shortRequestId(event.request_id)}`
    ]);
  }

  const marker = event.event === "mcp_request_error" ? colorize("x", "red") : colorize("<-", "green");
  return compactParts([
    marker,
    String(event.status_code ?? (event.event === "mcp_request_error" ? 500 : "")),
    event.http_method,
    event.route,
    event.duration_ms === undefined ? undefined : `${event.duration_ms}ms`,
    event.error_category ? `category=${event.error_category}` : undefined,
    event.mcp_method,
    event.mcp_tool,
    `req=${shortRequestId(event.request_id)}`
  ]);
}

export function createAuditEvent(event: AuditEvent): AuditEvent {
  const context = getRequestTelemetry();
  const safe: AuditEvent = {
    request_id: event.request_id ?? context?.request_id,
    ...event,
    mcp_method: sanitizeAuditLabel(event.mcp_method ?? context?.mcp_method),
    mcp_tool: sanitizeAuditLabel(event.mcp_tool ?? context?.mcp_tool),
    paths: event.paths?.map((path) => redactSensitiveText(path)),
    globs: event.globs?.map((glob) => redactSensitiveText(glob)),
    warnings: event.warnings?.map((warning) => redactSensitiveText(warning))
  };
  return withoutUndefinedAuditFields(safe);
}

export function audit(event: AuditEvent): void {
  const safe = createAuditEvent(event);
  if (getLogFormat() === "pretty") {
    console.error(formatAuditLine(safe));
    return;
  }
  console.error(JSON.stringify({ level: "audit", ...safe }));
}

export function createRequestAuditEvent(event: RequestAuditEvent): RequestAuditEvent {
  return {
    event: event.event,
    request_id: event.request_id,
    http_method: event.http_method,
    route: event.route,
    status_code: event.status_code,
    duration_ms: event.duration_ms,
    error_category: sanitizeErrorCategory(event.error_category),
    mcp_session: event.mcp_session,
    mcp_method: sanitizeAuditLabel(event.mcp_method),
    mcp_tool: sanitizeAuditLabel(event.mcp_tool)
  };
}

function sanitizeErrorCategory(value: McpRequestErrorCategory | undefined): McpRequestErrorCategory | undefined {
  return [
    "invalid_session",
    "session_capacity",
    "transport_request",
    "transport_close",
    "server_initialization",
    "internal"
  ].includes(value ?? "") ? value : undefined;
}

export function requestAudit(event: RequestAuditEvent): void {
  const safe = createRequestAuditEvent(event);
  if (getLogFormat() === "pretty") {
    console.error(formatRequestAuditLine(safe));
    return;
  }
  console.error(JSON.stringify({ level: "audit", ...safe }));
}

function withoutUndefinedAuditFields(event: AuditEvent): AuditEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined)
  ) as AuditEvent;
}
