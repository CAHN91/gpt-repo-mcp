import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { RootRegistry } from "./services/root-registry.js";
import { CodeIntelligenceService } from "./services/code-intelligence-service.js";
import { createCodebaseMemoryClientFactory } from "./services/codebase-memory-client.js";
import { createMcpServer } from "./register.js";
import type { RuntimeContext } from "./runtime/context.js";
import { buildMcpRoutePatterns, isAuthorizedMcpPath, sanitizeMcpRouteForAudit } from "./runtime/mcp-routes.js";
import { isAllowedBrowserOrigin, resolveServerHost } from "./runtime/network-boundary.js";
import { TransportSessionStore, type SessionReservation } from "./runtime/transport-session-store.js";
import {
  createRequestId,
  requestAudit,
  withRequestTelemetry,
  type McpRequestErrorCategory,
  type RequestTelemetryContext
} from "./runtime/telemetry.js";

const port = Number(process.env.PORT ?? 8787);
const host = resolveServerHost(process.env);
const configPath = process.env.GPT_REPO_CONFIG ?? process.env.REPO_READER_CONFIG;
const publicPathToken = process.env.GPT_REPO_PUBLIC_PATH_TOKEN ?? process.env.REPO_READER_PUBLIC_PATH_TOKEN;
const maxSessions = readBoundedInteger("GPT_REPO_MAX_SESSIONS", 100, 1, 1_000);
const sessionIdleTtlMs = readBoundedInteger("GPT_REPO_SESSION_IDLE_TTL_MS", 30 * 60_000, 1_000, 24 * 60 * 60_000);

const registry = configPath
  ? await RootRegistry.fromFile(configPath)
  : await RootRegistry.fromConfig({ repos: [], limits: {} });
const codeIntelligenceConfig = registry.codeIntelligence;
const codeIntelligence = codeIntelligenceConfig
  ? new CodeIntelligenceService(
      createCodebaseMemoryClientFactory(codeIntelligenceConfig.executable),
      codeIntelligenceConfig.query_timeout_ms,
      codeIntelligenceConfig.index_timeout_ms
    )
  : undefined;
const context: RuntimeContext = { registry, codeIntelligence };

const app = express();
app.use((req, res, next) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const requestHost = typeof req.headers.host === "string" ? req.headers.host : undefined;
  if (!isAllowedBrowserOrigin(origin, requestHost)) {
    res.status(403).send("Forbidden origin");
    return;
  }
  next();
});
app.use(express.json({ limit: "2mb" }));

const transports = new TransportSessionStore<StreamableHTTPServerTransport>({
  maxSessions,
  idleTtlMs: sessionIdleTtlMs
});
const mcpRoutePatterns = buildMcpRoutePatterns(publicPathToken);

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: "gpt-repo-mcp" });
});

function createMcpRequestContext(req: Request): RequestTelemetryContext {
  const method = typeof req.body?.method === "string" ? req.body.method : undefined;
  const tool =
    method === "tools/call" && typeof req.body?.params?.name === "string"
      ? req.body.params.name
      : undefined;

  return {
    request_id: createRequestId(),
    http_method: req.method,
    route: sanitizeMcpRouteForAudit(req.path),
    mcp_session: typeof req.headers["mcp-session-id"] === "string" ? "present" : "missing",
    mcp_method: method,
    mcp_tool: tool
  };
}

function attachMcpRequestAuditing(res: Response, context: RequestTelemetryContext, startedAt: number): void {
  res.on("finish", () => {
    requestAudit({
      event: "mcp_request_finish",
      request_id: context.request_id,
      http_method: context.http_method ?? "UNKNOWN",
      route: context.route ?? "/mcp",
      status_code: res.statusCode,
      duration_ms: Date.now() - startedAt,
      mcp_session: context.mcp_session,
      mcp_method: context.mcp_method,
      mcp_tool: context.mcp_tool
    });
  });
}

function rejectUnauthorizedMcpPath(req: Request, res: Response): boolean {
  if (isAuthorizedMcpPath(req.path, publicPathToken)) {
    return false;
  }
  res.status(404).send("Not found");
  return true;
}

