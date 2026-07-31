import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redactSecretValues } from "../policies/secret-patterns.js";
import { RepoReaderError, toRepoReaderError } from "./errors.js";

export type ToolContent = { type: "text"; text: string };

export type SuccessEnvelope<T> = {
  structuredContent: T;
  content: ToolContent[];
  _meta?: Record<string, unknown>;
  isError?: undefined;
};

export type ErrorEnvelope = {
  isError: true;
  structuredContent: {
    ok: false;
    error: {
      code: string;
      message: string;
      retryable: boolean;
      diagnostics?: Record<string, unknown>;
    };
  };
  content: ToolContent[];
};

export function redactSensitiveText(value: string): string {
  return redactSecretValues(value)
    .replace(/(?:\/Users|\/home|\/private|\/var|\/tmp)\/[^\s"'`]+/g, "[REDACTED_PATH]")
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, "[REDACTED_PATH]");
}

export function createSuccessEnvelope<T>(
  structuredContent: T,
  summary: string,
  meta?: Record<string, unknown>
): SuccessEnvelope<T> & CallToolResult {
  return {
    structuredContent,
    content: [{ type: "text", text: redactSensitiveText(summary) }],
    ...(meta ? { _meta: meta } : {})
  } as SuccessEnvelope<T> & CallToolResult;
}

export function createErrorEnvelope(error: RepoReaderError | Error | {
  code: string;
  message: string;
  retryable?: boolean;
  diagnostics?: Record<string, unknown>;
}): ErrorEnvelope & CallToolResult {
  const normalized = error instanceof RepoReaderError || error instanceof Error
    ? toRepoReaderError(error)
    : new RepoReaderError("INTERNAL_ERROR", error.message, {
        retryable: error.retryable,
        diagnostics: error.diagnostics
      });

  const message = redactSensitiveText(normalized.message);
  const diagnostics = sanitizeDiagnostics(normalized.diagnostics);
  return {
    isError: true,
    structuredContent: {
      ok: false,
      error: {
        code: normalized.code,
        message,
        retryable: normalized.retryable,
        ...(diagnostics
          ? { diagnostics }
          : {})
      }
    },
    content: [{ type: "text", text: `${normalized.code}: ${message}` }]
  } as ErrorEnvelope & CallToolResult;
}

function sanitizeDiagnostics(diagnostics: Record<string, unknown>): Record<string, unknown> | undefined {
  const safe: Record<string, unknown> = {};

  copyPathArrayDiagnostic(diagnostics, safe, "applied_paths");
  copyPathArrayDiagnostic(diagnostics, safe, "rolled_back_paths");
  copyPathArrayDiagnostic(diagnostics, safe, "actual_paths");
  copyPathArrayDiagnostic(diagnostics, safe, "expected_paths");
  copyPathDiagnostic(diagnostics, safe, "failed_path");
  copyShaDiagnostic(diagnostics, safe, "head_sha");
  copyShaDiagnostic(diagnostics, safe, "expected_head_sha");
  copyShaDiagnostic(diagnostics, safe, "current_sha256");
  copyShaDiagnostic(diagnostics, safe, "expected_old_sha256");
  copySafeTextDiagnostic(diagnostics, safe, "recovery_hint");

  return Object.keys(safe).length > 0 ? safe : undefined;
}

function copyPathArrayDiagnostic(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (!Array.isArray(value)) {
    return;
  }
  const paths = value.filter(isSafeRepoPath);
  if (paths.length > 0) {
    target[key] = paths;
  }
}

function copyPathDiagnostic(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (isSafeRepoPath(value)) {
    target[key] = value;
  }
}

function copyShaDiagnostic(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value)) {
    target[key] = value;
  }
}

function copySafeTextDiagnostic(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  const value = source[key];
  if (typeof value !== "string" || value.length > 300) {
    return;
  }
  const redacted = redactSensitiveText(value);
  if (redacted === value) {
    target[key] = value;
  }
}

function isSafeRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
