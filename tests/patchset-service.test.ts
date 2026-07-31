import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { PatchsetService } from "../src/services/patchset-service.js";
import { OperationsPolicy } from "../src/services/operations-policy.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

const execFileAsync = promisify(execFile);

describe("PatchsetService", () => {
  test("prepares create and full-file modify manifest without touching target files", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    const result = await service.prepare({
      repo_id: "fixture",
      intent: "Update docs and app",
      base_head_sha: "a".repeat(40),
      files: [
        {
          path: "docs/new.md",
          operation: "create",
          content: "New docs\n",
          expected_missing: true
        },
        {
          path: "src/app.ts",
          operation: "modify",
          content: "export function safeFetch() {\n  return fetch('/api/accounts');\n}\n",
          expected_old_sha256: sha256("export function rawFetch() {\n  return fetch('/api/users');\n}\n")
        }
      ]
    });

    expect(result).toMatchObject({
      ok: true,
      patchset_id: expect.stringMatching(/^patchset-/),
      manifest_path: expect.stringMatching(/^\.chatgpt\/patchsets\/patchset-.*\/manifest\.json$/),
      affected_paths: ["docs/new.md", "src/app.ts"],
      warnings: [],
      next_tool_payloads: {
        repo_apply_patchset: {
          repo_id: "fixture",
          patchset_id: result.patchset_id,
          expected_head_sha: "a".repeat(40)
        }
      }
    });
    expect(result.manifest.counts).toEqual({ files: 2, creates: 1, modifies: 1, deletes: 0, renames: 0, edits: 0 });
    expect(result.manifest.files.map((file) => file.new_sha256)).toEqual([
      sha256("New docs\n"),
      sha256("export function safeFetch() {\n  return fetch('/api/accounts');\n}\n")
    ]);

    await expect(access(join(fixture.root, "docs", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("rawFetch");
    await expect(readFile(join(fixture.root, result.manifest_path), "utf8")).resolves.toContain(result.patchset_id);
  });

  test("prepare rejects duplicate paths", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    await expect(service.prepare({
      repo_id: "fixture",
      intent: "Duplicate",
      files: [
        { path: "docs/a.md", operation: "create", content: "A\n", expected_missing: true },
        { path: "docs/a.md", operation: "create", content: "B\n", expected_missing: true }
      ]
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      diagnostics: { failed_path: "docs/a.md" }
    });
  });

  test("apply rejects stale patchset before writing any files", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Stale apply",
      files: [
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true },
        { path: "src/app.ts", operation: "modify", content: "changed\n", expected_old_sha256: "0".repeat(64) }
      ]
    });

    await expect(service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id
    })).rejects.toMatchObject({
      code: "WRITE_STALE_EXPECTED_SHA",
      diagnostics: {
        failed_path: "src/app.ts",
        expected_old_sha256: "0".repeat(64)
      }
    });

    await expect(access(join(fixture.root, "docs", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("rawFetch");
  });

  test("apply rejects a stale actual Git HEAD before writing target files", async () => {
    const fixture = await createRepoFixture();
    const expectedHead = await initGitRepo(fixture.root);
    const service = createService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Actual HEAD guard",
      base_head_sha: expectedHead,
      files: [
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true }
      ]
    });

    await writeFile(join(fixture.root, "docs", "guide.md"), "advanced\n", "utf8");
    await execFileAsync("git", ["add", "--", "docs/guide.md"], { cwd: fixture.root });
    await execFileAsync("git", ["commit", "-m", "advance head"], { cwd: fixture.root });

    await expect(service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: expectedHead
    })).rejects.toMatchObject({
      code: "GIT_HEAD_MISMATCH",
      diagnostics: { expected_head_sha: expectedHead }
    });
    await expect(access(join(fixture.root, "docs", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("apply writes all files and records patchset ledger metadata", async () => {
    const fixture = await createRepoFixture();
    const head = await initGitRepo(fixture.root);
    const service = createService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Apply patchset",
      base_head_sha: head,
      files: [
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true },
        {
          path: "src/app.ts",
          operation: "modify",
          content: "export function safeFetch() {\n  return fetch('/api/accounts');\n}\n",
          expected_old_sha256: sha256("export function rawFetch() {\n  return fetch('/api/users');\n}\n")
        }
      ]
    });

    const result = await service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      patchset_id: prepared.patchset_id,
      operation_id: expect.stringMatching(/^write-/),
      changed_paths: ["docs/new.md", "src/app.ts"],
      created_paths: ["docs/new.md"],
      modified_paths: ["src/app.ts"],
      counts: { files: 2, changed: 2, created: 1, modified: 1 },
      rollback_hint: {
        executable: true,
        reason: expect.stringContaining("repo_rollback_patchset")
      },
      operation_receipt: {
        path: ".chatgpt/operations/last-write.json",
        ledger_path: ".chatgpt/operations/ledger.jsonl"
      },
      next_tool_payloads: {
        repo_review_patchset: { repo_id: "fixture", patchset_id: prepared.patchset_id },
        repo_rollback_patchset: {
          repo_id: "fixture",
          patchset_id: prepared.patchset_id,
          expected_head_sha: head
        }
      }
    });
    await expect(readFile(join(fixture.root, "docs", "new.md"), "utf8")).resolves.toBe("New\n");
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("safeFetch");

    const ledger = await readFile(join(fixture.root, ".chatgpt", "operations", "ledger.jsonl"), "utf8");
    const entries = ledger.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tool: "repo_apply_patchset",
      event_type: "write_applied",
      patchset_id: prepared.patchset_id,
      operation_id: result.operation_id,
      changed_paths: ["docs/new.md", "src/app.ts"]
    });
    const receipt = JSON.parse(
      await readFile(join(fixture.root, ".chatgpt", "operations", "last-write.json"), "utf8")
    );
    expect(receipt.rollback_hint.executable).toBe(true);
  });

  test("apply without a bound HEAD keeps rollback guidance accurate but does not invent a rollback payload", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Apply without head",
      files: [
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true }
      ]
    });

    const result = await service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id
    });

    expect(result.rollback_hint).toMatchObject({
      executable: false,
      reason: expect.stringContaining("requires an expected Git HEAD")
    });
    expect(result.next_tool_payloads).toEqual({
      repo_review_patchset: { repo_id: "fixture", patchset_id: prepared.patchset_id }
    });
  });

  test("apply does not advertise rollback when its ledger entry cannot be recorded", async () => {
    const fixture = await createRepoFixture();
    const head = await initGitRepo(fixture.root);
    const service = createRollbackService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Apply without durable rollback state",
      base_head_sha: head,
      files: [
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true }
      ]
    });
    await mkdir(join(fixture.root, ".chatgpt", "operations", "ledger.jsonl"), { recursive: true });

    const result = await service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    });

    expect(result.warnings).toContain("OPERATION_LEDGER_APPEND_FAILED");
    expect(result.rollback_hint).toMatchObject({
      executable: false,
      reason: expect.stringContaining("ledger")
    });
    expect(result.operation_receipt).not.toHaveProperty("ledger_path");
    expect(result.next_tool_payloads).toEqual({
      repo_review_patchset: { repo_id: "fixture", patchset_id: prepared.patchset_id }
    });
    const receipt = JSON.parse(
      await readFile(join(fixture.root, ".chatgpt", "operations", "last-write.json"), "utf8")
    );
    expect(receipt.rollback_hint.executable).toBe(false);
    await expect(service.rollback({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head,
      dry_run: true
    })).rejects.toMatchObject({ code: "PATCHSET_NOT_APPLIED" });
  });

  test("apply restores already written files after an unexpected write failure", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const originalGuide = "# Guide\nSearchable docs\n";
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Rollback failed apply",
      files: [
        {
          path: "docs/guide.md",
          operation: "modify",
          content: "# Changed\n",
          expected_old_sha256: sha256(originalGuide)
        },
        {
          path: "src/app.ts",
          operation: "modify",
          content: "changed\n",
          expected_old_sha256: sha256("export function rawFetch() {\n  return fetch('/api/users');\n}\n")
        }
      ]
    });

    await chmod(join(fixture.root, "src"), 0o555);
    try {
      await expect(service.apply({
        repo_id: "fixture",
        patchset_id: prepared.patchset_id
      })).rejects.toBeTruthy();
    } finally {
      await chmod(join(fixture.root, "src"), 0o755);
    }

    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe(originalGuide);
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("rawFetch");
  });

  test("rollback dry run reports patchset restore and delete actions without mutating", async () => {
    const fixture = await createRepoFixture();
    const head = await initGitRepo(fixture.root);
    const service = createRollbackService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Rollback preview",
      base_head_sha: head,
      files: [
        {
          path: "docs/guide.md",
          operation: "modify",
          content: "# Changed\n",
          expected_old_sha256: sha256("# Guide\nSearchable docs\n")
        },
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true }
      ]
    });
    await service.apply({ repo_id: "fixture", patchset_id: prepared.patchset_id, expected_head_sha: head });

    const result = await service.rollback({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head,
      dry_run: true
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      patchset_id: prepared.patchset_id,
      restored_paths: ["docs/guide.md"],
      deleted_paths: ["docs/new.md"],
      counts: { restored: 1, deleted: 1, skipped: 0 },
      next_tool_payloads: {
        repo_review_patchset: { repo_id: "fixture", patchset_id: prepared.patchset_id }
      }
    });
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Changed\n");
    await expect(readFile(join(fixture.root, "docs", "new.md"), "utf8")).resolves.toBe("New\n");
  });

  test("rollback restores modified tracked files, deletes created untracked files, and records rollback ledger metadata", async () => {
    const fixture = await createRepoFixture();
    const head = await initGitRepo(fixture.root);
    const service = createRollbackService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Rollback actual",
      base_head_sha: head,
      files: [
        {
          path: "docs/guide.md",
          operation: "modify",
          content: "# Changed\n",
          expected_old_sha256: sha256("# Guide\nSearchable docs\n")
        },
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true }
      ]
    });
    await service.apply({ repo_id: "fixture", patchset_id: prepared.patchset_id, expected_head_sha: head });

    const result = await service.rollback({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      patchset_id: prepared.patchset_id,
      operation_id: expect.stringMatching(/^write-/),
      restored_paths: ["docs/guide.md"],
      deleted_paths: ["docs/new.md"],
      counts: { restored: 1, deleted: 1, skipped: 0 },
      operation_receipt: {
        path: ".chatgpt/operations/last-write.json",
        ledger_path: ".chatgpt/operations/ledger.jsonl"
      }
    });
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nSearchable docs\n");
    await expect(access(join(fixture.root, "docs", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const ledger = await readFile(join(fixture.root, ".chatgpt", "operations", "ledger.jsonl"), "utf8");
    const entries = ledger.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.event_type)).toEqual(["write_applied", "patchset_rolled_back"]);
    expect(entries[1]).toMatchObject({
      tool: "repo_rollback_patchset",
      patchset_id: prepared.patchset_id,
      changed_paths: ["docs/guide.md", "docs/new.md"]
    });
  });

  test("apply and rollback delete and rename patchset operations", async () => {
    const fixture = await createRepoFixture();
    const head = await initGitRepo(fixture.root);
    const service = createRollbackService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Delete docs and rename app",
      base_head_sha: head,
      files: [
        {
          path: "docs/guide.md",
          operation: "delete",
          expected_old_sha256: sha256("# Guide\nSearchable docs\n")
        },
        {
          path: "src/app.ts",
          operation: "rename",
          new_path: "src/app-renamed.ts",
          expected_old_sha256: sha256("export function rawFetch() {\n  return fetch('/api/users');\n}\n")
        }
      ]
    });

    expect(prepared.manifest.counts).toEqual({ files: 2, creates: 0, modifies: 0, deletes: 1, renames: 1, edits: 0 });
    expect(prepared.affected_paths).toEqual(["docs/guide.md", "src/app.ts", "src/app-renamed.ts"]);

    const applied = await service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    });

    expect(applied).toMatchObject({
      ok: true,
      dry_run: false,
      changed_paths: ["docs/guide.md", "src/app.ts", "src/app-renamed.ts"],
      deleted_paths: ["docs/guide.md"],
      renamed_paths: [{ from: "src/app.ts", to: "src/app-renamed.ts" }],
      counts: { files: 2, changed: 2, created: 0, modified: 0, deleted: 1, renamed: 1 }
    });
    await expect(access(join(fixture.root, "docs", "guide.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(fixture.root, "src", "app.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.root, "src", "app-renamed.ts"), "utf8")).resolves.toContain("rawFetch");

    const rolledBack = await service.rollback({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    });

    expect(rolledBack).toMatchObject({
      ok: true,
      patchset_id: prepared.patchset_id,
      restored_paths: ["docs/guide.md", "src/app.ts"],
      deleted_paths: ["src/app-renamed.ts"],
      counts: { restored: 2, deleted: 1, skipped: 0 }
    });
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nSearchable docs\n");
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("rawFetch");
    await expect(access(join(fixture.root, "src", "app-renamed.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("apply and rollback structured edit hunks", async () => {
    const fixture = await createRepoFixture();
    const head = await initGitRepo(fixture.root);
    const service = createRollbackService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Patch app with hunks",
      base_head_sha: head,
      files: [
        {
          path: "src/app.ts",
          operation: "edit",
          expected_old_sha256: sha256("export function rawFetch() {\n  return fetch('/api/users');\n}\n"),
          hunks: [
            { find: "rawFetch", replace: "safeFetch" },
            { find: "/api/users", replace: "/api/accounts" }
          ]
        }
      ]
    });

    expect(prepared.manifest.counts).toEqual({ files: 1, creates: 0, modifies: 0, deletes: 0, renames: 0, edits: 1 });
    expect(prepared.manifest.files[0]).toMatchObject({
      path: "src/app.ts",
      operation: "edit",
      hunk_count: 2
    });

    const applied = await service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    });

    expect(applied).toMatchObject({
      ok: true,
      dry_run: false,
      changed_paths: ["src/app.ts"],
      modified_paths: ["src/app.ts"],
      counts: { files: 1, changed: 1, created: 0, modified: 1, deleted: 0, renamed: 0, edited: 1 },
      hunk_diagnostics: [
        { path: "src/app.ts", hunk_index: 0, status: "matched", occurrences: 1 },
        { path: "src/app.ts", hunk_index: 1, status: "matched", occurrences: 1 }
      ]
    });
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toBe(
      "export function safeFetch() {\n  return fetch('/api/accounts');\n}\n"
    );

    const rolledBack = await service.rollback({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    });

    expect(rolledBack).toMatchObject({
      ok: true,
      restored_paths: ["src/app.ts"],
      deleted_paths: [],
      counts: { restored: 1, deleted: 0, skipped: 0 }
    });
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("rawFetch");
  });

  test("apply reports per-hunk diagnostics before writing structured edit hunks", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Reject bad hunks",
      files: [
        {
          path: "src/app.ts",
          operation: "edit",
          expected_old_sha256: sha256("export function rawFetch() {\n  return fetch('/api/users');\n}\n"),
          hunks: [
            { find: "rawFetch", replace: "safeFetch" },
            { find: "doesNotExist", replace: "unused" }
          ]
        },
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true }
      ]
    });

    await expect(service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id
    })).rejects.toMatchObject({
      code: "PATCHSET_HUNK_VALIDATION_FAILED",
      diagnostics: {
        failed_path: "src/app.ts",
        hunk_index: 1,
        hunks: [
          { path: "src/app.ts", hunk_index: 0, status: "matched", occurrences: 1 },
          { path: "src/app.ts", hunk_index: 1, status: "not_found", occurrences: 0 }
        ]
      }
    });

    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("rawFetch");
    await expect(access(join(fixture.root, "docs", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("apply rejects delete of untracked paths", async () => {
    const fixture = await createRepoFixture();
    const head = await initGitRepo(fixture.root);
    const service = createRollbackService(fixture.root);
    await writeFile(join(fixture.root, "docs", "scratch.md"), "Scratch\n");
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Delete scratch",
      base_head_sha: head,
      files: [
        { path: "docs/scratch.md", operation: "delete", expected_old_sha256: sha256("Scratch\n") }
      ]
    });

    await expect(service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      diagnostics: { failed_path: "docs/scratch.md" }
    });
    await expect(readFile(join(fixture.root, "docs", "scratch.md"), "utf8")).resolves.toBe("Scratch\n");
  });

  test("apply rejects rename of untracked paths", async () => {
    const fixture = await createRepoFixture();
    const head = await initGitRepo(fixture.root);
    const service = createRollbackService(fixture.root);
    await writeFile(join(fixture.root, "src", "scratch.ts"), "export const scratch = true;\n");
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Rename scratch",
      base_head_sha: head,
      files: [
        {
          path: "src/scratch.ts",
          operation: "rename",
          new_path: "src/scratch-renamed.ts",
          expected_old_sha256: sha256("export const scratch = true;\n")
        }
      ]
    });

    await expect(service.apply({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      diagnostics: { failed_path: "src/scratch.ts" }
    });
    await expect(readFile(join(fixture.root, "src", "scratch.ts"), "utf8")).resolves.toBe("export const scratch = true;\n");
    await expect(access(join(fixture.root, "src", "scratch-renamed.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rollback rejects drifted patchset paths before mutating", async () => {
    const fixture = await createRepoFixture();
    const head = await initGitRepo(fixture.root);
    const service = createRollbackService(fixture.root);
    const prepared = await service.prepare({
      repo_id: "fixture",
      intent: "Rollback drift",
      base_head_sha: head,
      files: [
        {
          path: "docs/guide.md",
          operation: "modify",
          content: "# Changed\n",
          expected_old_sha256: sha256("# Guide\nSearchable docs\n")
        },
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true }
      ]
    });
    await service.apply({ repo_id: "fixture", patchset_id: prepared.patchset_id, expected_head_sha: head });
    await execFileAsync("node", ["-e", "require('fs').writeFileSync('docs/new.md', 'Drift\\n')"], { cwd: fixture.root });

    await expect(service.rollback({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    })).rejects.toMatchObject({
      code: "PATCHSET_ROLLBACK_DRIFT",
      diagnostics: { failed_path: "docs/new.md" }
    });

    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Changed\n");
    await expect(readFile(join(fixture.root, "docs", "new.md"), "utf8")).resolves.toBe("Drift\n");
  });
});

function createService(root: string): PatchsetService {
  return new PatchsetService(root, new PathSandbox(root), new WritePolicy({
    enabled: true,
    allowed_globs: ["docs/**", "src/**"]
  }));
}

function createRollbackService(root: string): PatchsetService {
  return new PatchsetService(
    root,
    new PathSandbox(root),
    new WritePolicy({
      enabled: true,
      allowed_globs: ["docs/**", "src/**"]
    }),
    new OperationsPolicy({
      enabled: true,
      git_stage_enabled: true,
      git_commit_enabled: true,
      cleanup_enabled: true
    })
  );
}

async function initGitRepo(root: string): Promise<string> {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "fixture@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await execFileAsync("git", ["add", "--", "docs/guide.md", "src/app.ts"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
