import { appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { OperationLedgerService } from "../src/services/operation-ledger-service.js";

describe("OperationLedgerService", () => {
  test("returns latest safe ledger events for the requested repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-ledger-"));
    await writeLedger(root, [
      event({ operation_id: "write-a", repo_id: "fixture", touched_paths: ["docs/a.md"] }),
      event({ operation_id: "write-other", repo_id: "other", touched_paths: ["docs/other.md"] }),
      event({ operation_id: "write-b", repo_id: "fixture", touched_paths: ["docs/b.md"] }),
      event({ operation_id: "write-c", repo_id: "fixture", touched_paths: ["docs/c.md"] })
    ]);

    const result = await new OperationLedgerService(root).read({ repo_id: "fixture", limit: 2 });

    expect(result).toMatchObject({
      ok: true,
      repo_id: "fixture",
      events: [
        { operation_id: "write-c", touched_paths: ["docs/c.md"] },
        { operation_id: "write-b", touched_paths: ["docs/b.md"] }
      ],
      next_cursor: "2",
      warnings: []
    });
  });

  test("supports cursor and after_operation_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-ledger-"));
    await writeLedger(root, [
      event({ operation_id: "write-a", repo_id: "fixture", touched_paths: ["docs/a.md"] }),
      event({ operation_id: "write-b", repo_id: "fixture", touched_paths: ["docs/b.md"] }),
      event({ operation_id: "write-c", repo_id: "fixture", touched_paths: ["docs/c.md"] })
    ]);

    const page = await new OperationLedgerService(root).read({ repo_id: "fixture", limit: 1, cursor: "1" });
    expect(page.events.map((entry) => entry.operation_id)).toEqual(["write-b"]);
    expect(page.next_cursor).toBe("2");

    const after = await new OperationLedgerService(root).read({ repo_id: "fixture", after_operation_id: "write-a" });
    expect(after.events.map((entry) => entry.operation_id)).toEqual(["write-c", "write-b"]);
    expect(after.next_cursor).toBeUndefined();
  });

  test("skips invalid and unsafe ledger lines with warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "repo-reader-ledger-"));
    await mkdir(join(root, ".chatgpt", "operations"), { recursive: true });
    await appendFile(join(root, ".chatgpt", "operations", "ledger.jsonl"), "not json\n", "utf8");
    await appendFile(join(root, ".chatgpt", "operations", "ledger.jsonl"), `${JSON.stringify(event({ operation_id: "write-leak", repo_id: "fixture", touched_paths: ["/tmp/leak.md"] }))}\n`, "utf8");
    await appendFile(join(root, ".chatgpt", "operations", "ledger.jsonl"), `${JSON.stringify(event({ operation_id: "write-safe", repo_id: "fixture", touched_paths: ["docs/safe.md"] }))}\n`, "utf8");

    const result = await new OperationLedgerService(root).read({ repo_id: "fixture" });

    expect(result.events.map((entry) => entry.operation_id)).toEqual(["write-safe"]);
    expect(result.warnings).toEqual(["OPERATION_LEDGER_INVALID_LINES"]);
  });
});

async function writeLedger(root: string, entries: unknown[]): Promise<void> {
  await mkdir(join(root, ".chatgpt", "operations"), { recursive: true });
  for (const entry of entries) {
    await appendFile(join(root, ".chatgpt", "operations", "ledger.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  }
}

function event(input: { operation_id: string; repo_id: string; touched_paths: string[] }) {
  return {
    schema_version: 1,
    operation_id: input.operation_id,
    tool: "repo_write_file",
    repo_id: input.repo_id,
    timestamp: new Date().toISOString(),
    touched_paths: input.touched_paths,
    changed_paths: input.touched_paths,
    created_paths: input.touched_paths,
    modified_paths: [],
    counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
    summary: `Created ${input.touched_paths[0]}.`,
    ledger_schema_version: 1,
    ledger_entry_id: `ledger-${input.operation_id}`,
    event_type: "write_applied",
    validation_ids: [],
    ledger_path: ".chatgpt/operations/ledger.jsonl"
  };
}
