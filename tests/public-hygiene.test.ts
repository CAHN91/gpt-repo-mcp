import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

describe("public hygiene", () => {
  test("Git ignores bounded local config backup names", async () => {
    const { stdout } = await execFileAsync("git", [
      "check-ignore",
      "--no-index",
      "--",
      "config.local.json.backup-before-release",
      "team.local.json.bak"
    ], { cwd: process.cwd() });

    expect(stdout.trim().split("\n")).toEqual([
      "config.local.json.backup-before-release",
      "team.local.json.bak"
    ]);
  });

  test("public check rejects an already tracked local config backup", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "public-hygiene-"));
    const scriptPath = resolve(process.cwd(), "scripts/check-public.mjs");
    await execFileAsync("git", ["init", "--quiet"], { cwd: sandbox });
    await writeFile(join(sandbox, "config.local.json.backup-before-release"), "{}\n");
    await execFileAsync("git", ["add", "--", "config.local.json.backup-before-release"], { cwd: sandbox });

    await expect(execFileAsync(process.execPath, [scriptPath], { cwd: sandbox })).rejects.toMatchObject({
      stderr: expect.stringContaining("tracked local-only/private artifact is forbidden")
    });
  });
});
