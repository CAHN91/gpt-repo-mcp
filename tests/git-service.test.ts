import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("rejects option-like git revision inputs", async () => {
    const root = await createGitFixture();
    const service = new GitService(root);

    await expect(service.diff({ base: "--output=/tmp/leak.diff" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    } satisfies Partial<RepoReaderError>);

    await expect(service.diff({ base: "HEAD", compare: "--no-index" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    } satisfies Partial<RepoReaderError>);
  });

  test("allows safe revision inputs", async () => {
    const root = await createGitFixture();
    const result = await new GitService(root).diff({ base: "HEAD" });

    expect(result.base).toBe("HEAD");
    expect(result.files).toEqual([]);
  });

  test("redacts secret-looking values from diff hunks", async () => {
    const root = await createGitFixture();
    await writeFile(join(root, "src", "app.ts"), "OPENAI_API_KEY=sk-realSecretValue123\n");

    const result = await new GitService(root).diff({});
    const serialized = JSON.stringify(result.files);

    expect(serialized).toContain("[REDACTED_SECRET]");
    expect(serialized).not.toContain("sk-realSecretValue123");
  });

  test("truncates large diffs with warning", async () => {
    const root = await createGitFixture();
    await writeFile(join(root, "src", "app.ts"), Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));

    const result = await new GitService(root).diff({ max_bytes: 120 });

    expect(result.truncated).toBe(true);
    expect(result.warnings).toEqual([
      "Diff truncated by max_bytes (120). Increase max_bytes or pass paths to narrow the diff before reviewing."
    ]);
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
