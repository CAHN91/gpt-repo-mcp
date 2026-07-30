import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { RootRegistry } from "../src/services/root-registry.js";
import type { OperationLedgerEntry, OperationReceipt } from "../src/contracts/operation-receipt.contract.js";
import type { WriteChangesResult, WriteFileResult } from "../src/contracts/write.contract.js";
import { writeChangesHandler, writeFileHandler } from "../src/tools/handlers.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

const execFileAsync = promisify(execFile);

async function createContext() {
  const fixture = await createRepoFixture();
  const registry = await RootRegistry.fromConfig({
    repos: [
      {
        repo_id: "fixture",
        display_name: "Fixture",
        root: fixture.root,
        writes: { enabled: true, allowed_globs: ["docs/**", "src/**"] }
      }
    ],
    limits: {}
  });
  return { fixture, context: { registry } };
}

describe("write handlers operation receipts", () => {
  test("repo_write_file records per-file metadata and rollback hints in receipt and ledger", async () => {
    const { fixture, context } = await createContext();

    const writeResult = await writeFileHandler({
      repo_id: "fixture",
      path: "docs/new.md",
      content: "New docs\n"
    }, context);

    expect((writeResult.structuredContent as WriteFileResult).operation_receipt).toMatchObject({
      path: ".chatgpt/operations/last-write.json",
      ledger_path: ".chatgpt/operations/ledger.jsonl"
    });
    const receipt = await readJson<OperationReceipt>(fixture.root, ".chatgpt/operations/last-write.json");
    expect(receipt.files).toEqual([
      expect.objectContaining({
        path: "docs/new.md",
        action: "write",
        changed: true,
        created: true,
        new_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]);
    expect(receipt.rollback_hint).toEqual({
      executable: false,
      reason: "First-class rollback is not implemented yet; use reviewed git restore or cleanup workflows.",
      paths: [
        {
          path: "docs/new.md",
          strategy: "cleanup_created",
          reason: "Created path can be removed through reviewed cleanup workflow."
        }
      ]
    });

    const entries = await readLedger(fixture.root);
    expect(entries).toHaveLength(1);
    expect(entries[0].files).toEqual(receipt.files);
    expect(entries[0].rollback_hint).toEqual(receipt.rollback_hint);
  });

  test("repo_write_changes records metadata for created and modified files", async () => {
    const { fixture, context } = await createContext();

    const writeResult = await writeChangesHandler({
      repo_id: "fixture",
      changes: [
        { type: "write", path: "docs/new.md", content: "New docs\n" },
        { type: "replace", path: "src/app.ts", find: "rawFetch", replace: "safeFetch" }
      ]
    }, context);

    expect((writeResult.structuredContent as WriteChangesResult).operation_receipt).toMatchObject({
      path: ".chatgpt/operations/last-write.json",
      ledger_path: ".chatgpt/operations/ledger.jsonl"
    });
    const receipt = await readJson<OperationReceipt>(fixture.root, ".chatgpt/operations/last-write.json");
    expect(receipt.files).toEqual([
      expect.objectContaining({
        path: "docs/new.md",
        action: "write",
        changed: true,
        created: true,
        new_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }),
      expect.objectContaining({
        path: "src/app.ts",
        action: "replace",
        changed: true,
        created: false,
        old_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        new_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]);
    expect(receipt.rollback_hint?.paths).toEqual([
      {
        path: "docs/new.md",
        strategy: "cleanup_created",
        reason: "Created path can be removed through reviewed cleanup workflow."
      },
      {
        path: "src/app.ts",
        strategy: "restore_tracked",
        reason: "Modified tracked path can be restored through reviewed git restore workflow."
      }
    ]);

    const entries = await readLedger(fixture.root);
    expect(entries).toHaveLength(1);
    expect(entries[0].files).toEqual(receipt.files);
    expect(entries[0].rollback_hint).toEqual(receipt.rollback_hint);
  });

  test("dry-run writes do not create operation receipt or ledger artifacts", async () => {
    const { fixture, context } = await createContext();

    await writeFileHandler({
      repo_id: "fixture",
      path: "docs/dry.md",
      content: "Dry docs\n",
      dry_run: true
    }, context);

    await expectNoOperationArtifacts(fixture.root);
  });

  test("no-op writes do not create operation receipt or ledger artifacts", async () => {
    const { fixture, context } = await createContext();

    await writeFileHandler({
      repo_id: "fixture",
      path: "docs/guide.md",
      content: "# Guide\nSearchable docs\n"
    }, context);

    await expectNoOperationArtifacts(fixture.root);
  });

  test("existing secrets are absent from write results, receipts, and ledger entries", async () => {
    const { fixture, context } = await createContext();
    const existingSecret = "OPENAI_API_KEY=sk-existingSecretValue123";
    await writeFile(join(fixture.root, "docs", "guide.md"), `${existingSecret}\nstatus=old\n`);

    const result = await writeFileHandler({
      repo_id: "fixture",
      path: "docs/guide.md",
      action: "replace",
      find: "status=old",
      replace: "status=new"
    }, context);

    const receipt = await readJson<OperationReceipt>(fixture.root, ".chatgpt/operations/last-write.json");
    const ledger = await readLedger(fixture.root);
    for (const value of [JSON.stringify(result), JSON.stringify(receipt), JSON.stringify(ledger)]) {
      expect(value).not.toContain(existingSecret);
    }

    const newSecret = "OPENAI_API_KEY=sk-newSecretValue123";
    const blocked = await writeFileHandler({
      repo_id: "fixture",
      path: "docs/guide.md",
      action: "replace",
      find: "status=new",
      replace: newSecret
    }, context);
    const blockedResult = JSON.stringify(blocked);
    expect(blocked.isError).toBe(true);
    expect(blockedResult).not.toContain(existingSecret);
    expect(blockedResult).not.toContain(newSecret);
  });

  test("repo_write_file rejects stale expected_head_sha before writing", async () => {
    const fixture = await createGitFixture();
    const registry = await RootRegistry.fromConfig({
      repos: [
        {
          repo_id: "fixture",
          display_name: "Fixture",
          root: fixture.root,
          writes: { enabled: true, allowed_globs: ["docs/**"] }
        }
      ],
      limits: {}
    });

    const result = await writeFileHandler({
      repo_id: "fixture",
      path: "docs/head.md",
      content: "Head\n",
      expected_head_sha: "0".repeat(40)
    }, { registry });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "GIT_HEAD_MISMATCH",
        diagnostics: {
          expected_head_sha: "0".repeat(40),
          head_sha: fixture.head
        }
      }
    });
    await expect(access(join(fixture.root, "docs", "head.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createGitFixture() {
  const fixture = await createRepoFixture();
  await execFileAsync("git", ["init"], { cwd: fixture.root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: fixture.root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: fixture.root });
  await execFileAsync("git", ["add", "."], { cwd: fixture.root });
  await execFileAsync("git", ["commit", "-m", "Initial"], { cwd: fixture.root });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.root });
  return { ...fixture, head: stdout.trim() };
}

async function readJson<T>(root: string, path: string): Promise<T> {
  return JSON.parse(await readFile(join(root, path), "utf8")) as T;
}

async function readLedger(root: string): Promise<OperationLedgerEntry[]> {
  const ledger = await readFile(join(root, ".chatgpt", "operations", "ledger.jsonl"), "utf8");
  return ledger.trim().split("\n").map((line) => JSON.parse(line) as OperationLedgerEntry);
}

async function expectNoOperationArtifacts(root: string): Promise<void> {
  await expect(access(join(root, ".chatgpt", "operations", "last-write.json"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  await expect(access(join(root, ".chatgpt", "operations", "ledger.jsonl"))).rejects.toMatchObject({
    code: "ENOENT"
  });
}
