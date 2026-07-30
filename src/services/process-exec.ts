import { spawn, type ChildProcess } from "node:child_process";

const TERMINATION_GRACE_MS = 250;
const FORCE_SETTLE_GRACE_MS = 250;

export type ProcessTailResult = {
  exit_code?: number;
  signal?: string;
  timed_out: boolean;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
};

export async function runProcessWithTail(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout_ms: number;
  tail_bytes: number;
}): Promise<ProcessTailResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const append = (current: Buffer, chunk: Buffer) => {
      const combined = Buffer.concat([current, chunk]);
      return combined.length > input.tail_bytes ? combined.subarray(combined.length - input.tail_bytes) : combined;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    let timedOut = false;
    let forced = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;

    const finish = (result: Omit<ProcessTailResult, "duration_ms" | "stdout_tail" | "stderr_tail"> & {
      stderrSuffix?: string;
    }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      const stderrText = result.stderrSuffix
        ? append(stderr, Buffer.from(`\n${result.stderrSuffix}`, "utf8")).toString("utf8").trim()
        : stderr.toString("utf8");
      const processResult = { ...result };
      delete processResult.stderrSuffix;
      resolve({
        ...processResult,
        duration_ms: Date.now() - started,
        stdout_tail: stdout.toString("utf8"),
        stderr_tail: stderrText
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      forceTimer = setTimeout(() => {
        forced = true;
        terminateProcessTree(child, "SIGKILL");
        forceSettleTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish({ signal: "SIGKILL", timed_out: true });
        }, FORCE_SETTLE_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    }, input.timeout_ms);

    child.once("error", (error) => {
      finish({
        timed_out: timedOut,
        stderrSuffix: error.message
      });
    });
    child.once("close", (code, signal) => {
      finish({
        ...(typeof code === "number" ? { exit_code: code } : {}),
        ...(signal ? { signal } : forced ? { signal: "SIGKILL" } : {}),
        timed_out: timedOut
      });
    });
  });
}

function terminateProcessTree(child: Pick<ChildProcess, "pid" | "kill">, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      taskkill.once("error", () => {
        child.kill("SIGKILL");
      });
      taskkill.unref();
      return;
    }
    child.kill(signal);
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
