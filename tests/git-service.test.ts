import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { RepoReaderError } from "../src/runtime/errors.js";
import { GitService } from "../src/services/git-service.js";

const execFileAsync = promisify(execFile);

describe("GitService", () => {
  test("parses porcelain status including rename paths", async () => {
    const root = await createGitFixture();
    await rename(join(root, "src", "app.ts"), join(root, "src", "main.ts"));
    await git(root, ["add", "-A"]);
    await writeFile(join(root, "src", "main.ts"), "export const app = 2;\n");
    await writeFile(join(root, "notes.md"), "# Notes\n");

    const result = await new GitService(root).status();

    expect(result.clean).toBe(false);
    expect(result.files).toEqual(
      expect.arrayContaining([
        { index: "R", worktree: "M", path: "src/main.ts", original_path: "src/app.ts" },
        { index: "?", worktree: "?", path: "notes.md" }
      ])
    );
    expect(result.counts.RM).toBe(1);
    expect(result.counts["??"]).toBe(1);
  });

  test("parses diff file status, hunks, and rename metadata", async () => {
    const root = await createGitFixture();
    await rename(join(root, "src", "app.ts"), join(root, "src", "main.ts"));
    await writeFile(join(root, "src", "other.ts"), "export const other = 2;\n");
    await git(root, ["add", "-A"]);

    const result = await new GitService(root).diff({ staged: true });

    expect(result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/main.ts",
        original_path: "src/app.ts",
        status: "renamed"
      }),
      expect.objectContaining({
        path: "src/other.ts",
        status: "modified",
        hunks: [expect.stringContaining("@@")]
      })
    ]));
  });

  test("validates path filters through repo-relative policy", async () => {
    const root = await createGitFixture();

    await expect(new GitService(root).diff({ paths: ["../outside.ts"] })).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_REJECTED"
    } satisfies Partial<RepoReaderError>);
  });

  test("truncates large diffs with warning", async () => {
    const root = await createGitFixture();
    await writeFile(join(root, "src", "app.ts"), Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));

    const result = await new GitService(root).diff({ max_bytes: 120 });

    expect(result.truncated).toBe(true);
    expect(result.warnings).toEqual([
      "Diff content truncated by max_bytes (120); Git completed successfully."
    ]);
  });

  test("hides mixed-case internal runner artifacts from status and diff", async () => {
    const root = await createGitFixture();
    const path = ".ChAtGpT/CoDeX-RuNs/2026-07-13T170000Z-private/RuNnEr.SeSsIoN.JsOn";
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), '{"thread_id":"baseline"}\n');
    await git(root, ["add", "-f", path]);
    await git(root, ["commit", "-m", "private runner baseline"]);
    await writeFile(join(root, path), '{"thread_id":"private-canary"}\n');

    const service = new GitService(root);
    const status = await service.status();
    const diff = await service.diff({});

    expect(status.files.map((file) => file.path)).not.toContain(path);
    expect(diff.files.map((file) => file.path)).not.toContain(path);
    expect(JSON.stringify({ status, diff })).not.toContain("private-canary");
  });
});

async function createGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "repo-reader-git-"));
  await mkdir(join(root, "src"), { recursive: true });
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await writeFile(join(root, "src", "app.ts"), "export const app = 1;\n");
  await writeFile(join(root, "src", "other.ts"), "export const other = 1;\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd, env: { PATH: process.env.PATH ?? "" } });
}
