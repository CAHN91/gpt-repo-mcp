import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { readConfigDocument } from "../config/store.js";
import { validateConfigDocument } from "../config/validation.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";

export type DoctorChecks = {
  ngrokInstalled: () => Promise<boolean>;
  hasActiveNgrokTunnel: () => Promise<boolean>;
  isPortInUse: (port: number) => Promise<boolean>;
  isGitWorktreeDirty: (cwd: string) => Promise<boolean>;
};

type DoctorIo = {
  cwd: string;
  stdout: (line: string) => void;
  doctorChecks?: Partial<DoctorChecks>;
};

const execFileAsync = promisify(execFile);

export async function runDoctor(configPath: string, io: DoctorIo): Promise<number> {
  const checks = { ...defaultDoctorChecks(), ...io.doctorChecks };
  let hasFail = false;

  const fail = (message: string) => {
    hasFail = true;
    io.stdout(`FAIL ${message}`);
  };

  if (typeof fetch === "function" && Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 18) {
    io.stdout(`PASS Node.js ${process.versions.node} supports global fetch`);
  } else {
    fail(`Node.js ${process.versions.node} does not support global fetch; use Node.js 18 or newer`);
  }

  io.stdout(`INFO config path: ${configPath}`);

  let configRepoCount = 0;
  try {
    const document = await readConfigDocument(configPath);
    io.stdout(`${basename(configPath) === "config.local.json" ? "PASS config.local.json found" : `PASS config found: ${basename(configPath)}`}`);

    const result = await validateConfigDocument(document);
    if (result.issues.length > 0) {
      fail(`config invalid: ${result.issues.length} issue(s) found`);
      for (const issue of result.issues) {
        io.stdout(`FAIL [${issue.code}] ${issue.message}`);
      }
    } else {
      configRepoCount = result.config?.repos.length ?? 0;
      io.stdout(`PASS config validated: ${configRepoCount} repo(s)`);
      for (const warning of result.warnings) {
        io.stdout(`WARN [${warning.code}] ${warning.message}`);
      }
      for (const repo of result.config?.repos ?? []) {
        io.stdout(`PASS repo root git repository: ${repo.repo_id}`);
      }
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      fail(`${basename(configPath)} missing`);
    } else {
      fail(`config unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await checkPackageScripts(io, fail);
  await checkNgrok(io, checks);
  await checkNgrokTunnel(io, checks);
  await checkPort8787(io, checks);
  await checkGitStatus(io, checks);

  if (configRepoCount === 0 && !hasFail) {
    io.stdout("WARN config has no repositories; add one before using npm run connect");
  }

  return hasFail ? 1 : 0;
}

async function checkPackageScripts(io: DoctorIo, fail: (message: string) => void): Promise<void> {
  const required = ["mcp", "tunnel", "connect", "build", "typecheck", "lint", "test"];
  try {
    const raw = await readFile(join(io.cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    for (const script of required) {
      if (typeof parsed.scripts?.[script] === "string") {
        io.stdout(`PASS package script found: ${script}`);
      } else {
        fail(`package script missing: ${script}`);
      }
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      fail("package.json missing");
      return;
    }
    fail(`package.json unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkNgrok(io: DoctorIo, checks: DoctorChecks): Promise<void> {
  try {
    io.stdout(await checks.ngrokInstalled()
      ? "PASS ngrok installed"
      : "WARN ngrok not found; npm run connect needs ngrok or an existing HTTPS tunnel");
  } catch {
    io.stdout("WARN ngrok check failed");
  }
}

async function checkNgrokTunnel(io: DoctorIo, checks: DoctorChecks): Promise<void> {
  try {
    io.stdout(await checks.hasActiveNgrokTunnel()
      ? "PASS active ngrok HTTPS tunnel detected"
      : "INFO no active ngrok tunnel detected");
  } catch {
    io.stdout("INFO no active ngrok tunnel detected");
  }
}

async function checkPort8787(io: DoctorIo, checks: DoctorChecks): Promise<void> {
  try {
    io.stdout(await checks.isPortInUse(8787)
      ? "WARN port 8787 is already in use; the MCP server or another process may already be running"
      : "PASS port 8787 is available");
  } catch {
    io.stdout("WARN port 8787 check failed");
  }
}

async function checkGitStatus(io: DoctorIo, checks: DoctorChecks): Promise<void> {
  try {
    io.stdout(await checks.isGitWorktreeDirty(io.cwd)
      ? "WARN git worktree dirty"
      : "PASS git worktree clean");
  } catch {
    io.stdout("WARN git status unavailable");
  }
}

function defaultDoctorChecks(): DoctorChecks {
  return {
    ngrokInstalled: async () => {
      try {
        await execFileAsync("ngrok", ["version"], { env: { PATH: process.env.PATH ?? "" } });
        return true;
      } catch {
        return false;
      }
    },
    hasActiveNgrokTunnel: async () => {
      const response = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (!response.ok) return false;
      const payload = await response.json() as { tunnels?: Array<{ public_url?: unknown }> };
      return (payload.tunnels ?? []).some((tunnel) =>
        typeof tunnel.public_url === "string" && tunnel.public_url.startsWith("https://")
      );
    },
    isPortInUse,
    isGitWorktreeDirty: async (cwd) => {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd,
        env: { PATH: process.env.PATH ?? "" }
      });
      return stdout.trim().length > 0;
    }
  };
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolvePort(error.code === "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolvePort(false));
    });
    server.listen(port, "127.0.0.1");
  });
}
