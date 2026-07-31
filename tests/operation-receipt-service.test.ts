import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { OperationReceiptService } from "../src/services/operation-receipt-service.js";

describe("OperationReceiptService", () => {
  test("missing last write returns not found with warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    const result = await new OperationReceiptService(root).readLastWrite("fixture");

    expect(result).toEqual({
      ok: true,
      found: false,
      next_tool_payloads: {},
      warnings: ["NO_LAST_WRITE_RECEIPT"]
    });
  });

  test("writes and reads safe last write receipt metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    const service = new OperationReceiptService(root);

    const writeResult = await service.writeLastWrite({
      tool: "repo_write_changes",
      repo_id: "fixture",
      head_sha_before: "a".repeat(40),
      head_sha_after: "b".repeat(40),
      touched_paths: ["docs/a.md", "src/app.ts"],
      changed_paths: ["docs/a.md", "src/app.ts"],
      created_paths: ["docs/a.md"],
      modified_paths: ["src/app.ts"],
      counts: { requested: 2, changed: 2, created: 1, unchanged: 0 },
      summary: "Applied 2 changes across 2 files.",
      files: [
        {
          path: "docs/a.md",
          action: "write",
          changed: true,
          created: true,
          new_sha256: "c".repeat(64)
        },
        {
          path: "src/app.ts",
          action: "edit",
          changed: true,
          created: false,
          old_sha256: "d".repeat(64),
          new_sha256: "e".repeat(64)
        }
      ],
      rollback_hint: {
        executable: false,
        reason: "First-class rollback is not implemented yet; use reviewed git restore or cleanup workflows.",
        paths: [
          {
            path: "docs/a.md",
            strategy: "cleanup_created",
            reason: "Created path can be removed through reviewed cleanup workflow."
          },
          {
            path: "src/app.ts",
            strategy: "restore_tracked",
            reason: "Modified tracked path can be restored through reviewed git restore workflow."
          }
        ]
      }
    });

    expect(writeResult).toEqual({
      ok: true,
      operation_receipt: {
        operation_id: expect.stringMatching(/^write-/),
        path: ".chatgpt/operations/last-write.json",
        ledger_path: ".chatgpt/operations/ledger.jsonl"
      },
      warnings: []
    });

    const result = await service.readLastWrite("fixture");
    expect(result).toMatchObject({
      ok: true,
      found: true,
      receipt: {
        schema_version: 1,
        operation_id: writeResult.operation_receipt?.operation_id,
        tool: "repo_write_changes",
        repo_id: "fixture",
        touched_paths: ["docs/a.md", "src/app.ts"],
        changed_paths: ["docs/a.md", "src/app.ts"],
        created_paths: ["docs/a.md"],
        modified_paths: ["src/app.ts"],
        counts: { requested: 2, changed: 2, created: 1, unchanged: 0 },
        summary: "Applied 2 changes across 2 files."
      },
      next_tool_payloads: {
        repo_git_review: { repo_id: "fixture" }
      },
      warnings: []
    });

    expect(result.receipt?.files).toEqual([
      {
        path: "docs/a.md",
        action: "write",
        changed: true,
        created: true,
        new_sha256: "c".repeat(64)
      },
      {
        path: "src/app.ts",
        action: "edit",
        changed: true,
        created: false,
        old_sha256: "d".repeat(64),
        new_sha256: "e".repeat(64)
      }
    ]);
    expect(result.receipt?.rollback_hint).toEqual({
      executable: false,
      reason: "First-class rollback is not implemented yet; use reviewed git restore or cleanup workflows.",
      paths: [
        {
          path: "docs/a.md",
          strategy: "cleanup_created",
          reason: "Created path can be removed through reviewed cleanup workflow."
        },
        {
          path: "src/app.ts",
          strategy: "restore_tracked",
          reason: "Modified tracked path can be restored through reviewed git restore workflow."
        }
      ]
    });

    const serialized = await readFile(join(root, ".chatgpt", "operations", "last-write.json"), "utf8");
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("/tmp/");
    expect(serialized).not.toContain(root);
  });

  test("appends each write receipt to the operation ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    const service = new OperationReceiptService(root);

    await service.writeLastWrite({
      tool: "repo_write_file",
      repo_id: "fixture",
      touched_paths: ["docs/a.md"],
      changed_paths: ["docs/a.md"],
      created_paths: ["docs/a.md"],
      modified_paths: [],
      counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
      summary: "Created docs/a.md.",
      files: [
        {
          path: "docs/a.md",
          action: "write",
          changed: true,
          created: true,
          new_sha256: "a".repeat(64)
        }
      ],
      rollback_hint: {
        executable: false,
        reason: "First-class rollback is not implemented yet; use reviewed git restore or cleanup workflows.",
        paths: [
          {
            path: "docs/a.md",
            strategy: "cleanup_created",
            reason: "Created path can be removed through reviewed cleanup workflow."
          }
        ]
      }
    });

    await service.writeLastWrite({
      tool: "repo_write_file",
      repo_id: "fixture",
      touched_paths: ["docs/b.md"],
      changed_paths: ["docs/b.md"],
      created_paths: ["docs/b.md"],
      modified_paths: [],
      counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
      summary: "Created docs/b.md.",
      files: [
        {
          path: "docs/b.md",
          action: "write",
          changed: true,
          created: true,
          new_sha256: "b".repeat(64)
        }
      ],
      rollback_hint: {
        executable: false,
        reason: "First-class rollback is not implemented yet; use reviewed git restore or cleanup workflows.",
        paths: [
          {
            path: "docs/b.md",
            strategy: "cleanup_created",
            reason: "Created path can be removed through reviewed cleanup workflow."
          }
        ]
      }
    });

    const ledger = await readFile(join(root, ".chatgpt", "operations", "ledger.jsonl"), "utf8");
    const entries = ledger.trim().split("\n").map((line) => JSON.parse(line));

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      ledger_schema_version: 1,
      event_type: "write_applied",
      ledger_path: ".chatgpt/operations/ledger.jsonl",
      validation_ids: [],
      tool: "repo_write_file",
      repo_id: "fixture",
      touched_paths: ["docs/a.md"]
    });
    expect(entries[1]).toMatchObject({
      ledger_schema_version: 1,
      event_type: "write_applied",
      ledger_path: ".chatgpt/operations/ledger.jsonl",
      validation_ids: [],
      tool: "repo_write_file",
      repo_id: "fixture",
      touched_paths: ["docs/b.md"]
    });
    expect(ledger).not.toContain("/tmp/");
    expect(ledger).not.toContain(root);
    expect(ledger).not.toContain("OPENAI_API_KEY");
  });

  test("invalid preexisting ledger lines do not break last write lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    await mkdir(join(root, ".chatgpt", "operations"), { recursive: true });
    await appendFile(join(root, ".chatgpt", "operations", "ledger.jsonl"), "not json\n", "utf8");

    const service = new OperationReceiptService(root);
    await service.writeLastWrite({
      tool: "repo_write_file",
      repo_id: "fixture",
      touched_paths: ["docs/a.md"],
      changed_paths: ["docs/a.md"],
      created_paths: ["docs/a.md"],
      modified_paths: [],
      counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
      summary: "Created docs/a.md."
    });

    const result = await service.readLastWrite("fixture");
    expect(result.found).toBe(true);
    expect(result.receipt?.touched_paths).toEqual(["docs/a.md"]);
  });

  test("rejects invalid hash metadata before writing receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    const service = new OperationReceiptService(root);

    const result = await service.writeLastWrite({
      tool: "repo_write_file",
      repo_id: "fixture",
      head_sha_before: "not-a-git-sha",
      touched_paths: ["docs/a.md"],
      changed_paths: ["docs/a.md"],
      created_paths: ["docs/a.md"],
      modified_paths: [],
      counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
      summary: "Created docs/a.md.",
      files: [
        {
          path: "docs/a.md",
          action: "write",
          changed: true,
          created: true,
          new_sha256: "not-a-sha256"
        }
      ]
    });

    expect(result).toEqual({ ok: false, warnings: ["OPERATION_RECEIPT_WRITE_FAILED"] });
    await expect(readFile(join(root, ".chatgpt", "operations", "last-write.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("rejects unsafe nested file metadata before writing receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    const service = new OperationReceiptService(root);

    const result = await service.writeLastWrite({
      tool: "repo_write_file",
      repo_id: "fixture",
      touched_paths: ["docs/a.md"],
      changed_paths: ["docs/a.md"],
      created_paths: ["docs/a.md"],
      modified_paths: [],
      counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
      summary: "Created docs/a.md.",
      files: [
        {
          path: "/tmp/leak.md",
          action: "write",
          changed: true,
          created: true,
          new_sha256: "a".repeat(64)
        }
      ]
    });

    expect(result).toEqual({ ok: false, warnings: ["OPERATION_RECEIPT_WRITE_FAILED"] });
    await expect(readFile(join(root, ".chatgpt", "operations", "last-write.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("rejects unsafe rollback path metadata before writing receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    const service = new OperationReceiptService(root);

    const result = await service.writeLastWrite({
      tool: "repo_write_file",
      repo_id: "fixture",
      touched_paths: ["docs/a.md"],
      changed_paths: ["docs/a.md"],
      created_paths: ["docs/a.md"],
      modified_paths: [],
      counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
      summary: "Created docs/a.md.",
      rollback_hint: {
        executable: false,
        reason: "Use reviewed workflow.",
        paths: [
          {
            path: "../outside.md",
            strategy: "manual_review",
            reason: "Needs review."
          }
        ]
      }
    });

    expect(result).toEqual({ ok: false, warnings: ["OPERATION_RECEIPT_WRITE_FAILED"] });
    await expect(readFile(join(root, ".chatgpt", "operations", "last-write.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("rejects unsafe rollback reasons before writing receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    const service = new OperationReceiptService(root);

    const result = await service.writeLastWrite({
      tool: "repo_write_file",
      repo_id: "fixture",
      touched_paths: ["docs/a.md"],
      changed_paths: ["docs/a.md"],
      created_paths: ["docs/a.md"],
      modified_paths: [],
      counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
      summary: "Created docs/a.md.",
      rollback_hint: {
        executable: false,
        reason: "Restore from /tmp/leak.md",
        paths: [
          {
            path: "docs/a.md",
            strategy: "cleanup_created",
            reason: "OPENAI_API_KEY=sk-realSecretValue123"
          }
        ]
      }
    });

    expect(result).toEqual({ ok: false, warnings: ["OPERATION_RECEIPT_WRITE_FAILED"] });
    await expect(readFile(join(root, ".chatgpt", "operations", "last-write.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  test("invalid receipt content is treated as missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-receipt-"));
    await mkdir(join(root, ".chatgpt", "operations"), { recursive: true });
    await writeFile(join(root, ".chatgpt", "operations", "last-write.json"), JSON.stringify({
      schema_version: 1,
      operation_id: "write-test",
      tool: "repo_write_file",
      repo_id: "fixture",
      timestamp: new Date().toISOString(),
      touched_paths: ["/tmp/leak.md"],
      changed_paths: ["/tmp/leak.md"],
      created_paths: [],
      modified_paths: ["/tmp/leak.md"],
      counts: { requested: 1, changed: 1, created: 0, unchanged: 0 },
      summary: "Updated /tmp/leak.md."
    }));

    const result = await new OperationReceiptService(root).readLastWrite("fixture");

    expect(result).toEqual({
      ok: true,
      found: false,
      next_tool_payloads: {},
      warnings: ["INVALID_LAST_WRITE_RECEIPT"]
    });
  });
});
