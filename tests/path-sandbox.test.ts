import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";

describe("PathSandbox", () => {
  test("rejects absolute model-supplied paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("/etc/passwd")).rejects.toMatchObject({
      code: "ABSOLUTE_PATH_REJECTED"
    });
  });

  test("rejects path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("../outside.txt")).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_REJECTED"
    });
  });

  test("rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    const outside = await mkdtemp(join(tmpdir(), "repo-reader-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "linked-secret.txt"));

    const sandbox = new PathSandbox(root);

    await expect(sandbox.resolve("linked-secret.txt")).rejects.toMatchObject({
      code: "SYMLINK_ESCAPE_REJECTED"
    });
  });

  test("reports canonical repo path for in-repo symlink aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, ".env"), "API_TOKEN=secret\n");
    await symlink(join(root, ".env"), join(root, "docs", "public-env.md"));

    const resolved = await new PathSandbox(root).resolve("docs/public-env.md");

    expect(resolved.repoPath).toBe("docs/public-env.md");
    expect(resolved.canonicalRepoPath).toBe(".env");
  });

  test("detects nested repositories without treating them as normal files", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-"));
    await mkdir(join(root, "vendor", "lib", ".git"), { recursive: true });

    const sandbox = new PathSandbox(root);
    const result = await sandbox.classifyBoundary("vendor/lib");

    expect(result).toEqual({ kind: "nested_repo", path: "vendor/lib" });
  });
});
