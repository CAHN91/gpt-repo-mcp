import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";
import { createConnectorRuntime } from "./connector-runtime.mjs";
import {
  resolveNgrokTunnelCommand,
  resolveNgrokVersionCommand,
  resolveNpmDevCommand
} from "./platform-command.mjs";

const CONFIG_PATH = "./config.local.json";
const PORT = "8787";
const NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";
const publicPathToken = randomBytes(16).toString("hex");
const runtime = createConnectorRuntime();

async function ensureConfigExists() {
  try {
    await access(CONFIG_PATH, constants.F_OK);
  } catch {
    globalThis.console.error("Missing config.local.json. Run: cp config.example.json config.local.json");
    process.exit(1);
  }
}

function ensureNgrokAvailable() {
  const command = resolveNgrokVersionCommand();
  const checker = spawn(command.command, command.args, { stdio: "ignore" });
  checker.once("error", () => {
    globalThis.console.error("ngrok not found. Install ngrok or run npm run mcp and use another tunnel.");
    process.exit(1);
  });
  checker.once("exit", (code) => {
    if (code !== 0) {
      globalThis.console.error("ngrok not found. Install ngrok or run npm run mcp and use another tunnel.");
      process.exit(1);
    }
    void startProcesses();
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function printChatGptUrl(publicUrl) {
  const normalized = publicUrl.replace(/\/$/, "");
  globalThis.console.log(`ChatGPT MCP URL: ${normalized}/t/${publicPathToken}/mcp`);
  globalThis.console.log(
    "This is guess-resistance only, not authentication. Anyone with the full URL can reach the endpoint while the tunnel is running. Stop with Ctrl+C when done."
  );
}

async function readNgrokHttpsUrl() {
  const response = await globalThis.fetch(NGROK_API_URL);
  if (!response.ok) {
    return undefined;
  }
  const payload = await response.json();
  const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
  const httpsTunnel = tunnels.find((tunnel) => typeof tunnel?.public_url === "string" && tunnel.public_url.startsWith("https://"));
  return httpsTunnel?.public_url;
}

async function announceNgrokUrl() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const publicUrl = await readNgrokHttpsUrl();
      if (publicUrl) {
        printChatGptUrl(publicUrl);
        return;
      }
    } catch {
      // Retry while ngrok initializes its local API.
    }
    await sleep(500);
  }

  globalThis.console.log(
    `Could not auto-detect ngrok URL. Open http://127.0.0.1:4040 or look for the HTTPS forwarding URL in [tunnel] output and append /t/${publicPathToken}/mcp.`
  );
}

async function startProcesses() {
  globalThis.console.log("Use the HTTPS ngrok URL with the printed /t/<token>/mcp path in ChatGPT Developer Mode.");

  const mcpCommand = resolveNpmDevCommand();
  const mcp = spawn(mcpCommand.command, mcpCommand.args, {
    env: {
      ...process.env,
      GPT_REPO_CONFIG: CONFIG_PATH,
      REPO_READER_CONFIG: CONFIG_PATH,
      PORT,
      GPT_REPO_PUBLIC_PATH_TOKEN: publicPathToken,
      REPO_READER_PUBLIC_PATH_TOKEN: publicPathToken
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  runtime.track(mcp, "mcp");

  try {
    const existingTunnel = await readNgrokHttpsUrl();
    if (existingTunnel) {
      globalThis.console.log("Reusing existing ngrok tunnel.");
      printChatGptUrl(existingTunnel);
      return;
    }
  } catch {
    // No reusable tunnel detected yet.
  }

  const tunnelCommand = resolveNgrokTunnelCommand(PORT);
  const tunnel = spawn(tunnelCommand.command, tunnelCommand.args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  runtime.track(tunnel, "tunnel");

  void announceNgrokUrl();
}

function handleShutdown(signal) {
  runtime.shutdown(signal, "Shutting down MCP server and tunnel.");
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

await ensureConfigExists();
ensureNgrokAvailable();
