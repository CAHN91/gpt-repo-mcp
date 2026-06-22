import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

const CONFIG_PATH = "./config.local.json";
const PORT = "8787";
const NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";
const publicPathToken = randomBytes(16).toString("hex");

const children = [];
let shuttingDown = false;

function prefixOutput(stream, label) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      process.stdout.write(`[${label}] ${line}\n`);
    }
  });

  stream.on("end", () => {
    if (buffer.length > 0) {
      process.stdout.write(`[${label}] ${buffer}\n`);
    }
  });
}

function terminateChildren(signal = "SIGTERM") {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

async function ensureConfigExists() {
  try {
    await access(CONFIG_PATH, constants.F_OK);
  } catch {
    globalThis.console.error("Missing config.local.json. Run: cp config.example.json config.local.json");
    process.exit(1);
  }
}

function ensureNgrokAvailable() {
  const checker = spawn("ngrok", ["version"], { stdio: "ignore", shell: process.platform === "win32" });

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
  const httpsTunnel = tunnels.find(
    (tunnel) => typeof tunnel?.public_url === "string" && tunnel.public_url.startsWith("https://")
  );

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

  const mcp = spawn("npm run dev", {
    shell: true,
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

  children.push(mcp);

  mcp.once("error", (error) => {
    globalThis.console.error(`[mcp] failed to start: ${error.message}`);
    terminateChildren("SIGTERM");
    process.exit(1);
  });

  prefixOutput(mcp.stdout, "mcp");
  prefixOutput(mcp.stderr, "mcp");

  const onChildExit = (name) => (code, signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    globalThis.console.error(`[${name}] exited (code=${code ?? "null"}, signal=${signal ?? "null"}). Stopping other process.`);
    terminateChildren("SIGTERM");
    globalThis.setTimeout(() => terminateChildren("SIGKILL"), 1500);
    process.exit(code ?? 1);
  };

  mcp.once("exit", onChildExit("mcp"));

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

  const tunnel = spawn("ngrok", ["http", PORT, "--log=stdout"], {
    shell: process.platform === "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  children.push(tunnel);

  tunnel.once("error", (error) => {
    globalThis.console.error(`[tunnel] failed to start: ${error.message}`);
    terminateChildren("SIGTERM");
    process.exit(1);
  });

  prefixOutput(tunnel.stdout, "tunnel");
  prefixOutput(tunnel.stderr, "tunnel");
  tunnel.once("exit", onChildExit("tunnel"));

  void announceNgrokUrl();
}

function handleShutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  globalThis.console.log(`Received ${signal}. Shutting down MCP server and tunnel.`);
  terminateChildren("SIGTERM");
  globalThis.setTimeout(() => terminateChildren("SIGKILL"), 1500);
  globalThis.setTimeout(() => process.exit(0), 1700);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

await ensureConfigExists();
ensureNgrokAvailable();