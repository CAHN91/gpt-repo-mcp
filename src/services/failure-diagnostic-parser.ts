import { isAbsolute, relative } from "node:path";
import type { FailureDiagnostic } from "../contracts/failure-diagnose.contract.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";

const MAX_MESSAGE_CHARS = 500;

export function parseFailureDiagnostics(
  text: string,
  source: FailureDiagnostic["source"],
  artifactPath: string,
  root: string
): FailureDiagnostic[] {
  const diagnostics: FailureDiagnostic[] = [];
  const jestLog = /(?:^|\n)Test Suites:\s+\d+\s+failed|\bJest\b/i.test(text);
  let currentTestName: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const testHeader = /^(?:FAIL|FAILED)\s+([^>]+?)(?:\s+>\s+(.+))?$/.exec(line);
    if (testHeader) {
      currentTestName = safeMessage(testHeader[2] ?? testHeader[1]);
      const path = normalizePath(testHeader[1]?.trim(), root);
      diagnostics.push({ tool: line.startsWith("FAILED") ? "pytest" : jestLog ? "jest" : "vitest", source, artifact_path: artifactPath, message: safeMessage(line), ...(path ? { path } : {}), ...(currentTestName ? { test_name: currentTestName } : {}) });
      continue;
    }

    const typescript = /^(.+?)\((\d+),(\d+)\):\s+(?:error|warning)\s+(TS\d+):\s+(.+)$/.exec(line);
    if (typescript) {
      diagnostics.push(locationDiagnostic("typescript", typescript[1], typescript[2], typescript[3], typescript[5], source, artifactPath, root, typescript[4], currentTestName));
      continue;
    }
    const eslint = /^(.+?):(\d+):(\d+)\s+(?:error|warning)\s+(.+?)(?:\s+([@\w/-]+))?$/.exec(line);
    if (eslint) {
      diagnostics.push(locationDiagnostic("eslint", eslint[1], eslint[2], eslint[3], eslint[4], source, artifactPath, root, eslint[5], currentTestName));
      continue;
    }
    const pythonFile = /^File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?$/.exec(line);
    if (pythonFile) {
      diagnostics.push(locationDiagnostic("python", pythonFile[1], pythonFile[2], undefined, pythonFile[3] ?? line, source, artifactPath, root, undefined, currentTestName));
      continue;
    }
    const stackText = line.replace(/^❯\s*/, "");
    const stack = line.startsWith("❯")
      ? /^(.+?\.[cm]?[jt]sx?):(\d+):(\d+)$/.exec(stackText)
      : /^at\s+.*?\((.+?\.[cm]?[jt]sx?):(\d+):(\d+)\)$/.exec(stackText)
        ?? /^at\s+(.+?\.[cm]?[jt]sx?):(\d+):(\d+)$/.exec(stackText);
    if (stack) {
      diagnostics.push(locationDiagnostic(line.startsWith("❯") ? "vitest" : "node", stack[1], stack[2], stack[3], line, source, artifactPath, root, undefined, currentTestName));
      continue;
    }
    const pytest = /^(.+?\.py):(\d+)(?::(\d+))?:\s*(.+)$/.exec(line);
    if (pytest) {
      diagnostics.push(locationDiagnostic("pytest", pytest[1], pytest[2], pytest[3], pytest[4], source, artifactPath, root, undefined, currentTestName));
    }
  }
  return dedupe(diagnostics);
}

function locationDiagnostic(
  tool: FailureDiagnostic["tool"],
  rawPath: string | undefined,
  rawLine: string | undefined,
  rawColumn: string | undefined,
  message: string | undefined,
  source: FailureDiagnostic["source"],
  artifactPath: string,
  root: string,
  code?: string,
  testName?: string
): FailureDiagnostic {
  const path = normalizePath(rawPath, root);
  const line = positiveInteger(rawLine);
  const column = positiveInteger(rawColumn);
  return {
    tool,
    source,
    artifact_path: artifactPath,
    message: safeMessage(message ?? "Diagnostic location"),
    ...(code ? { code: safeMessage(code) } : {}),
    ...(path ? { path } : {}),
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
    ...(testName ? { test_name: testName } : {})
  };
}

function normalizePath(rawPath: string | undefined, root: string): string | undefined {
  if (!rawPath) return undefined;
  const cleaned = rawPath.replace(/^file:\/\//, "").replace(/\\/g, "/").replace(/^\.\//, "");
  const candidate = isAbsolute(cleaned) ? relative(root, cleaned).replace(/\\/g, "/") : cleaned;
  if (!candidate || candidate === ".." || candidate.startsWith("../") || candidate.startsWith(".chatgpt/") || candidate.includes("/../")) return undefined;
  return candidate;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function safeMessage(value: string): string {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS);
}

function dedupe(diagnostics: FailureDiagnostic[]): FailureDiagnostic[] {
  return [...new Map(diagnostics.map((diagnostic) => [
    `${diagnostic.tool}:${diagnostic.path ?? ""}:${diagnostic.line ?? ""}:${diagnostic.column ?? ""}:${diagnostic.message}`,
    diagnostic
  ])).values()];
}
