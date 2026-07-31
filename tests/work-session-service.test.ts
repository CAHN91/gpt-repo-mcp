import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RepoReaderError } from "../src/runtime/errors.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WorkSessionService } from "../src/services/work-session-service.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("WorkSessionService", () => {
  test("starts a work session and updates the current pointer", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    const result = await service.start({
      repo_id: "fixture",
      title: "Work Session State",
      objective: "Track active implementation progress.",
      constraints: ["No raw command output"],
      files_inspected: ["docs/ROADMAP.md"],
      next_action: "Write red tests"
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      work_session_id: "20260623-101500-work-session-state",
      session_path: ".chatgpt/work-sessions/20260623-101500-work-session-state.json",
      current_path: ".chatgpt/work-sessions/current.json",
      session: {
        schema_version: 1,
        repo_id: "fixture",
        title: "Work Session State",
        objective: "Track active implementation progress.",
        status: "active",
        constraints: ["No raw command output"],
        files_inspected: ["docs/ROADMAP.md"],
        next_action: "Write red tests"
      },
      warnings: [],
      next_tool_payloads: {
        repo_current_work_session: {
          repo_id: "fixture",
          work_session_id: "20260623-101500-work-session-state"
        }
      }
    });

    await expect(readJson(fixture.root, result.session_path)).resolves.toMatchObject(result.session);
    await expect(readJson(fixture.root, result.current_path)).resolves.toMatchObject({
      repo_id: "fixture",
      work_session_id: result.work_session_id,
      session_path: result.session_path,
      status: "active",
      next_action: "Write red tests"
    });
  });

  test("dry_run returns paths and session without writing files", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    const result = await service.start({
      repo_id: "fixture",
      title: "Dry Run Session",
      objective: "Preview state writes.",
      next_action: "Review payload",
      dry_run: true
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      work_session_id: "20260623-101500-dry-run-session"
    });
    await expect(access(join(fixture.root, result.session_path))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(fixture.root, result.current_path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("updates a session with deduped appended progress", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const started = await service.start({
      repo_id: "fixture",
      title: "Update Session",
      objective: "Track progress.",
      files_inspected: ["docs/ROADMAP.md"],
      next_action: "Implement service"
    });

    const result = await service.update({
      repo_id: "fixture",
      work_session_id: started.work_session_id,
      append_files_inspected: ["docs/ROADMAP.md", "src/tools/contracts.ts"],
      append_touched_files: ["src/services/work-session-service.ts", "src/services/work-session-service.ts"],
      append_decisions: ["Keep state content-free", "Keep state content-free"],
      append_assumptions: ["Current session is per repo"],
      append_pending_patchsets: [{ patchset_id: "patchset-123", status: "prepared" }],
      append_validation_results: [{ profile: "test", status: "passed", note: "Focused tests passed" }],
      append_unresolved_risks: ["MCP snapshots need update"],
      status: "active",
      next_action: "Run targeted tests"
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      session: {
        files_inspected: ["docs/ROADMAP.md", "src/tools/contracts.ts"],
        touched_files: ["src/services/work-session-service.ts"],
        decisions: ["Keep state content-free"],
        assumptions: ["Current session is per repo"],
        pending_patchsets: [{ patchset_id: "patchset-123", status: "prepared" }],
        validation_results: [{ profile: "test", status: "passed", note: "Focused tests passed" }],
        unresolved_risks: ["MCP snapshots need update"],
        next_action: "Run targeted tests"
      }
    });
  });

  test("reads active current-pointer continuity", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const started = await service.start({
      repo_id: "fixture",
      title: "Current Session",
      objective: "Read current state.",
      next_action: "Continue"
    });

    await expect(service.current({ repo_id: "fixture" })).resolves.toMatchObject({
      ok: true,
      repo_id: "fixture",
      lookup_source: "current_pointer",
      found: true,
      continuity_state: "active",
      work_session_id: started.work_session_id,
      session_path: started.session_path,
      current_path: ".chatgpt/work-sessions/current.json",
      session: {
        title: "Current Session",
        next_action: "Continue"
      },
      warnings: []
    });
  });

  test("reads blocked current-pointer continuity as ongoing blocked work", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const started = await service.start({
      repo_id: "fixture",
      title: "Blocked Session",
      objective: "Preserve blocked continuity.",
      next_action: "Wait for required input"
    });
    await service.update({
      repo_id: "fixture",
      work_session_id: started.work_session_id,
      status: "blocked"
    });

    await expect(service.current({ repo_id: "fixture" })).resolves.toMatchObject({
      lookup_source: "current_pointer",
      found: true,
      continuity_state: "blocked",
      session: { status: "blocked", next_action: "Wait for required input" },
      warnings: ["CURRENT_WORK_SESSION_BLOCKED"]
    });
  });

  test("reads completed current-pointer continuity as history", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const started = await service.start({
      repo_id: "fixture",
      title: "Completed Session",
      objective: "Preserve completed history.",
      next_action: "Historical follow-up"
    });
    await service.update({
      repo_id: "fixture",
      work_session_id: started.work_session_id,
      status: "completed"
    });

    const result = await service.current({ repo_id: "fixture" });
    expect(result).toMatchObject({
      lookup_source: "current_pointer",
      found: true,
      continuity_state: "completed_history",
      work_session_id: started.work_session_id,
      session_path: started.session_path,
      current_path: ".chatgpt/work-sessions/current.json",
      warnings: ["CURRENT_WORK_SESSION_COMPLETED"]
    });
    expect(result).not.toHaveProperty("session");
    await expect(readJson(fixture.root, started.session_path)).resolves.toMatchObject({
      status: "completed",
      next_action: "Historical follow-up"
    });
  });

  test("reads a completed session by explicit id as historical inspection", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const started = await service.start({
      repo_id: "fixture",
      title: "Historical Session",
      objective: "Retain historical decisions and risks.",
      next_action: "Historical next action"
    });
    await service.update({
      repo_id: "fixture",
      work_session_id: started.work_session_id,
      status: "completed",
      append_decisions: ["Keep the completed approach"],
      append_unresolved_risks: ["Known historical risk"]
    });

    const result = await service.current({ repo_id: "fixture", work_session_id: started.work_session_id });
    expect(result).toMatchObject({
      lookup_source: "explicit_id",
      found: true,
      continuity_state: "completed_history",
      session: {
        objective: "Retain historical decisions and risks.",
        decisions: ["Keep the completed approach"],
        unresolved_risks: ["Known historical risk"],
        next_action: "Historical next action"
      },
      warnings: []
    });
    expect(result).not.toHaveProperty("current_path");
  });

  test("reads current state without constructing write policy or sandbox dependencies", async () => {
    const fixture = await createRepoFixture();
    const started = await createService(fixture.root).start({
      repo_id: "fixture",
      title: "Read Only Current",
      objective: "Prove read-only session access is decoupled from writes.",
      next_action: "Continue"
    });

    await expect(new WorkSessionService(fixture.root).current({ repo_id: "fixture" })).resolves.toMatchObject({
      lookup_source: "current_pointer",
      found: true,
      continuity_state: "active",
      work_session_id: started.work_session_id,
      session: { next_action: "Continue" }
    });
  });

  test("missing current session returns found false with a warning", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    await expect(service.current({ repo_id: "fixture" })).resolves.toEqual({
      ok: true,
      repo_id: "fixture",
      lookup_source: "current_pointer",
      found: false,
      warnings: ["NO_CURRENT_WORK_SESSION"]
    });
  });

  test("reports missing explicit-id and mismatched current-pointer state", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    await expect(service.current({ repo_id: "fixture", work_session_id: "missing-session" })).resolves.toEqual({
      ok: true,
      repo_id: "fixture",
      lookup_source: "explicit_id",
      found: false,
      warnings: ["WORK_SESSION_NOT_FOUND"]
    });

    await service.start({
      repo_id: "fixture",
      title: "Pointer Mismatch",
      objective: "Expose a mismatched pointer.",
      next_action: "Stop"
    });
    await expect(service.current({ repo_id: "other" })).resolves.toEqual({
      ok: true,
      repo_id: "other",
      lookup_source: "current_pointer",
      found: false,
      warnings: ["CURRENT_WORK_SESSION_REPO_MISMATCH"]
    });
  });

  test("rejects mutation when no write dependencies were supplied", async () => {
    const fixture = await createRepoFixture();

    await expect(new WorkSessionService(fixture.root).start({
      repo_id: "fixture",
      title: "Read Only Service",
      objective: "Reject mutation without writer.",
      next_action: "Stop"
    })).rejects.toMatchObject({ code: "WRITE_DISABLED" } satisfies Partial<RepoReaderError>);
  });

  test("rejects repo mismatches before updating", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);
    const started = await service.start({
      repo_id: "fixture",
      title: "Mismatch",
      objective: "Reject wrong repo.",
      next_action: "Update"
    });

    await expect(service.update({
      repo_id: "other",
      work_session_id: started.work_session_id,
      next_action: "Should fail"
    })).rejects.toMatchObject({ code: "WORK_SESSION_REPO_MISMATCH" } satisfies Partial<RepoReaderError>);
  });

  test("rejects unsafe repo-relative path fields", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root);

    await expect(service.start({
      repo_id: "fixture",
      title: "Unsafe Path",
      objective: "Reject traversal.",
      files_inspected: ["../secret.md"],
      next_action: "Stop"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" } satisfies Partial<RepoReaderError>);
  });
});

function createService(root: string) {
  return new WorkSessionService(
    root,
    new PathSandbox(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/work-sessions/**"] }),
    fixedNow
  );
}

function fixedNow() {
  return new Date(Date.UTC(2026, 5, 23, 10, 15, 0, 0));
}

async function readJson(root: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}
