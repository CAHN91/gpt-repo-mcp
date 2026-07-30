import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const children = new Set<ChildProcess>();

describe("server network boundary", () => {
  afterEach(async () => {
    await Promise.all([...children].map((child) => stopChild(child)));
  });

  test("defaults to an explicit loopback binding", async () => {
    const server = await startServer();
    await waitForHealth(server);

    expect(server.output()).toContain(`http://127.0.0.1:${server.port}/mcp`);
  });

  test("rejects an external bind unless it is explicitly authorized", async () => {
    const server = await startServer({ GPT_REPO_HOST: "0.0.0.0" });
    const exited = await waitForExit(server.child, 4_000);

    expect(exited).toBe(true);
    expect(server.child.exitCode).not.toBe(0);
    expect(server.output()).toContain("GPT_REPO_ALLOW_EXTERNAL_BIND=true");
  });

  test("rejects browser requests from a non-loopback origin and host", async () => {
    const server = await startServer();
    await waitForHealth(server);

    const response = await httpRequest(server.port, {
      Host: "attacker.example",
      Origin: "https://attacker.example"
    });

    expect(response).toMatchObject({ status: 403, body: "Forbidden origin" });
  });

  test("allows an explicitly authorized external bind", async () => {
    const server = await startServer({
      GPT_REPO_ALLOW_EXTERNAL_BIND: "true",
      GPT_REPO_HOST: "0.0.0.0"
    });

    await waitForHealth(server);
    expect(server.output()).toContain(`http://0.0.0.0:${server.port}/mcp`);
  });

  test("bounds MCP sessions and releases capacity on DELETE", async () => {
    const server = await startServer({ GPT_REPO_MAX_SESSIONS: "1" });
    await waitForHealth(server);

    const first = await initializeSession(server.port);
    expect(first.status).toBe(200);
    expect(first.sessionId).toEqual(expect.any(String));

    const rejected = await initializeSession(server.port);
    expect(rejected.status).toBe(503);
    await waitForOutput(server, '"error_category":"session_capacity"');

    const deleted = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "DELETE",
      headers: {
        Accept: "application/json, text/event-stream",
        "mcp-session-id": first.sessionId ?? ""
      }
    });
    await deleted.text();
    expect(deleted.ok).toBe(true);

    const replacement = await initializeSession(server.port);
    expect(replacement.status).toBe(200);
    expect(replacement.sessionId).toEqual(expect.any(String));
  });

  test("audits an invalid session with safe category and request correlation", async () => {
    const server = await startServer();
    await waitForHealth(server);

    const response = await httpRequest(server.port, {
      "mcp-session-id": "do-not-log-this-session-id"
    });

    expect(response.status).toBe(400);
    await waitForOutput(server, '"error_category":"invalid_session"');
    expect(server.output()).toContain('"request_id":');
    expect(server.output()).not.toContain("do-not-log-this-session-id");
  });
});

async function initializeSession(port: number): Promise<{ status: number; sessionId: string | null }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "session-boundary-test", version: "1.0.0" }
      }
    })
  });
  await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id")
  };
}

async function startServer(extraEnv: Record<string, string> = {}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gpt-repo-network-boundary-"));
  const configPath = join(fixtureRoot, "config.json");
  const port = await freePort();
  await writeFile(configPath, JSON.stringify({ repos: [], limits: {} }), "utf8");
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GPT_REPO_CONFIG: configPath,
      PORT: String(port),
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.once("exit", () => {
    children.delete(child);
    void rm(fixtureRoot, { recursive: true, force: true });
  });
  return { child, output: () => output, port };
}

async function waitForHealth(server: Awaited<ReturnType<typeof startServer>>): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      throw new Error(`Server exited before becoming healthy.\n${server.output()}`.trim());
    }
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        signal: AbortSignal.timeout(300)
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become healthy.\n${server.output()}`.trim());
}

async function waitForOutput(
  server: Awaited<ReturnType<typeof startServer>>,
  expected: string
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (server.output().includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Server output did not contain ${expected}.\n${server.output()}`);
}

function httpRequest(port: number, headers: Record<string, string>): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "GET",
      headers
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode, body });
      });
    });
    req.once("error", reject);
    req.end();
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a local port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return Promise.race([
    once(child, "exit").then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  if (!await waitForExit(child, 1_000)) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}
