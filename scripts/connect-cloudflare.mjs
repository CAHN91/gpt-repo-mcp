import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";
import { createConnectorRuntime } from "./connector-runtime.mjs";

const DEFAULT_CONFIG_PATH = "./config.local.json";
const DEFAULT_PORT = "8787";
const publicPathToken = randomBytes(16).toString("hex");
const runtime = createConnectorRuntime();
let printedUrl = false;

await ensureConfigExists(envValue("GPT_REPO_CONFIG", "REPO_READER_CONFIG", DEFAULT_CONFIG_PATH));
ensureCloudflaredAvailable();

function envValue(primaryName, legacyName, fallback) {
  const primary = process.env[primaryName];
  if (primary && primary.trim() !== "") {
    return primary;
  }
  const legacy = legacyName ? process.env[legacyName] : undefined;
  if (legacy && legacy.trim() !== "") {
    return legacy;
  }
  return fallback;
}

async function ensureConfigExists(configPath) {
  try {
    await access(configPath, constants.F_OK);
  } catch {
    globalThis.console.error(`Missing ${configPath}. Run: cp config.example.json ${configPath}`);
    process.exit(1);
  }
}

function ensureCloudflaredAvailable() {
  const checker = spawn("cloudflared", ["--version"], { stdio: "ignore" });
  checker.once("error", () => {
    globalThis.console.error("cloudflared not found. Install cloudflared or use npm run connect / npm run connect:secure.");
    process.exit(1);
  });
  checker.once("exit", (code) => {
    if (code !== 0) {
      globalThis.console.error("cloudflared not found. Install cloudflared or use npm run connect / npm run connect:secure.");
      process.exit(1);
    }
    startProcesses();
  });
}

function maybePrintChatGptUrl(line) {
  if (printedUrl) {
    return;
  }
  const match = line.match(/https:\/\/[-a-z0-9.]+\.trycloudflare\.com/i);
  if (!match) {
    return;
  }
  printedUrl = true;
  const publicUrl = match[0].replace(/\/$/, "");
  globalThis.console.log(`ChatGPT MCP URL: ${publicUrl}/t/${publicPathToken}/mcp`);
  globalThis.console.log(
    "This is guess-resistance only, not authentication. Anyone with the full URL can reach the endpoint while the tunnel is running. Stop with Ctrl+C when done."
  );
}

function startProcesses() {
  const configPath = envValue("GPT_REPO_CONFIG", "REPO_READER_CONFIG", DEFAULT_CONFIG_PATH);
  const port = envValue("PORT", undefined, DEFAULT_PORT);
  const logFormat = envValue("GPT_REPO_LOG_FORMAT", "REPO_READER_LOG_FORMAT", "pretty");
  const originUrl = `http://127.0.0.1:${port}`;

  globalThis.console.log("Starting GPT Repo MCP and Cloudflare Tunnel.");
  globalThis.console.log(`Local MCP URL: ${originUrl}/t/[token]/mcp`);
  globalThis.console.log("Use the printed ChatGPT MCP URL in ChatGPT Developer Mode as a Server URL.");

  const mcp = spawn("npm", ["run", "dev"], {
    env: {
      ...process.env,
      GPT_REPO_CONFIG: configPath,
      REPO_READER_CONFIG: configPath,
      PORT: port,
      GPT_REPO_PUBLIC_PATH_TOKEN: publicPathToken,
      REPO_READER_PUBLIC_PATH_TOKEN: publicPathToken,
      GPT_REPO_LOG_FORMAT: logFormat,
      REPO_READER_LOG_FORMAT: logFormat
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  runtime.track(mcp, "mcp");

  const tunnel = spawn("cloudflared", ["tunnel", "--url", originUrl], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  runtime.track(tunnel, "cloudflare", { onLine: maybePrintChatGptUrl });
}

function handleShutdown(signal) {
  runtime.shutdown(signal, "Shutting down MCP server and Cloudflare Tunnel.");
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
