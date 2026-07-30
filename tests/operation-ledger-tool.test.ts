import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RootRegistry } from "../src/services/root-registry.js";
import { operationLedgerHandler } from "../src/tools/handlers.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("repo_operation_ledger", () => {
  test("reads repo-local ledger through the tool handler", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, ".chatgpt", "operations"), { recursive: true });
    await appendFile(join(fixture.root, ".chatgpt", "operations", "ledger.jsonl"), `${JSON.stringify({
      schema_version: 1,
      operation_id: "write-a",
      tool: "repo_write_file",
      repo_id: "fixture",
      timestamp: new Date().toISOString(),
      touched_paths: ["docs/a.md"],
      changed_paths: ["docs/a.md"],
      created_paths: ["docs/a.md"],
      modified_paths: [],
      counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
      summary: "Created docs/a.md.",
      ledger_schema_version: 1,
      ledger_entry_id: "ledger-a",
      event_type: "write_applied",
      validation_ids: [],
      ledger_path: ".chatgpt/operations/ledger.jsonl"
    })}\n`, "utf8");
    const registry = await RootRegistry.fromConfig({
      repos: [{ repo_id: "fixture", display_name: "Fixture", root: fixture.root }],
      limits: {}
    });

    const result = await operationLedgerHandler({ repo_id: "fixture" }, { registry });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      repo_id: "fixture",
      events: [{ operation_id: "write-a", touched_paths: ["docs/a.md"] }],
      warnings: []
    });
  });
});
