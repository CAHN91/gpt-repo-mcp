import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { RootRegistry } from "./services/root-registry.js";
import { createMcpServer } from "./register.js";
import type { RuntimeContext } from "./runtime/context.js";
import { buildMcpRoutePatterns, isAuthorizedMcpPath, sanitizeMcpRouteForAudit } from "./runtime/mcp-routes.js";
import {
  createRequestId,
  requestAudit,
  withRequestTelemetry,
  type RequestTelemetryContext
} from "./runtime/telemetry.js";

const port = Number(process.env.PORT ?? 8787);
const configPath = process.env.GPT_REPO_CONFIG ?? process.env.REPO_READER_CONFIG;
const publicPathToken = process.env.GPT_REPO_PUBLIC_PATH_TOKEN ?? process.env.REPO_READER_PUBLIC_PATH_TOKEN;

const registry = configPath
  ? await RootRegistry.fromFile(configPath)
  : await RootRegistry.fromConfig({ repos: [], limits: {} });
const context: RuntimeContext = { registry };

const app = express();
app.use(express.json({ limit: "2mb" }));

const transports: Record<string, StreamableHTTPServerTransport> = {};
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
    try {
      let transport: StreamableHTTPServerTransport | undefined;
      if (typeof sessionId === "string" && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) {
              transports[newSessionId] = transport;
            }
          }
        });
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            delete transports[closedSessionId];
          }
        };
        await createMcpServer(context).connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid MCP session" },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch {
      requestAudit({
        event: "mcp_request_error",
        request_id: requestContext.request_id,
        http_method: requestContext.http_method ?? "POST",
        route: requestContext.route ?? "/mcp",
        duration_ms: Date.now() - startedAt,
        mcp_session: requestContext.mcp_session,
        mcp_method: requestContext.mcp_method,
        mcp_tool: requestContext.mcp_tool
      });
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
      if (typeof sessionId !== "string" || !transports[sessionId]) {
        res.status(400).send("Invalid or missing MCP session id");
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    } catch {
      requestAudit({
        event: "mcp_request_error",
        request_id: requestContext.request_id,
        http_method: requestContext.http_method ?? "GET",
        route: requestContext.route ?? "/mcp",
        duration_ms: Date.now() - startedAt,
        mcp_session: requestContext.mcp_session,
        mcp_method: requestContext.mcp_method,
        mcp_tool: requestContext.mcp_tool
      });
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
      if (typeof sessionId !== "string" || !transports[sessionId]) {
        res.status(400).send("Invalid or missing MCP session id");
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    } catch {
      requestAudit({
        event: "mcp_request_error",
        request_id: requestContext.request_id,
        http_method: requestContext.http_method ?? "DELETE",
        route: requestContext.route ?? "/mcp",
        duration_ms: Date.now() - startedAt,
        mcp_session: requestContext.mcp_session,
        mcp_method: requestContext.mcp_method,
        mcp_tool: requestContext.mcp_tool
      });
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });
});

app.listen(port, () => {
  const localPath = publicPathToken ? "/t/[token]/mcp" : "/mcp";
  console.error(`gpt-repo-mcp listening on http://localhost:${port}${localPath}`);
});
