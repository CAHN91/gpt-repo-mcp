import { afterEach, describe, expect, test } from "vitest";
import { audit, requestAudit } from "../src/runtime/telemetry.js";

const originalEnv = {
  GPT_REPO_LOG_FORMAT: process.env.GPT_REPO_LOG_FORMAT,
  GPT_REPO_LOG_COLOR: process.env.GPT_REPO_LOG_COLOR,
  REPO_READER_LOG_FORMAT: process.env.REPO_READER_LOG_FORMAT,
  REPO_READER_LOG_COLOR: process.env.REPO_READER_LOG_COLOR,
  NO_COLOR: process.env.NO_COLOR
};

function captureAuditLine(fn: () => void): string {
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    lines.push(String(message));
  };

  try {
    fn();
  } finally {
    console.error = originalError;
  }

  expect(lines).toHaveLength(1);
  return lines[0] ?? "";
}

afterEach(() => {
  restoreEnv("GPT_REPO_LOG_FORMAT", originalEnv.GPT_REPO_LOG_FORMAT);
  restoreEnv("GPT_REPO_LOG_COLOR", originalEnv.GPT_REPO_LOG_COLOR);
  restoreEnv("REPO_READER_LOG_FORMAT", originalEnv.REPO_READER_LOG_FORMAT);
  restoreEnv("REPO_READER_LOG_COLOR", originalEnv.REPO_READER_LOG_COLOR);
  restoreEnv("NO_COLOR", originalEnv.NO_COLOR);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("telemetry log formatting", () => {
  test("json mode remains the default and emits valid JSON", () => {
    delete process.env.REPO_READER_LOG_FORMAT;

    const line = captureAuditLine(() => {
      requestAudit({
        event: "mcp_request_start",
        request_id: "fb946167-1234",
        http_method: "POST",
        route: "/mcp",
        mcp_session: "present",
        mcp_method: "tools/list"
      });
    });

    const parsed = JSON.parse(line) as { level?: string; event?: string };
    expect(parsed).toMatchObject({
      level: "audit",
      event: "mcp_request_start"
    });
  });

  test("pretty mode emits compact request and tool audit lines", () => {
    process.env.REPO_READER_LOG_FORMAT = "pretty";
    process.env.REPO_READER_LOG_COLOR = "never";

    const start = captureAuditLine(() => {
      requestAudit({
        event: "mcp_request_start",
        request_id: "fb946167-1234",
        http_method: "POST",
        route: "/mcp",
        mcp_session: "present",
        mcp_method: "tools/list"
      });
    });
    const finish = captureAuditLine(() => {
      requestAudit({
        event: "mcp_request_finish",
        request_id: "fb946167-1234",
        http_method: "POST",
        route: "/mcp",
        status_code: 200,
        duration_ms: 11,
        mcp_method: "tools/list"
      });
    });
    const tool = captureAuditLine(() => {
      audit({
        tool: "repo_git_status",
        repo_id: "chatgpt-mcp-oss",
        request_id: "dacdc91d-5678"
      });
    });

    expect(start).toBe("-> POST /mcp tools/list session=present req=fb946167");
    expect(finish).toBe("<- 200 POST /mcp 11ms tools/list req=fb946167");
    expect(tool).toBe("* repo_git_status repo=chatgpt-mcp-oss req=dacdc91d");
  });

  test("GPT_REPO log env vars are preferred over legacy aliases", () => {
    process.env.GPT_REPO_LOG_FORMAT = "pretty";
    process.env.GPT_REPO_LOG_COLOR = "never";
    process.env.REPO_READER_LOG_FORMAT = "json";
    process.env.REPO_READER_LOG_COLOR = "always";

    const line = captureAuditLine(() => {
      requestAudit({
        event: "mcp_request_start",
        request_id: "fb946167-1234",
        http_method: "POST",
        route: "/mcp",
        mcp_session: "present",
        mcp_method: "tools/list"
      });
    });

    expect(line).toBe("-> POST /mcp tools/list session=present req=fb946167");
    expect(line).not.toContain("\u001b[");
  });

  test("pretty error lines include status, request id, method, and tool", () => {
    process.env.REPO_READER_LOG_FORMAT = "pretty";
    process.env.REPO_READER_LOG_COLOR = "never";

    const line = captureAuditLine(() => {
      requestAudit({
        event: "mcp_request_error",
        request_id: "a91f0c2b-1234",
        http_method: "POST",
        route: "/mcp",
        status_code: 500,
        duration_ms: 4,
        error_category: "transport_request",
        mcp_method: "tools/call",
        mcp_tool: "repo_write_stage"
      });
    });

    expect(line).toBe("x 500 POST /mcp 4ms category=transport_request tools/call repo_write_stage req=a91f0c2b");
  });

  test("pretty mode redacts and caps malicious MCP labels", () => {
    process.env.REPO_READER_LOG_FORMAT = "pretty";
    process.env.REPO_READER_LOG_COLOR = "never";

    const line = captureAuditLine(() => {
      requestAudit({
        event: "mcp_request_start",
        request_id: "fb946167-1234",
        http_method: "POST",
        route: "/mcp",
        mcp_session: "present",
        mcp_method: `/Users/example/project/.env-${"m".repeat(200)}`,
        mcp_tool: `OPENAI_API_KEY=sk-secret-${"t".repeat(200)}`
      });
    });

    expect(line).not.toContain("/Users/example");
    expect(line).not.toContain("sk-secret");
    expect(line).not.toContain("arguments");
    expect(line).not.toContain("content");
    expect(line.length).toBeLessThan(360);
  });

  test("color can be disabled and NO_COLOR disables forced color", () => {
    process.env.REPO_READER_LOG_FORMAT = "pretty";
    process.env.REPO_READER_LOG_COLOR = "always";
    process.env.NO_COLOR = "1";

    const noColorLine = captureAuditLine(() => {
      audit({ tool: "repo_git_status", request_id: "dacdc91d-5678" });
    });
    expect(noColorLine).not.toContain("\u001b[");

    delete process.env.NO_COLOR;
    const colorLine = captureAuditLine(() => {
      audit({ tool: "repo_git_status", request_id: "dacdc91d-5678" });
    });
    expect(colorLine).toContain("\u001b[");
  });
});
