import { describe, expect, test } from "vitest";
import {
  buildMcpRoutePatterns,
  buildPublicMcpPath,
  isAuthorizedMcpPath,
  sanitizeMcpRouteForAudit
} from "../src/runtime/mcp-routes.js";

describe("public MCP path token routing", () => {
  test("keeps /mcp authorized when no public path token is configured", () => {
    expect(buildMcpRoutePatterns(undefined)).toEqual(["/mcp"]);
    expect(isAuthorizedMcpPath("/mcp", undefined)).toBe(true);
    expect(isAuthorizedMcpPath("/t/anything/mcp", undefined)).toBe(false);
  });

  test("requires the token-prefixed path when a public path token is configured", () => {
    const token = ["0123456789abcdef", "0123456789abcdef"].join("");
    const authorizedPath = `/t/${token}/mcp`;

    expect(buildMcpRoutePatterns(token)).toEqual(["/t/:publicPathToken/mcp"]);
    expect(buildPublicMcpPath(token)).toBe(authorizedPath);
    expect(isAuthorizedMcpPath("/mcp", token)).toBe(false);
    expect(isAuthorizedMcpPath(authorizedPath, token)).toBe(true);
    expect(isAuthorizedMcpPath("/t/wrong/mcp", token)).toBe(false);
  });

  test("sanitizes token-prefixed routes for audit logs", () => {
    const token = ["0123456789abcdef", "0123456789abcdef"].join("");
    expect(sanitizeMcpRouteForAudit("/mcp")).toBe("/mcp");
    expect(sanitizeMcpRouteForAudit(`/t/${token}/mcp`)).toBe("/t/[token]/mcp");
    expect(sanitizeMcpRouteForAudit("/t/secret-token-value/mcp")).toBe("/t/[token]/mcp");
  });
});
