import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runProcessWithTail } from "../src/services/process-exec.js";

const baseInput = {
  cwd: process.cwd(),
  env: process.env,
  tail_bytes: 1_024
};

describe("runProcessWithTail", () => {
  test("captures bounded output from a normal exit", async () => {
    const result = await runProcessWithTail({
      ...baseInput,
      executable: process.execPath,
      args: ["-e", "process.stdout.write('before-after'); process.stderr.write('warning');"],
      timeout_ms: 2_000,
      tail_bytes: 5
    });

    expect(result).toMatchObject({
      exit_code: 0,
      timed_out: false,
      stdout_tail: "after",
      stderr_tail: "rning"
    });
  });

  test("returns spawn failures without waiting for the timeout", async () => {
    const result = await runProcessWithTail({
      ...baseInput,
      executable: join(process.cwd(), "__missing_process_executable__"),
      args: [],
      timeout_ms: 2_000
    });

    expect(result.timed_out).toBe(false);
    expect(result.duration_ms).toBeLessThan(1_000);
    expect(result.stderr_tail).toMatch(/ENOENT|not found/i);
  });

  test("allows a process to exit during the SIGTERM grace period", async () => {
    const result = await runProcessWithTail({
      ...baseInput,
      executable: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => { process.stderr.write('terminated'); process.exit(0); }); process.stdout.write('ready'); setInterval(() => {}, 1000);"
      ],
      timeout_ms: 100
    });

    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toContain("ready");
    expect(result.stderr_tail).toContain("terminated");
  });

  test("escalates to a forced kill when SIGTERM is ignored", async () => {
    const result = await runProcessWithTail({
      ...baseInput,
      executable: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setTimeout(() => process.exit(0), 1200);"
      ],
      timeout_ms: 100
    });

    expect(result.timed_out).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.duration_ms).toBeLessThan(900);
    expect(result.stdout_tail).toContain("ready");
  }, 3_000);

  test("forces an inherited child-process tree to release captured pipes", async () => {
    const grandchildScript =
      "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 1200);";
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'inherit' });`,
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('tree-ready');",
      "setTimeout(() => process.exit(0), 1200);"
    ].join(" ");

    const result = await runProcessWithTail({
      ...baseInput,
      executable: process.execPath,
      args: ["-e", parentScript],
      timeout_ms: 100
    });

    expect(result.timed_out).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.duration_ms).toBeLessThan(900);
    expect(result.stdout_tail).toContain("tree-ready");
  }, 3_000);
});
