export function buildPublicMcpPath(token: string): string {
  return `/t/${encodeURIComponent(token)}/mcp`;
}

export function buildMcpRoutePatterns(token: string | undefined): string[] {
  return token ? ["/t/:publicPathToken/mcp"] : ["/mcp"];
}

export function sanitizeMcpRouteForAudit(path: string): "/mcp" | "/t/[token]/mcp" {
  return path.startsWith("/t/") && path.endsWith("/mcp") ? "/t/[token]/mcp" : "/mcp";
}

export function isAuthorizedMcpPath(path: string, token: string | undefined): boolean {
  if (!token) {
    return path === "/mcp";
  }

  return path === buildPublicMcpPath(token);
}
