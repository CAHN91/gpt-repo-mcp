import { spawn } from "node:child_process";
import { RepoReaderError } from "../runtime/errors.js";

const DEFAULT_STDERR_LIMIT = 128 * 1024;

export type BoundedProcessResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
};

export async function runGitBounded(input: {
  root: string;
  args: string[];
  max_stdout_bytes: number;
  max_stderr_bytes?: number;
  allow_stdout_truncation?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<BoundedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", input.args, {
      cwd: input.root,
      env: input.env ?? { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const stderrLimit = input.max_stderr_bytes ?? DEFAULT_STDERR_LIMIT;

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = input.max_stdout_bytes - stdoutBytes;
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        stdout.push(accepted);
        stdoutBytes += accepted.length;
      }
      if (chunk.length > Math.max(remaining, 0)) stdoutTruncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = stderrLimit - stderrBytes;
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        stderr.push(accepted);
        stderrBytes += accepted.length;
      }
      if (chunk.length > Math.max(remaining, 0)) stderrTruncated = true;
    });
    child.on("error", (error) => reject(new RepoReaderError("GIT_ERROR", error.message)));
    child.on("close", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exit_code: code ?? 1,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated
      };
      if (code !== 0) {
        reject(new RepoReaderError("GIT_ERROR", result.stderr.trim() || `Git exited with ${code ?? signal ?? "unknown"}.`, {
          diagnostics: { exit_code: code, signal, stderr_truncated: stderrTruncated }
        }));
        return;
      }
      if (stdoutTruncated && !input.allow_stdout_truncation) {
        reject(new RepoReaderError("SIZE_LIMIT_EXCEEDED", "Git output exceeded the bounded inspection limit.", {
          diagnostics: { max_stdout_bytes: input.max_stdout_bytes, source: "git_stdout" }
        }));
        return;
      }
      resolve(result);
    });
  });
}
