import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { GitOperationsService } from "../src/services/git-operations-service.js";
import { OperationsPolicy } from "../src/services/operations-policy.js";

const execFileAsync = promisify(execFile);

describe("GitOperationsService", () => {
  test("dry_run stage reports explicit path and does not change index", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    const result = await service.stage({
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      head_sha: fixture.head,
      staged_paths: ["docs/a.md"],
      skipped: [],
      warnings: []
    });
    await expect(stagedPaths(fixture.root)).resolves.toEqual([]);
  });

  test("actual stage stages explicit docs file and does not stage unlisted changed file", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    const result = await service.stage({
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head
    });

    expect(result.staged_paths).toEqual(["docs/a.md"]);
    await expect(stagedPaths(fixture.root)).resolves.toEqual(["docs/a.md"]);
    await expect(worktreePaths(fixture.root)).resolves.toContain("docs/b.md");
  });

  test("stage allows legitimate secret and credential filenames with safe content", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await mkdir(join(fixture.root, "src", "services"), { recursive: true });
    await mkdir(join(fixture.root, "src", "auth"), { recursive: true });
    await mkdir(join(fixture.root, "tests"), { recursive: true });
    await writeFile(join(fixture.root, "src", "services", "secret-scanner.ts"), "export const scanner = true;\n");
    await writeFile(join(fixture.root, "docs", "secret-management.md"), "# Secret Management\nUse placeholders.\n");
    await writeFile(join(fixture.root, "src", "auth", "credentialStore.ts"), "export const store = true;\n");
    await writeFile(join(fixture.root, "tests", "credential-flow.test.ts"), "export const testName = 'credential flow';\n");

    const paths = [
      "docs/secret-management.md",
      "src/auth/credentialStore.ts",
      "src/services/secret-scanner.ts",
      "tests/credential-flow.test.ts"
    ];
    const result = await service.stage({ paths, expected_head_sha: fixture.head });

    expect(result.staged_paths).toEqual(paths);
    await expect(stagedPaths(fixture.root)).resolves.toEqual(paths);
  });

  test("stage allows public env template with placeholders", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await writeFile(join(fixture.root, ".env.example"), "OPENAI_API_KEY=replace-me\nPORT=8787\n");

    const result = await service.stage({
      paths: [".env.example"],
      expected_head_sha: fixture.head
    });

    expect(result.staged_paths).toEqual([".env.example"]);
    await expect(stagedPaths(fixture.root)).resolves.toEqual([".env.example"]);
  });

  test("stage rejects public env template containing secret-looking values", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await writeFile(join(fixture.root, ".env.example"), "OPENAI_API_KEY=sk-realSecretValue123\n");

    await expect(service.stage({
      paths: [".env.example"],
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
    await expect(stagedPaths(fixture.root)).resolves.toEqual([]);
  });

  test("stage still rejects real env files", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await writeFile(join(fixture.root, ".env.local"), "TOKEN=value\n");
    await writeFile(join(fixture.root, ".env.production"), "TOKEN=value\n");
    await writeFile(join(fixture.root, ".env.anything"), "TOKEN=value\n");

    await expect(service.stage({ paths: [".env"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: [".env.local"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: [".env.production"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: [".env.anything"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("stage still rejects hard-risk key paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await mkdir(join(fixture.root, "secrets"), { recursive: true });
    await mkdir(join(fixture.root, "credentials"), { recursive: true });
    await writeFile(join(fixture.root, "docs", "cert.pem"), "not a cert\n");
    await writeFile(join(fixture.root, "docs", "private.key"), "not a key\n");
    await writeFile(join(fixture.root, "docs", "client.p12"), "not a cert bundle\n");
    await writeFile(join(fixture.root, "docs", "client.pfx"), "not a cert bundle\n");
    await writeFile(join(fixture.root, "id_rsa"), "not a key\n");
    await writeFile(join(fixture.root, "id_ed25519"), "not a key\n");
    await writeFile(join(fixture.root, "secrets", "notes.md"), "not a secret\n");
    await writeFile(join(fixture.root, "credentials", "notes.md"), "not a credential\n");

    await expect(service.stage({ paths: ["docs/cert.pem"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: ["docs/private.key"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: ["docs/client.p12"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: ["docs/client.pfx"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: ["id_rsa"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: ["id_ed25519"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: ["secrets/notes.md"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: ["credentials/notes.md"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("stage rejects empty paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.stage({
      paths: [],
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({ code: "GIT_OPERATION_PATHS_REQUIRED" });
  });

  test("stage rejects unsafe paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.stage({ paths: ["."], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
    await expect(service.stage({ paths: [join(fixture.root, "docs", "a.md")], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "ABSOLUTE_PATH_REJECTED"
    });
    await expect(service.stage({ paths: ["../outside.md"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_REJECTED"
    });
    await expect(service.stage({ paths: [".env"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.stage({ paths: ["*"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
    await expect(service.stage({ paths: ["-A"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
    await expect(service.stage({ paths: ["--all"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
  });

  test("stage rejects stale expected_head_sha", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.stage({
      paths: ["docs/a.md"],
      expected_head_sha: "0".repeat(40)
    })).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
  });

  test("dry_run unstage reports explicit path and does not change index", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await service.unstage({
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      head_sha: fixture.head,
      unstaged_paths: ["docs/a.md"],
      skipped: [],
      warnings: []
    });
    await expect(stagedPaths(fixture.root)).resolves.toEqual(["docs/a.md"]);
  });

  test("actual unstage unstages explicit file", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await service.unstage({
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head
    });

    expect(result.unstaged_paths).toEqual(["docs/a.md"]);
    await expect(stagedPaths(fixture.root)).resolves.toEqual([]);
  });

  test("unstage rejects unsafe paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.unstage({ paths: ["."], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
    await expect(service.unstage({ paths: [join(fixture.root, "docs", "a.md")], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "ABSOLUTE_PATH_REJECTED"
    });
    await expect(service.unstage({ paths: ["../outside.md"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_REJECTED"
    });
    await expect(service.unstage({ paths: [".env"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("unstage allows legitimate secret and credential filenames with safe content", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await mkdir(join(fixture.root, "src", "services"), { recursive: true });
    await mkdir(join(fixture.root, "src", "auth"), { recursive: true });
    await writeFile(join(fixture.root, "src", "services", "secret-scanner.ts"), "export const scanner = true;\n");
    await writeFile(join(fixture.root, "src", "auth", "credentialStore.ts"), "export const store = true;\n");
    await git(fixture.root, ["add", "--", "src/services/secret-scanner.ts", "src/auth/credentialStore.ts"]);

    const paths = ["src/auth/credentialStore.ts", "src/services/secret-scanner.ts"];
    const result = await service.unstage({ paths, expected_head_sha: fixture.head });

    expect(result.unstaged_paths).toEqual(paths);
    await expect(stagedPaths(fixture.root)).resolves.toEqual([]);
  });

  test("dry_run restore reports explicit paths and does not change worktree", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    const result = await service.restorePaths({
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      head_sha: fixture.head,
      restored_paths: ["docs/a.md"],
      skipped: [],
      warnings: []
    });
    await expect(readFile(join(fixture.root, "docs", "a.md"), "utf8")).resolves.toBe("A changed\n");
  });

  test("actual restore restores modified unstaged file", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    const result = await service.restorePaths({
      paths: ["docs/a.md"],
      expected_head_sha: fixture.head
    });

    expect(result.restored_paths).toEqual(["docs/a.md"]);
    await expect(readFile(join(fixture.root, "docs", "a.md"), "utf8")).resolves.toBe("A\n");
    await expect(worktreePaths(fixture.root)).resolves.not.toContain("docs/a.md");
  });

  test("actual restore restores multiple modified files", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    const result = await service.restorePaths({
      paths: ["docs/a.md", "docs/b.md"],
      expected_head_sha: fixture.head
    });

    expect(result.restored_paths).toEqual(["docs/a.md", "docs/b.md"]);
    await expect(readFile(join(fixture.root, "docs", "a.md"), "utf8")).resolves.toBe("A\n");
    await expect(readFile(join(fixture.root, "docs", "b.md"), "utf8")).resolves.toBe("B\n");
    await expect(worktreePaths(fixture.root)).resolves.toEqual([]);
  });

  test("restore rejects untracked file through git error and leaves it untouched", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await writeFile(join(fixture.root, "docs", "untracked.md"), "untracked\n");

    await expect(service.restorePaths({
      paths: ["docs/untracked.md"],
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({ code: "GIT_ERROR" });
    await expect(readFile(join(fixture.root, "docs", "untracked.md"), "utf8")).resolves.toBe("untracked\n");
  });

  test("restore rejects stale expected_head_sha", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.restorePaths({
      paths: ["docs/a.md"],
      expected_head_sha: "0".repeat(40)
    })).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
  });

  test("restore rejects empty paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.restorePaths({
      paths: [],
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({ code: "GIT_OPERATION_PATHS_REQUIRED" });
  });

  test("restore rejects unsafe pathspecs", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.restorePaths({ paths: ["."], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
    await expect(service.restorePaths({ paths: ["*"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
    await expect(service.restorePaths({ paths: ["-A"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
    await expect(service.restorePaths({ paths: ["--all"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
    await expect(service.restorePaths({ paths: [join(fixture.root, "docs", "a.md")], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "ABSOLUTE_PATH_REJECTED"
    });
    await expect(service.restorePaths({ paths: ["../outside.md"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_REJECTED"
    });
    await expect(service.restorePaths({ paths: [".git/config"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC"
    });
  });

  test("restore rejects hard-risk secret paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.restorePaths({ paths: [".env"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.restorePaths({ paths: [".env.local"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.restorePaths({ paths: ["docs/private.key"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.restorePaths({ paths: ["id_ed25519"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.restorePaths({ paths: ["secrets/foo.txt"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
    await expect(service.restorePaths({ paths: ["credentials/foo.txt"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("dry_run commit previews staged paths and does not change HEAD", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await service.commit({
      message: "Update docs a",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["docs/a.md"],
      dry_run: true
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      head_before: fixture.head,
      committed_paths: ["docs/a.md"],
      warnings: []
    });
    expect(result.head_after).toBeUndefined();
    await expect(headSha(fixture.root)).resolves.toBe(fixture.head);
  });

  test("actual commit creates local commit and returns commit sha", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await service.commit({
      message: "Update docs a",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["docs/a.md"]
    });

    expect(result.dry_run).toBe(false);
    expect(result.head_before).toBe(fixture.head);
    expect(result.head_after).toMatch(/^[a-f0-9]{40}$/);
    expect(result.commit_sha).toBe(result.head_after);
    expect(result.committed_paths).toEqual(["docs/a.md"]);
    await expect(headSha(fixture.root)).resolves.toBe(result.head_after);
  });

  test("actual commit can use global identity from HOME when repo identity is not local", async () => {
    const fixture = await createGitFixtureWithoutLocalIdentity();
    const home = await mkdtemp(join(tmpdir(), "repo-reader-git-home-"));
    await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Global Test User\n\temail = global@example.com\n");
    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const service = createService(fixture.root);
      await git(fixture.root, ["add", "--", "docs/a.md"]);

      const result = await service.commit({
        message: "Update docs a",
        expected_head_sha: fixture.head,
        expected_staged_paths: ["docs/a.md"]
      });

      expect(result.commit_sha).toMatch(/^[a-f0-9]{40}$/);
      await expect(git(fixture.root, ["log", "-1", "--format=%an <%ae>"])).resolves.toBe("Global Test User <global@example.com>\n");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("commit rejects stale expected_head_sha", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    await expect(service.commit({
      message: "Update docs a",
      expected_head_sha: "0".repeat(40),
      expected_staged_paths: ["docs/a.md"]
    })).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
  });

  test("commit rejects empty expected_staged_paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.commit({
      message: "Update docs a",
      expected_head_sha: fixture.head,
      expected_staged_paths: []
    })).rejects.toMatchObject({ code: "GIT_OPERATION_PATHS_REQUIRED" });
  });

  test("commit rejects when actual staged paths differ from expected_staged_paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    await expect(service.commit({
      message: "Update docs a",
      expected_head_sha: fixture.head,
      expected_staged_paths: ["docs/a.md", "docs/b.md"]
    })).rejects.toMatchObject({ code: "GIT_STAGED_PATHS_MISMATCH" });
  });

  test("commit rejects unreviewed staged secret candidates", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", ".env"]);

    await expect(service.commit({
      message: "Add env",
      expected_head_sha: fixture.head,
      expected_staged_paths: [".env"]
    })).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
  });

  test("dry_run stageCommit validates paths message and head without changing index or HEAD", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    const result = await service.stageCommit({
      paths: ["docs/a.md"],
      message: "Update docs a",
      expected_head_sha: fixture.head,
      dry_run: true
    });

    expect(result).toEqual({
      ok: true,
      dry_run: true,
      head_before: fixture.head,
      staged_paths: ["docs/a.md"],
      committed_paths: ["docs/a.md"],
      warnings: []
    });
    await expect(stagedPaths(fixture.root)).resolves.toEqual([]);
    await expect(headSha(fixture.root)).resolves.toBe(fixture.head);
  });

  test("actual stageCommit stages explicit file and creates local commit", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    const result = await service.stageCommit({
      paths: ["docs/a.md"],
      message: "Update docs a",
      expected_head_sha: fixture.head
    });

    expect(result.dry_run).toBe(false);
    expect(result.head_before).toBe(fixture.head);
    expect(result.head_after).toMatch(/^[a-f0-9]{40}$/);
    expect(result.commit_sha).toBe(result.head_after);
    expect(result.staged_paths).toEqual(["docs/a.md"]);
    expect(result.committed_paths).toEqual(["docs/a.md"]);
    expect(result.clean_after).toBe(false);
    expect(result.remaining_changes).toBe(2);
    await expect(headSha(fixture.root)).resolves.toBe(result.head_after!);
    await expect(stagedPaths(fixture.root)).resolves.toEqual([]);
    await expect(worktreePaths(fixture.root)).resolves.toEqual(["docs/b.md"]);
  });

  test("stageCommit rejects stale expected_head_sha", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.stageCommit({
      paths: ["docs/a.md"],
      message: "Update docs a",
      expected_head_sha: "0".repeat(40)
    })).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
  });

  test("stageCommit rejects unsafe paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.stageCommit({ paths: ["."], message: "Update docs", expected_head_sha: fixture.head })).rejects.toMatchObject({ code: "GIT_OPERATION_UNSAFE_PATHSPEC" });
    await expect(service.stageCommit({ paths: ["*"], message: "Update docs", expected_head_sha: fixture.head })).rejects.toMatchObject({ code: "GIT_OPERATION_UNSAFE_PATHSPEC" });
    await expect(service.stageCommit({ paths: ["-A"], message: "Update docs", expected_head_sha: fixture.head })).rejects.toMatchObject({ code: "GIT_OPERATION_UNSAFE_PATHSPEC" });
    await expect(service.stageCommit({ paths: ["--all"], message: "Update docs", expected_head_sha: fixture.head })).rejects.toMatchObject({ code: "GIT_OPERATION_UNSAFE_PATHSPEC" });
    await expect(service.stageCommit({ paths: [join(fixture.root, "docs", "a.md")], message: "Update docs", expected_head_sha: fixture.head })).rejects.toMatchObject({ code: "ABSOLUTE_PATH_REJECTED" });
    await expect(service.stageCommit({ paths: ["../outside.md"], message: "Update docs", expected_head_sha: fixture.head })).rejects.toMatchObject({ code: "PATH_TRAVERSAL_REJECTED" });
    await expect(service.stageCommit({ paths: [".git/config"], message: "Update docs", expected_head_sha: fixture.head })).rejects.toMatchObject({ code: "GIT_OPERATION_UNSAFE_PATHSPEC" });
    await expect(service.stageCommit({ paths: [".env"], message: "Update docs", expected_head_sha: fixture.head })).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
  });

  test("stageCommit rejects invalid commit message", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);

    await expect(service.stageCommit({
      paths: ["docs/a.md"],
      message: "Update docs && git push",
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({ code: "GIT_COMMIT_MESSAGE_INVALID" });
  });

  test("stageCommit rejects when pre-existing staged paths differ from requested paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", "docs/b.md"]);

    await expect(service.stageCommit({
      paths: ["docs/a.md"],
      message: "Update docs a",
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({
      code: "GIT_STAGED_PATHS_MISMATCH",
      diagnostics: {
        actual_paths: ["docs/b.md"],
        expected_paths: ["docs/a.md"]
      }
    });
  });

  test("stageCommit allows pre-existing staged paths when they exactly match requested paths", async () => {
    const fixture = await createGitFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await service.stageCommit({
      paths: ["docs/a.md"],
      message: "Update docs a",
      expected_head_sha: fixture.head
    });

    expect(result.committed_paths).toEqual(["docs/a.md"]);
    expect(result.commit_sha).toMatch(/^[a-f0-9]{40}$/);
  });

  test("stageCommit does not push or mutate remote state", async () => {
    const fixture = await createGitFixture();
    const remote = await mkdtemp(join(tmpdir(), "repo-reader-git-remote-"));
    await git(remote, ["init", "--bare"]);
    await git(fixture.root, ["remote", "add", "origin", remote]);
    const remoteBefore = await git(fixture.root, ["ls-remote", "origin", "HEAD"]);
    const service = createService(fixture.root);

    await service.stageCommit({
      paths: ["docs/a.md"],
      message: "Update docs a",
      expected_head_sha: fixture.head
    });

    await expect(git(fixture.root, ["ls-remote", "origin", "HEAD"])).resolves.toBe(remoteBefore);
  });

  test("dry_run recover with restore_paths validates without modifying file", async () => {
    const fixture = await createRecoverFixture();
    const service = createService(fixture.root);

    const result = await service.recover({
      restore_paths: ["docs/a.md"],
      expected_head_sha: fixture.head,
      dry_run: true
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      head_sha: fixture.head,
      unstaged_paths: [],
      restored_paths: ["docs/a.md"],
      deleted: [],
      skipped: [],
      warnings: []
    });
    await expect(readFile(join(fixture.root, "docs", "a.md"), "utf8")).resolves.toBe("A changed\n");
    await expect(worktreePaths(fixture.root)).resolves.toEqual(["docs/a.md"]);
  });

  test("actual recover restores tracked worktree path", async () => {
    const fixture = await createRecoverFixture();
    const service = createService(fixture.root);

    const result = await service.recover({
      restore_paths: ["docs/a.md"],
      expected_head_sha: fixture.head
    });

    expect(result.restored_paths).toEqual(["docs/a.md"]);
    expect(result.clean_after).toBe(true);
    expect(result.remaining_changes).toBe(0);
    await expect(readFile(join(fixture.root, "docs", "a.md"), "utf8")).resolves.toBe("A\n");
    await expect(stagedPaths(fixture.root)).resolves.toEqual([]);
    await expect(worktreePaths(fixture.root)).resolves.toEqual([]);
  });

  test("actual recover unstages and restores staged path", async () => {
    const fixture = await createRecoverFixture();
    const service = createService(fixture.root);
    await git(fixture.root, ["add", "--", "docs/a.md"]);

    const result = await service.recover({
      unstage_paths: ["docs/a.md"],
      restore_paths: ["docs/a.md"],
      expected_head_sha: fixture.head
    });

    expect(result.unstaged_paths).toEqual(["docs/a.md"]);
    expect(result.restored_paths).toEqual(["docs/a.md"]);
    expect(result.clean_after).toBe(true);
    await expect(readFile(join(fixture.root, "docs", "a.md"), "utf8")).resolves.toBe("A\n");
    await expect(stagedPaths(fixture.root)).resolves.toEqual([]);
    await expect(worktreePaths(fixture.root)).resolves.toEqual([]);
  });

  test("actual recover cleans up allowed generated artifact", async () => {
    const fixture = await createRecoverFixture({ changedPath: undefined, cleanupArtifact: true });
    const service = createService(fixture.root);

    const result = await service.recover({
      cleanup_paths: [".chatgpt/tool-tests/recover.txt"],
      expected_head_sha: fixture.head
    });

    expect(result.deleted).toEqual([{ path: ".chatgpt/tool-tests/recover.txt", type: "file" }]);
    expect(result.clean_after).toBe(true);
    await expect(access(join(fixture.root, ".chatgpt", "tool-tests", "recover.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("actual recover handles staged, unstaged, and cleanup paths in one call", async () => {
    const fixture = await createRecoverFixture({ changedPath: "docs/a.md", cleanupArtifact: true });
    const service = createService(fixture.root);
    await writeFile(join(fixture.root, "docs", "b.md"), "B changed\n");
    await git(fixture.root, ["add", "--", "docs/b.md"]);

    const result = await service.recover({
      unstage_paths: ["docs/b.md"],
      restore_paths: ["docs/a.md", "docs/b.md"],
      cleanup_paths: [".chatgpt/tool-tests/recover.txt"],
      expected_head_sha: fixture.head
    });

    expect(result.unstaged_paths).toEqual(["docs/b.md"]);
    expect(result.restored_paths).toEqual(["docs/a.md", "docs/b.md"]);
    expect(result.deleted).toEqual([{ path: ".chatgpt/tool-tests/recover.txt", type: "file" }]);
    expect(result.clean_after).toBe(true);
    expect(result.remaining_changes).toBe(0);
    await expect(stagedPaths(fixture.root)).resolves.toEqual([]);
    await expect(worktreePaths(fixture.root)).resolves.toEqual([]);
  });

  test("recover rejects duplicate paths across mutating phases before changing anything", async () => {
    const fixture = await createRecoverFixture({ changedPath: "docs/a.md", cleanupArtifact: true });
    const service = createService(fixture.root);
    await writeFile(join(fixture.root, "docs", "b.md"), "B changed\n");
    await git(fixture.root, ["add", "--", "docs/b.md"]);

    await expect(service.recover({
      unstage_paths: ["docs/b.md"],
      restore_paths: ["docs/a.md"],
      cleanup_paths: [".chatgpt/tool-tests/recover.txt"],
      discard_paths: [".chatgpt/tool-tests/recover.txt"],
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({
      code: "GIT_OPERATION_UNSAFE_PATHSPEC",
      diagnostics: { failed_path: ".chatgpt/tool-tests/recover.txt" }
    });

    await expect(stagedPaths(fixture.root)).resolves.toEqual(["docs/b.md"]);
    await expect(readFile(join(fixture.root, "docs", "a.md"), "utf8")).resolves.toBe("A changed\n");
    await expect(readFile(join(fixture.root, ".chatgpt", "tool-tests", "recover.txt"), "utf8")).resolves.toBe("temporary\n");
  });

  test("recover rejects stale expected_head_sha", async () => {
    const fixture = await createRecoverFixture();
    const service = createService(fixture.root);

    await expect(service.recover({
      restore_paths: ["docs/a.md"],
      expected_head_sha: "0".repeat(40)
    })).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
  });

  test("recover rejects unsafe restore and unstage paths", async () => {
    const fixture = await createRecoverFixture();
    const service = createService(fixture.root);

    for (const path of [".", "*", "-A", "--all", ".git/config", ".env"]) {
      const expectedCode = path === ".env" ? "SECRET_CANDIDATE_BLOCKED" : "GIT_OPERATION_UNSAFE_PATHSPEC";
      await expect(service.recover({ restore_paths: [path], expected_head_sha: fixture.head })).rejects.toMatchObject({
        code: expectedCode
      });
      await expect(service.recover({ unstage_paths: [path], expected_head_sha: fixture.head })).rejects.toMatchObject({
        code: expectedCode
      });
    }
    await expect(service.recover({ restore_paths: [join(fixture.root, "docs", "a.md")], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "ABSOLUTE_PATH_REJECTED"
    });
    await expect(service.recover({ restore_paths: ["../outside.md"], expected_head_sha: fixture.head })).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_REJECTED"
    });
  });

  test("recover rejects cleanup path not allowed by cleanup policy", async () => {
    const fixture = await createRecoverFixture({ changedPath: undefined });
    const service = createService(fixture.root);

    await expect(service.recover({
      cleanup_paths: ["docs/a.md"],
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({ code: "CLEANUP_NOT_ALLOWED_GLOB" });
  });

  test("dry_run recover does not mutate index worktree or filesystem", async () => {
    const fixture = await createRecoverFixture({ changedPath: "docs/a.md", cleanupArtifact: true });
    const service = createService(fixture.root);
    await writeFile(join(fixture.root, "docs", "b.md"), "B changed\n");
    await git(fixture.root, ["add", "--", "docs/b.md"]);

    await service.recover({
      unstage_paths: ["docs/b.md"],
      restore_paths: ["docs/a.md"],
      cleanup_paths: [".chatgpt/tool-tests/recover.txt"],
      expected_head_sha: fixture.head,
      dry_run: true
    });

    await expect(stagedPaths(fixture.root)).resolves.toEqual(["docs/b.md"]);
    await expect(readFile(join(fixture.root, "docs", "a.md"), "utf8")).resolves.toBe("A changed\n");
    await expect(readFile(join(fixture.root, ".chatgpt", "tool-tests", "recover.txt"), "utf8")).resolves.toBe("temporary\n");
  });

  test("recover requires at least one explicit recovery path", async () => {
    const fixture = await createRecoverFixture();
    const service = createService(fixture.root);

    await expect(service.recover({
      expected_head_sha: fixture.head
    })).rejects.toMatchObject({ code: "GIT_OPERATION_PATHS_REQUIRED" });
  });
});

function createService(root: string) {
  return new GitOperationsService(root, new OperationsPolicy({
    enabled: true,
    git_stage_enabled: true,
    git_commit_enabled: true,
    cleanup_enabled: true,
    cleanup_allowed_globs: [".chatgpt/tool-tests/**"],
    max_paths_per_operation: 50
  }));
}

async function createGitFixture(): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "repo-reader-git-ops-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "a.md"), "A\n");
  await writeFile(join(root, "docs", "b.md"), "B\n");
  await writeFile(join(root, ".env"), "TOKEN=value\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["add", "--", "docs/a.md", "docs/b.md"]);
  await git(root, ["commit", "-m", "initial"]);
  const head = await headSha(root);
  await writeFile(join(root, "docs", "a.md"), "A changed\n");
  await writeFile(join(root, "docs", "b.md"), "B changed\n");
  return { root, head };
}

async function createGitFixtureWithoutLocalIdentity(): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "repo-reader-git-ops-no-identity-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "a.md"), "A\n");
  await git(root, ["init"]);
  await git(root, ["add", "--", "docs/a.md"]);
  await git(root, ["-c", "user.name=Initial User", "-c", "user.email=initial@example.com", "commit", "-m", "initial"]);
  const head = await headSha(root);
  await writeFile(join(root, "docs", "a.md"), "A changed\n");
  return { root, head };
}

async function createRecoverFixture(options: { changedPath?: "docs/a.md" | undefined; cleanupArtifact?: boolean } = { changedPath: "docs/a.md" }): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(join(tmpdir(), "repo-reader-git-recover-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, ".chatgpt", "tool-tests"), { recursive: true });
  await writeFile(join(root, "docs", "a.md"), "A\n");
  await writeFile(join(root, "docs", "b.md"), "B\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["add", "--", "docs/a.md", "docs/b.md"]);
  await git(root, ["commit", "-m", "initial"]);
  const head = await headSha(root);
  if (options.changedPath) {
    await writeFile(join(root, options.changedPath), options.changedPath === "docs/a.md" ? "A changed\n" : "B changed\n");
  }
  if (options.cleanupArtifact) {
    await writeFile(join(root, ".chatgpt", "tool-tests", "recover.txt"), "temporary\n");
  }
  return { root, head };
}

async function stagedPaths(root: string): Promise<string[]> {
  const output = await git(root, ["diff", "--name-only", "--cached"]);
  return output.split("\n").filter(Boolean).sort();
}

async function worktreePaths(root: string): Promise<string[]> {
  const output = await git(root, ["diff", "--name-only"]);
  return output.split("\n").filter(Boolean).sort();
}

async function headSha(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" }
  });
  return result.stdout;
}