app.post(mcpRoutePatterns, async (req: Request, res: Response) => {
  const requestContext = createMcpRequestContext(req);
  const startedAt = Date.now();
  attachMcpRequestAuditing(res, requestContext, startedAt);

  return withRequestTelemetry(requestContext, async () => {
    requestAudit({
      event: "mcp_request_start",
      request_id: requestContext.request_id,
      http_method: requestContext.http_method ?? "POST",
      route: requestContext.route ?? "/mcp",
      mcp_session: requestContext.mcp_session,
      mcp_method: requestContext.mcp_method,
      mcp_tool: requestContext.mcp_tool
    });

    if (rejectUnauthorizedMcpPath(req, res)) {
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    let transport: StreamableHTTPServerTransport | undefined;
    let reservation: SessionReservation<StreamableHTTPServerTransport> | undefined;
    let errorCategory: McpRequestErrorCategory = "internal";
    try {
      if (typeof sessionId === "string") {
        transport = transports.get(sessionId);
      }
      if (transport) {
        // Existing session.
      } else if (!sessionId && isInitializeRequest(req.body)) {
        reservation = await transports.reserve();
        if (!reservation) {
          auditMcpRequestError(requestContext, startedAt, "session_capacity", 503);
          res.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "MCP session capacity reached" },
            id: (req.body as { id?: unknown }).id ?? null
          });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport && reservation) {
              reservation.commit(newSessionId, transport);
              reservation = undefined;
            }
          }
        });
        errorCategory = "server_initialization";
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.remove(closedSessionId);
          }
        };
        await createMcpServer(context).connect(transport);
      } else {
        auditMcpRequestError(requestContext, startedAt, "invalid_session", 400);
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid MCP session" },
          id: null
        });
        return;
      }

      errorCategory = "transport_request";
      await transport.handleRequest(req, res, req.body);
    } catch {
      reservation?.release();
      if (transport?.sessionId) {
        await transports.close(transport.sessionId).catch(() => undefined);
      }
      auditMcpRequestError(requestContext, startedAt, errorCategory, 500);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });
});

app.get(mcpRoutePatterns, async (req: Request, res: Response) => {
  const requestContext = createMcpRequestContext(req);
  const startedAt = Date.now();
  attachMcpRequestAuditing(res, requestContext, startedAt);

  return withRequestTelemetry(requestContext, async () => {
    requestAudit({
      event: "mcp_request_start",
      request_id: requestContext.request_id,
      http_method: requestContext.http_method ?? "GET",
      route: requestContext.route ?? "/mcp",
      mcp_session: requestContext.mcp_session,
      mcp_method: requestContext.mcp_method,
      mcp_tool: requestContext.mcp_tool
    });

    if (rejectUnauthorizedMcpPath(req, res)) {
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"];
      const transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (!transport) {
        auditMcpRequestError(requestContext, startedAt, "invalid_session", 400);
        res.status(400).send("Invalid or missing MCP session id");
        return;
      }
      await transport.handleRequest(req, res);
    } catch {
      auditMcpRequestError(requestContext, startedAt, "transport_request", 500);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });
});

app.delete(mcpRoutePatterns, async (req: Request, res: Response) => {
  const requestContext = createMcpRequestContext(req);
  const startedAt = Date.now();
  attachMcpRequestAuditing(res, requestContext, startedAt);

  return withRequestTelemetry(requestContext, async () => {
    requestAudit({
      event: "mcp_request_start",
      request_id: requestContext.request_id,
      http_method: requestContext.http_method ?? "DELETE",
      route: requestContext.route ?? "/mcp",
      mcp_session: requestContext.mcp_session,
      mcp_method: requestContext.mcp_method,
      mcp_tool: requestContext.mcp_tool
    });

    if (rejectUnauthorizedMcpPath(req, res)) {
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"];
      const transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (!transport || typeof sessionId !== "string") {
        auditMcpRequestError(requestContext, startedAt, "invalid_session", 400);
        res.status(400).send("Invalid or missing MCP session id");
        return;
      }
      await transport.handleRequest(req, res);
      await transports.close(sessionId);
    } catch {
      auditMcpRequestError(requestContext, startedAt, "transport_close", 500);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });
});

const sessionCleanupTimer = setInterval(() => {
  void transports.sweepExpired();
}, Math.min(sessionIdleTtlMs, 60_000));
sessionCleanupTimer.unref();

const httpServer = app.listen(port, host, () => {
  const localPath = publicPathToken ? "/t/[token]/mcp" : "/mcp";
  console.error(`gpt-repo-mcp listening on http://${host}:${port}${localPath}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sessionCleanupTimer);
  await transports.closeAll();
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function auditMcpRequestError(
  context: RequestTelemetryContext,
  startedAt: number,
  errorCategory: McpRequestErrorCategory,
  statusCode: number
): void {
  requestAudit({
    event: "mcp_request_error",
    request_id: context.request_id,
    http_method: context.http_method ?? "UNKNOWN",
    route: context.route ?? "/mcp",
    status_code: statusCode,
    duration_ms: Date.now() - startedAt,
    error_category: errorCategory,
    mcp_session: context.mcp_session,
    mcp_method: context.mcp_method,
    mcp_tool: context.mcp_tool
  });
}
