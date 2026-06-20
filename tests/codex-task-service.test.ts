import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { CodexTaskInputSchema } from "../src/contracts/codex-task.contract.js";
import { CodexTaskService } from "../src/services/codex-task-service.js";
import { CodexResultService } from "../src/services/codex-result-service.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("Codex task services", () => {
  test("prepare renders a copyable Codex prompt with completion contract", () => {
    const service = createTaskService("/repo");
    const result = service.prepare({
      repo_id: "demo",
      title: "Fix login expiry",
      objective: "Read src/auth.ts and fix expired login handling.",
      inspect_first: ["src/auth.ts", "tests/auth.test.ts"],
      allowed_paths: ["src/auth.ts", "tests/auth.test.ts"],
      verification_commands: ["npm test -- tests/auth.test.ts"],
      context_summary: "Expired tokens are accepted in the refresh flow."
    });

    expect(result).toMatchObject({
      ok: true,
      repo_id: "demo",
      run_id: "2026-06-04T081500Z-fix-login-expiry",
      prompt_path: ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/PROMPT.md",
      result_path: ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md",
      manifest_path: ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/run.json",
      codex_user_prompt: "Implement .chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/PROMPT.md",
      warnings: []
    });
    expect(result.prompt_markdown).toContain("# Codex Task");
    expect(result.prompt_markdown).toContain("Read src/auth.ts and fix expired login handling.");
    expect(result.prompt_markdown).toContain(".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/RESULT.md");
    expect(result.prompt_markdown).toContain("Do not edit `.chatgpt/**` except this run's `RESULT.md`.");
    expect(result.next_steps).toContain("This tool did not write PROMPT.md. If Codex should implement from a repo path, call repo_write_codex_task with the same task fields before giving codex_user_prompt to Codex.");
    expect(result.next_steps).toContain("Use codex_user_prompt directly only for chat-copy mode where you paste the rendered prompt into Codex yourself.");
  });

  test("write stores prompt and manifest under .chatgpt/codex-runs", async () => {
    const fixture = await createRepoFixture();
    const service = createTaskService(fixture.root);

    const result = await service.write({
      repo_id: "demo",
      title: "Fix login expiry",
      objective: "Read src/auth.ts and implement.",
      inspect_first: ["src/auth.ts"],
      allowed_paths: ["src/**", "tests/**"],
      dry_run: false
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      written_paths: [
        ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/PROMPT.md",
        ".chatgpt/codex-runs/2026-06-04T081500Z-fix-login-expiry/run.json"
      ]
    });
    await expect(readFile(join(fixture.root, result.prompt_path), "utf8")).resolves.toContain("# Codex Task");
    const manifest = JSON.parse(await readFile(join(fixture.root, result.manifest_path), "utf8")) as {
      run_id?: string;
      result_path?: string;
      objective?: string;
      created_at?: string;
    };
    expect(manifest).toMatchObject({
      run_id: result.run_id,
      result_path: result.result_path,
      objective: "Read src/auth.ts and implement.",
      created_at: "2026-06-04T081500Z"
    });
  });

  test("write dry_run writes no files", async () => {
    const fixture = await createRepoFixture();
    const service = createTaskService(fixture.root);

    const result = await service.write({
      repo_id: "demo",
      title: "Fix login expiry",
      objective: "Read src/auth.ts and implement.",
      dry_run: true
    });

    expect(result).toMatchObject({ ok: true, dry_run: true, written_paths: [] });
    await expect(access(join(fixture.root, result.prompt_path))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(fixture.root, result.manifest_path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("input schema rejects unsafe run ids", () => {
    expect(() => CodexTaskInputSchema.parse({
      repo_id: "demo",
      title: "Task",
      objective: "Do work.",
      run_id: "../escape"
    })).toThrow();
  });

  test("review reports missing result without mutating", async () => {
    const fixture = await createRepoFixture();
    const service = new CodexResultService(new PathSandbox(fixture.root), new GitReviewService(fixture.root));

    const result = await service.review({
      repo_id: "demo",
      run_id: "2026-06-04T081500Z-fix-login-expiry"
    });

    expect(result).toMatchObject({
      ok: true,
      repo_id: "demo",
      run_id: "2026-06-04T081500Z-fix-login-expiry",
      result_found: false,
      warnings: ["CODEX_RESULT_MISSING"]
    });
    expect(result.codex_result).toBeUndefined();
    expect(result.next_steps).toContain("Paste Codex output into ChatGPT, or rerun Codex with the prompt completion contract.");
  });

  test("review parses RESULT.md and includes git review", async () => {
    const fixture = await createRepoFixture();
    await git(fixture.root, ["init"]);
    await git(fixture.root, ["config", "user.email", "test@example.com"]);
    await git(fixture.root, ["config", "user.name", "Test User"]);
    await git(fixture.root, ["add", "--", "src/app.ts"]);
    await git(fixture.root, ["commit", "-m", "initial"]);
    const task = createTaskService(fixture.root).prepare({
      repo_id: "demo",
      title: "Fix login expiry",
      objective: "Read src/auth.ts and implement."
    });
    await writeFile(join(fixture.root, "src", "app.ts"), "export const changed = true;\n");
    await mkdir(dirname(join(fixture.root, task.result_path)), { recursive: true });
    await writeFile(join(fixture.root, task.result_path), [
      "# CODEX_RESULT",
      "",
      "status: completed",
      "summary:",
      "Fixed login expiry.",
      "changed_files:",
      "- src/app.ts",
      "commands_run:",
      "- npm test -- tests/auth.test.ts",
      "tests:",
      "- passed",
      "acceptance_criteria:",
      "- expiry handling fixed",
      "blockers:",
      "- none",
      "followups:",
      "- add integration coverage",
      ""
    ].join("\n"), { flag: "w" });

    const result = await new CodexResultService(new PathSandbox(fixture.root), new GitReviewService(fixture.root)).review({
      repo_id: "demo",
      run_id: task.run_id
    });

    expect(result).toMatchObject({
      ok: true,
      result_found: true,
      codex_result: {
        status: "completed",
        summary: "Fixed login expiry.",
        changed_files: ["src/app.ts"],
        commands_run: ["npm test -- tests/auth.test.ts"],
        blockers: ["none"],
        followups: ["add integration coverage"]
      }
    });
    expect(result.git_review?.changed_paths.map((entry) => entry.path)).toContain("src/app.ts");
    expect(result.next_tool_payloads).toBeDefined();
  });

  test("review redacts secret-like RESULT.md content before parsing and returning raw_text", async () => {
    const fixture = await createRepoFixture();
    await git(fixture.root, ["init"]);
    await git(fixture.root, ["config", "user.email", "test@example.com"]);
    await git(fixture.root, ["config", "user.name", "Test User"]);
    await git(fixture.root, ["add", "--", "src/app.ts"]);
    await git(fixture.root, ["commit", "-m", "initial"]);
    const task = createTaskService(fixture.root).prepare({
      repo_id: "demo",
      title: "Fix login expiry",
      objective: "Read src/auth.ts and implement."
    });
    await mkdir(dirname(join(fixture.root, task.result_path)), { recursive: true });
    await writeFile(join(fixture.root, task.result_path), [
      "# CODEX_RESULT",
      "status: completed",
      "summary: used sk-test12345678901234567890 in notes",
      "changed_files:",
      "- src/app.ts",
      ""
    ].join("\n"), { flag: "w" });

    const result = await new CodexResultService(new PathSandbox(fixture.root), new GitReviewService(fixture.root)).review({
      repo_id: "demo",
      run_id: task.run_id
    });

    expect(result.codex_result?.summary).toBe("used [REDACTED_SECRET] in notes");
    expect(result.codex_result?.raw_text).toContain("[REDACTED_SECRET]");
    expect(result.codex_result?.raw_text).not.toContain("sk-test12345678901234567890");
  });

  test("review rejects oversized RESULT.md before returning raw_text", async () => {
    const fixture = await createRepoFixture();
    await git(fixture.root, ["init"]);
    await git(fixture.root, ["config", "user.email", "test@example.com"]);
    await git(fixture.root, ["config", "user.name", "Test User"]);
    await git(fixture.root, ["add", "--", "src/app.ts"]);
    await git(fixture.root, ["commit", "-m", "initial"]);
    const task = createTaskService(fixture.root).prepare({
      repo_id: "demo",
      title: "Fix login expiry",
      objective: "Read src/auth.ts and implement."
    });
    await mkdir(dirname(join(fixture.root, task.result_path)), { recursive: true });
    await writeFile(join(fixture.root, task.result_path), `# CODEX_RESULT\nsummary: ${"x".repeat(128_001)}\n`, { flag: "w" });

    await expect(new CodexResultService(new PathSandbox(fixture.root), new GitReviewService(fixture.root)).review({
      repo_id: "demo",
      run_id: task.run_id
    })).rejects.toMatchObject({ code: "SIZE_LIMIT_EXCEEDED" });
  });

  test("review rejects binary RESULT.md before returning raw_text", async () => {
    const fixture = await createRepoFixture();
    await git(fixture.root, ["init"]);
    await git(fixture.root, ["config", "user.email", "test@example.com"]);
    await git(fixture.root, ["config", "user.name", "Test User"]);
    await git(fixture.root, ["add", "--", "src/app.ts"]);
    await git(fixture.root, ["commit", "-m", "initial"]);
    const task = createTaskService(fixture.root).prepare({
      repo_id: "demo",
      title: "Fix login expiry",
      objective: "Read src/auth.ts and implement."
    });
    await mkdir(dirname(join(fixture.root, task.result_path)), { recursive: true });
    await writeFile(join(fixture.root, task.result_path), Buffer.from([0x00, 0xff, 0x00, 0xff]));

    await expect(new CodexResultService(new PathSandbox(fixture.root), new GitReviewService(fixture.root)).review({
      repo_id: "demo",
      run_id: task.run_id
    })).rejects.toMatchObject({ code: "BINARY_FILE_REJECTED" });
  });

  test("review surfaces sandbox errors instead of reporting missing result", async () => {
    const fixture = await createRepoFixture();
    const task = createTaskService(fixture.root).prepare({
      repo_id: "demo",
      title: "Fix login expiry",
      objective: "Read src/auth.ts and implement."
    });
    await mkdir(join(fixture.root, task.result_path), { recursive: true });

    await expect(new CodexResultService(new PathSandbox(fixture.root), new GitReviewService(fixture.root)).review({
      repo_id: "demo",
      run_id: task.run_id
    })).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
  });
});

function createTaskService(root: string) {
  return new CodexTaskService(root, new PathSandbox(root), new WritePolicy({
    enabled: true,
    allowed_globs: [".chatgpt/codex-runs/**"]
  }), fixedNow);
}

function fixedNow() {
  return new Date(Date.UTC(2026, 5, 4, 8, 15, 0, 0));
}

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  return stdout;
}
