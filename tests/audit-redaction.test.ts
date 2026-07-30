import { describe, expect, test } from "vitest";
import {
  createAuditEvent,
  requestAudit,
  withRequestTelemetry
} from "../src/runtime/telemetry.js";

describe("audit redaction", () => {
  test("redacts absolute paths and secret-looking values from audit event fields", () => {
    const event = createAuditEvent({
      tool: "repo_fetch_file",
      repo_id: "example",
      paths: ["/Users/example/project/.env"],
      globs: ["/tmp/private/**/*.ts"],
      warnings: ["Failed with OPENAI_API_KEY=sk-secret and /Users/example/project/.env"]
    });

    const serialized = JSON.stringify(event);

    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("/tmp/private");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).toContain("[REDACTED_PATH]");
    expect(serialized).toContain("[REDACTED_SECRET]");
  });

  test("audit event created inside request telemetry includes safe correlation fields", () => {
    const event = withRequestTelemetry(
      {
        request_id: "req_test",
        http_method: "POST",
        route: "/mcp",
        mcp_session: "present",
        mcp_method: "tools/call",
        mcp_tool: "repo_write_stage"
      },
      () =>
        createAuditEvent({
          tool: "repo_write_stage",
          repo_id: "example",
          paths: [".chatgpt/tool-tests/file.md"]
        })
    );

    expect(event).toMatchObject({
      request_id: "req_test",
      mcp_method: "tools/call",
      mcp_tool: "repo_write_stage",
      tool: "repo_write_stage"
    });
    expect(JSON.stringify(event)).not.toContain("mcp-session-id");
  });

  test("audit event created inside request telemetry redacts and caps MCP labels", async () => {
    const longToolName = `/Users/example/project/.env-${"x".repeat(200)}-OPENAI_API_KEY=sk-secret`;
    const event = await withRequestTelemetry(
      {
        request_id: "req_test",
        http_method: "POST",
        route: "/mcp",
        mcp_session: "present",
        mcp_method: `/tmp/private/tools/call-${"y".repeat(200)}`,
        mcp_tool: longToolName
      },
      () =>
        createAuditEvent({
          tool: "repo_write_stage",
          repo_id: "example"
        })
    );

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("/tmp/private");
    expect(serialized).not.toContain("sk-secret");
    expect(event.mcp_tool?.length).toBeLessThanOrEqual(128);
    expect(event.mcp_method?.length).toBeLessThanOrEqual(128);
  });

  test("requestAudit logs safe request metadata without request body or arguments", () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      lines.push(String(message));
    };

    try {
      requestAudit({
        event: "mcp_request_start",
        request_id: "req_test",
        http_method: "POST",
        route: "/mcp",
        mcp_session: "present",
        mcp_method: "tools/call",
        mcp_tool: "repo_write_file"
      });
    } finally {
      console.error = originalError;
    }

    expect(lines).toHaveLength(1);
    const serialized = lines[0] ?? "";
    expect(serialized).toContain("mcp_request_start");
    expect(serialized).toContain("req_test");
    expect(serialized).toContain("repo_write_file");
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("mcp-session-id");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("/Users/example");
  });

  test("requestAudit redacts and caps client-controlled MCP labels", () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      lines.push(String(message));
    };

    try {
      requestAudit({
        event: "mcp_request_start",
        request_id: "req_test",
        http_method: "POST",
        route: "/mcp",
        mcp_session: "present",
        mcp_method: `/Users/example/project/.env-${"m".repeat(200)}`,
        mcp_tool: `OPENAI_API_KEY=sk-secret-${"t".repeat(200)}`
      });
    } finally {
      console.error = originalError;
    }

    const parsed = JSON.parse(lines[0] ?? "{}") as {
      mcp_method?: string;
      mcp_tool?: string;
    };
    const serialized = lines[0] ?? "";
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("sk-secret");
    expect(parsed.mcp_method?.length).toBeLessThanOrEqual(128);
    expect(parsed.mcp_tool?.length).toBeLessThanOrEqual(128);
  });

  test("request errors log only an allowlisted category and request correlation", () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      lines.push(String(message));
    };

    try {
      requestAudit({
        event: "mcp_request_error",
        request_id: "req_safe_category",
        http_method: "POST",
        route: "/mcp",
        status_code: 500,
        error_category: "server_initialization"
      });
    } finally {
      console.error = originalError;
    }

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "mcp_request_error",
      request_id: "req_safe_category",
      error_category: "server_initialization"
    });
    expect(lines[0]).not.toContain("stack");
    expect(lines[0]).not.toContain("message");
    expect(lines[0]).not.toContain("body");
  });
});
