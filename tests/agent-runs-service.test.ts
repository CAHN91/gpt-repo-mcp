import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DelegationAttemptStore as AgentRunnerAttemptStore } from "../src/delegation/attempt-store.js";
import { DelegationInteractionStore as AgentRunnerInteractionStore } from "../src/delegation/interaction-store.js";
import { DelegationRunStore as AgentRunnerRunStore } from "../src/delegation/run-store.js";
import { DelegationSupervisorStore as AgentRunnerSupervisorStore } from "../src/delegation/supervisor-store.js";
import { AgentRunsInputSchema, AgentRunsResultSchema } from "../src/contracts/agent-runs.contract.js";
import { RepoReaderError } from "../src/runtime/errors.js";
import { AgentRunsService, type AgentRunsServiceOptions } from "../src/services/agent-runs-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";
import { runnerStatusBinding } from "./fixtures/delegation-v3-run-fixture.js";

const RUN_A = "2026-07-13T090000Z-manual-task";
const RUN_B = "2026-07-13T100000Z-queued-task";
const RUN_C = "2026-07-13T110000Z-latest-task";

describe("AgentRunsService", () => {
  test("returns an empty bounded list when no runs exist", async () => {
    const fixture = await createRepoFixture();

    const result = await service(fixture.root).read({ repo_id: "fixture" });

    expect(result).toEqual({
      ok: true,
      repo_id: "fixture",
      mode: "list",
      runs: [],
      drift_summary: {
        status: "no_history",
        observed_v3_run_count: 0,
        root_run_count: 0,
        product_root_run_count: 0,
        technical_root_run_count: 0,
        child_run_count: 0,
        corrective_child_count: 0,
        scope_amendment_child_count: 0,
        scope_extension_run_count: 0,
        failed_product_review_count: 0,
        maximum_corrective_children_per_root: 0,
        prompt_bytes: { sample_count: 0, trend: "insufficient_data" },
        starting_point_count: { sample_count: 0, trend: "insufficient_data" },
        authorization_pattern_count: { sample_count: 0, trend: "insufficient_data" },
        repeated_areas: [],
        checkpoint: {
          status: "unavailable",
          governance_mode: "unavailable",
          root_runs_since_last_product_checkpoint: 0
        },
        signals: [],
        warnings: []
      },
      matched_count: 0,
      returned_count: 0,
      truncated: false,
      revision: 0,
      next_tool_payloads: {},
      warnings: []
    });
    expect(() => AgentRunsResultSchema.parse(result)).not.toThrow();
  });

  test("keeps legacy service options compatible while wait support remains opt-in", async () => {
    const fixture = await createRepoFixture();
    const legacyOptions: AgentRunsServiceOptions = { repository_max_runtime_ms: 60_000 };

    const result = await new AgentRunsService(fixture.root, new PathSandbox(fixture.root), legacyOptions)
      .read({ repo_id: "fixture" });

    expect(result).toMatchObject({
      ok: true,
      repo_id: "fixture",
      mode: "list",
      runs: [],
      warnings: []
    });
  });

  test("returns the supervisor-bound list revision even before a runs directory exists", async () => {
    const fixture = await createRepoFixture();
    await new AgentRunnerSupervisorStore(fixture.root).write({
      repo_id: "fixture",
      runner: "codex_sdk",
      status: "ready",
      heartbeat_at: "2026-07-13T10:03:00.000Z",
      last_scan_at: "2026-07-13T10:03:00.000Z",
      last_claimed_run_id: null,
      active_run_id: null,
      stale_after_ms: 30_000,
      warnings: []
    });

    const result = await service(fixture.root).read({ repo_id: "fixture" });

    expect(result.revision).not.toBe(0);
    expect(result.supervisor?.revision).toBe(1);
  });

  test("paginates newest-first with an opaque stable cursor", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_A, { mode: "manual" });
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "codex_sdk" });
    await writeRun(fixture.root, RUN_C, { mode: "manual" });

    const first = await service(fixture.root).read({ repo_id: "fixture", page_size: 2 });
    const second = await service(fixture.root).read({ repo_id: "fixture", page_size: 2, cursor: first.next_cursor });

    expect(first.runs?.map((run) => run.run_id)).toEqual([RUN_C, RUN_B]);
    expect(first).toMatchObject({ matched_count: 3, returned_count: 2, truncated: true });
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.next_cursor).not.toContain(RUN_B);
    expect(second.runs?.map((run) => run.run_id)).toEqual([RUN_A]);
    expect(second).toMatchObject({ matched_count: 3, returned_count: 1, truncated: false });
    await expect(service(fixture.root).read({
      repo_id: "fixture",
      statuses: ["manual"],
      cursor: first.next_cursor
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" } satisfies Partial<RepoReaderError>);
  });

  test("distinguishes manual and queued missing-status runs and filters them", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_A, { mode: "manual" });
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "opencode_sdk" });

    const all = await service(fixture.root).read({ repo_id: "fixture" });
    const queued = await service(fixture.root).read({ repo_id: "fixture", statuses: ["queued"] });

    expect(all.runs?.map((run) => [run.run_id, run.effective_status])).toEqual([
      [RUN_B, "queued"],
      [RUN_A, "manual"]
    ]);
    expect(all.runs?.find((run) => run.run_id === RUN_A)?.runtime).toBeUndefined();
    expect(all.runs?.find((run) => run.run_id === RUN_B)?.runtime).toMatchObject({
      active_runtime_ms: 0,
      remaining_runtime_ms: 900_000
    });
    expect(queued.runs?.map((run) => run.run_id)).toEqual([RUN_B]);
  });

  test("reports effective, consumed, and remaining runtime including an active turn", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, {
      mode: "queued",
      requested_runner: "codex_sdk",
      max_runtime_ms: 30_000
    });
    const now = () => new Date("2026-07-13T10:00:10.000Z");
    await new AgentRunnerRunStore(fixture.root, { now }).writeStatus({
      repo_id: "fixture",
      run_id: RUN_B,
      runner: "codex_sdk",
      status: "running",
      started_at: "2026-07-13T10:00:00.000Z",
      ...runnerStatusBinding(RUN_B, 1),
      result_found: false,
      head_before: "head",
      changed_paths: [],
      validation: { status: "missing", profile: null, artifact_path: null },
      commit: { attempted: false, allowed: false, status: "skipped", commit_sha: null },
      warnings: []
    });
    await new AgentRunnerInteractionStore(fixture.root, now).writeSession({
      repo_id: "fixture",
      run_id: RUN_B,
      provider: "codex_sdk",
      thread_id: "private-thread",
      turn_index: 1,
      max_runtime_ms: 30_000,
      active_runtime_ms: 5_000,
      last_consumed_reply_turn_index: null,
      created_at: "2026-07-13T10:00:00.000Z"
    });
    await new AgentRunnerAttemptStore(fixture.root, now).write({
      repo_id: "fixture",
      run_id: RUN_B,
      provider: "codex_sdk",
      operation: "resume",
      turn_index: 1,
      state: "in_flight",
      started_at: "2026-07-13T10:00:00.000Z"
    });

    const result = await new AgentRunsService(fixture.root, new PathSandbox(fixture.root), {
      repository_max_runtime_ms: 60_000,
      now
    }).read({ repo_id: "fixture", run_id: RUN_B });

    expect(result.run?.runtime).toEqual({
      requested_max_runtime_ms: 30_000,
      effective_max_runtime_ms: 30_000,
      active_runtime_ms: 15_000,
      remaining_runtime_ms: 15_000
    });
    expect(JSON.stringify(result)).not.toContain("private-thread");
  });

  test("counts a settled failed first turn when no provider session was created", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, {
      mode: "queued",
      requested_runner: "codex_sdk",
      max_runtime_ms: 30_000
    });
    const now = () => new Date("2026-07-13T10:00:10.000Z");
    await new AgentRunnerRunStore(fixture.root, { now }).writeStatus({
      repo_id: "fixture",
      run_id: RUN_B,
      runner: "codex_sdk",
      status: "timed_out",
      started_at: "2026-07-13T10:00:00.000Z",
      completed_at: "2026-07-13T10:00:10.000Z",
      ...runnerStatusBinding(RUN_B, 1),
      result_found: false,
      head_before: "head",
      changed_paths: [],
      validation: { status: "missing", profile: null, artifact_path: null },
      commit: { attempted: false, allowed: false, status: "skipped", commit_sha: null },
      warnings: ["RUNNER_TIMEOUT"]
    });
    await new AgentRunnerAttemptStore(fixture.root, now).write({
      repo_id: "fixture",
      run_id: RUN_B,
      provider: "codex_sdk",
      operation: "start",
      turn_index: 0,
      state: "settled",
      started_at: "2026-07-13T10:00:00.000Z"
    });

    const result = await new AgentRunsService(fixture.root, new PathSandbox(fixture.root), {
      repository_max_runtime_ms: 60_000,
      now
    }).read({ repo_id: "fixture", run_id: RUN_B });

    expect(result.run?.runtime).toMatchObject({
      effective_max_runtime_ms: 30_000,
      active_runtime_ms: 10_000,
      remaining_runtime_ms: 20_000
    });
  });

  test("clamps an oversized task request to the repository limit", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, {
      mode: "queued",
      requested_runner: "codex_sdk",
      max_runtime_ms: 90_000
    });

    const result = await new AgentRunsService(fixture.root, new PathSandbox(fixture.root), {
      repository_max_runtime_ms: 60_000
    }).read({ repo_id: "fixture", run_id: RUN_B });

    expect(result.run?.runtime).toEqual({
      requested_max_runtime_ms: 90_000,
      effective_max_runtime_ms: 60_000,
      active_runtime_ms: 0,
      remaining_runtime_ms: 60_000
    });
    expect(result.run?.warnings).toContain("AGENT_RUN_RUNTIME_CLAMPED");
  });

  test("reads selected detail with cursor-paged redacted events", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "codex_sdk" });
    const store = new AgentRunnerRunStore(fixture.root);
    await store.appendEvent({ repo_id: "fixture", run_id: RUN_B, event_type: "queued", summary: "Queued." });
    const paths = runArtifactPaths(RUN_B);
    await writeFile(join(fixture.root, paths.events), `${JSON.stringify({
      schema_version: 1,
      repo_id: "fixture",
      run_id: RUN_B,
      event_type: "adapter_event",
      timestamp: "2026-07-13T10:01:00.000Z",
      summary: "OPENAI_API_KEY=sk-realSecretValue123 at /Users/example/project"
    })}\n`, { flag: "a" });

    const first = await service(fixture.root).read({ repo_id: "fixture", run_id: RUN_B, max_events: 1 });
    const second = await service(fixture.root).read({
      repo_id: "fixture",
      run_id: RUN_B,
      max_events: 1,
      events_after: first.run?.event_page.next_cursor
    });

    expect(first).not.toHaveProperty("drift_summary");
    expect(second).not.toHaveProperty("drift_summary");
    expect(first.run?.events.map((event) => event.event_type)).toEqual(["queued"]);
    expect(first.run?.event_page).toMatchObject({ returned_count: 1, truncated: true });
    expect(second.run?.events[0]?.summary).toContain("[REDACTED_SECRET]");
    expect(second.run?.events[0]?.summary).toContain("[REDACTED_PATH]");
    expect(JSON.stringify(second)).not.toContain("sk-realSecretValue123");
    expect(second.run?.event_page.truncated).toBe(false);
  });

  test("skips malformed runs, status, and events without losing valid runs", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_A, { mode: "manual" });
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "codex_sdk" });
    await writeFile(join(fixture.root, runArtifactPaths(RUN_A).manifest), "{ malformed\n");
    await writeFile(join(fixture.root, runArtifactPaths(RUN_B).status), "{ malformed\n");
    await writeFile(join(fixture.root, runArtifactPaths(RUN_B).events), "{ malformed\n");

    const list = await service(fixture.root).read({ repo_id: "fixture" });
    const detail = await service(fixture.root).read({ repo_id: "fixture", run_id: RUN_B });

    expect(list.runs?.map((run) => run.run_id)).toEqual([RUN_B]);
    expect(list.warnings).toContain(`AGENT_RUN_INVALID:${RUN_A}`);
    expect(list.runs?.[0]?.warnings).toContain("AGENT_RUN_STATUS_INVALID");
    expect(detail.run?.events).toEqual([]);
    expect(detail.warnings).toContain("AGENT_RUN_EVENT_INVALID");
  });

  test("never trusts mismatched status or event identities", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "codex_sdk" });
    await writeStatus(fixture.root, RUN_B, "other-repo", "completed");
    await writeFile(join(fixture.root, runArtifactPaths(RUN_B).events), `${JSON.stringify({
      schema_version: 1,
      repo_id: "other-repo",
      run_id: RUN_B,
      event_type: "completed",
      timestamp: "2026-07-13T10:03:00.000Z"
    })}\n`);

    const result = await service(fixture.root).read({ repo_id: "fixture", run_id: RUN_B });

    expect(result.run?.effective_status).toBe("queued");
    expect(result.run?.status).toBeUndefined();
    expect(result.run?.warnings).toContain("AGENT_RUN_STATUS_ID_MISMATCH");
    expect(result.run?.events).toEqual([]);
    expect(result.run?.warnings).toContain("AGENT_RUN_EVENT_ID_MISMATCH");
  });

  test("skips events with malicious non-ISO timestamps without returning their contents", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "codex_sdk" });
    const secret = "sk-maliciousTimestampSecret123";
    await writeFile(join(fixture.root, runArtifactPaths(RUN_B).events), `${JSON.stringify({
      schema_version: 1,
      repo_id: "fixture",
      run_id: RUN_B,
      event_type: "adapter_event",
      timestamp: `2026-07-13T10:03:00.000Z OPENAI_API_KEY=${secret}`,
      summary: "untrusted event"
    })}\n`);

    const result = await service(fixture.root).read({ repo_id: "fixture", run_id: RUN_B });

    expect(result.run?.events).toEqual([]);
    expect(result.warnings).toContain("AGENT_RUN_EVENT_INVALID");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("skips manifests bound to another repository and rejects selected detail", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_A, { mode: "manual" });
    const path = join(fixture.root, runArtifactPaths(RUN_A).manifest);
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    manifest.repo_id = "other-repo";
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

    const list = await service(fixture.root).read({ repo_id: "fixture" });

    expect(list.runs).toEqual([]);
    expect(list.warnings).toContain(`AGENT_RUN_INVALID:${RUN_A}`);
    await expect(service(fixture.root).read({ repo_id: "fixture", run_id: RUN_A })).rejects.toMatchObject({
      code: "AGENT_RUN_ARTIFACT_INVALID"
    } satisfies Partial<RepoReaderError>);
  });

  test("uses trusted status and returns a review payload when a result exists", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "codex_sdk" });
    await writeStatus(fixture.root, RUN_B, "fixture", "completed");
    await writeFile(join(fixture.root, runArtifactPaths(RUN_B).resultJson), "{}\n");

    const result = await service(fixture.root).read({ repo_id: "fixture", run_id: RUN_B });

    expect(result.run).toMatchObject({
      effective_status: "completed",
      result_presence: { legacy_result_md: false, result_json: true, reviewable: true },
      status: { status: "completed", repo_id: "fixture", run_id: RUN_B }
    });
    expect(result.next_tool_payloads.repo_codex_review).toEqual({ repo_id: "fixture", run_id: RUN_B });
  });

  test("uses the selected run revision for detail waits and responses", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "codex_sdk" });
    await writeStatus(fixture.root, RUN_B, "fixture", "completed", 7);
    await new AgentRunnerSupervisorStore(fixture.root).write({
      repo_id: "fixture",
      runner: "codex_sdk",
      status: "ready",
      heartbeat_at: "2026-07-13T10:03:00.000Z",
      last_scan_at: "2026-07-13T10:03:00.000Z",
      last_claimed_run_id: RUN_B,
      active_run_id: null,
      stale_after_ms: 30_000,
      warnings: []
    });

    const result = await new AgentRunsService(fixture.root, new PathSandbox(fixture.root), {
      sleep: async () => { throw new Error("wait should not be entered"); }
    }).read({ repo_id: "fixture", run_id: RUN_B, wait_after_revision: 6, wait_timeout_ms: 30_000 });

    expect(result.revision).toBe(7);
    expect(result.supervisor?.revision).toBe(1);
  });

  test("returns a stable opaque list revision that changes with run state", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "codex_sdk" });
    await writeStatus(fixture.root, RUN_B, "fixture", "completed", 4);

    const first = await service(fixture.root).read({ repo_id: "fixture" });
    const unchanged = await service(fixture.root).read({ repo_id: "fixture" });
    await writeStatus(fixture.root, RUN_B, "fixture", "completed", 5);
    const changed = await service(fixture.root).read({ repo_id: "fixture" });

    expect(first.revision).toEqual(expect.any(Number));
    expect(unchanged.revision).toBe(first.revision);
    expect(changed.revision).not.toBe(first.revision);
  });

  test("wakes list waits when a run changes below an independent supervisor revision", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_B, { mode: "queued", requested_runner: "codex_sdk" });
    await writeStatus(fixture.root, RUN_B, "fixture", "completed", 1);
    const supervisor = new AgentRunnerSupervisorStore(fixture.root);
    for (let revision = 0; revision < 5; revision += 1) {
      await supervisor.write({
        repo_id: "fixture",
        runner: "codex_sdk",
        status: "ready",
        heartbeat_at: "2026-07-13T10:03:00.000Z",
        last_scan_at: "2026-07-13T10:03:00.000Z",
        last_claimed_run_id: RUN_B,
        active_run_id: null,
        stale_after_ms: 30_000,
        warnings: []
      });
    }
    const initial = await service(fixture.root).read({ repo_id: "fixture" });
    const initialRevision = initial.revision!;
    let updated = false;
    const result = await new AgentRunsService(fixture.root, new PathSandbox(fixture.root), {
      sleep: async () => {
        if (updated) return;
        updated = true;
        await writeStatus(fixture.root, RUN_B, "fixture", "completed", 2);
      }
    }).read({ repo_id: "fixture", wait_after_revision: initialRevision, wait_timeout_ms: 1_000 });

    expect(result.revision).not.toBe(initialRevision);
    expect(result.supervisor?.revision).toBe(5);
  });

  test("prefers the latest terminal reviewable run for list review payload", async () => {
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_A, { mode: "queued", requested_runner: "codex_sdk" });
    await writeRun(fixture.root, RUN_C, { mode: "manual" });
    await writeStatus(fixture.root, RUN_A, "fixture", "completed");
    await writeFile(join(fixture.root, runArtifactPaths(RUN_A).resultMd), "done\n");
    await writeFile(join(fixture.root, runArtifactPaths(RUN_C).resultMd), "manual result\n");

    const result = await service(fixture.root).read({ repo_id: "fixture" });

    expect(result.next_tool_payloads.repo_codex_review).toEqual({ repo_id: "fixture", run_id: RUN_A });
  });

  test("rejects unsafe ids and selected malformed artifacts deliberately", async () => {
    expect(() => AgentRunsInputSchema.parse({ repo_id: "fixture", run_id: "../escape" })).toThrow();
    expect(() => AgentRunsInputSchema.parse({ repo_id: "fixture", max_events: 2 })).toThrow();
    const fixture = await createRepoFixture();
    await writeRun(fixture.root, RUN_A, { mode: "manual" });
    await writeFile(join(fixture.root, runArtifactPaths(RUN_A).manifest), "[]\n");

    await expect(service(fixture.root).read({ repo_id: "fixture", run_id: RUN_A })).rejects.toMatchObject({
      code: "AGENT_RUN_ARTIFACT_INVALID"
    } satisfies Partial<RepoReaderError>);
  });

  test("ignores symlink run entries", async () => {
    const fixture = await createRepoFixture();
    const outside = join(fixture.root, "outside-run");
    await mkdir(outside);
    await mkdir(join(fixture.root, ".chatgpt", "codex-runs"), { recursive: true });
    const paths = runArtifactPaths(RUN_A);
    await writeFile(join(outside, "PROMPT.md"), "# Symlink prompt\n");
    await writeFile(join(outside, "run.json"), `${JSON.stringify({
      schema_version: 1,
      repo_id: "fixture",
      run_id: RUN_A,
      title: "Symlink run",
      prompt_path: paths.prompt,
      result_path: paths.resultMd,
      created_at: "2026-07-13T09:00:00.000Z",
      runner: { mode: "manual" }
    })}\n`);
    await symlink(outside, join(fixture.root, ".chatgpt", "codex-runs", RUN_A));

    const result = await service(fixture.root).read({ repo_id: "fixture" });

    expect(result.runs).toEqual([]);
    await expect(service(fixture.root).read({ repo_id: "fixture", run_id: RUN_A })).rejects.toMatchObject({
      code: "AGENT_RUN_ARTIFACT_INVALID"
    } satisfies Partial<RepoReaderError>);
  });
});

function service(root: string): AgentRunsService {
  return new AgentRunsService(root, new PathSandbox(root));
}

async function writeRun(
  root: string,
  runId: string,
  runner: { mode: "manual" } | {
    mode: "queued";
    requested_runner: "codex_sdk" | "opencode_sdk";
    max_runtime_ms?: number;
  }
): Promise<void> {
  const paths = runArtifactPaths(runId);
  await mkdir(join(root, paths.dir), { recursive: true });
  await writeFile(join(root, paths.prompt), "# Prompt\n");
  await writeFile(join(root, paths.manifest), `${JSON.stringify({
    schema_version: 1,
    repo_id: "fixture",
    run_id: runId,
    title: `Task ${runId}`,
    prompt_path: paths.prompt,
    result_path: paths.resultMd,
    result_json_path: paths.resultJson,
    created_at: `${runId.slice(0, 10)}T${runId.slice(11, 17)}Z`,
    runner
  }, null, 2)}\n`);
}

async function writeStatus(root: string, runId: string, repoId: string, status: "completed", revision = 0): Promise<void> {
  const paths = runArtifactPaths(runId);
  await writeFile(join(root, paths.status), `${JSON.stringify({
    schema_version: 1,
    repo_id: repoId,
    run_id: runId,
    runner: "codex_sdk",
    status,
    revision,
    started_at: "2026-07-13T10:00:00.000Z",
    updated_at: "2026-07-13T10:03:00.000Z",
    completed_at: "2026-07-13T10:03:00.000Z",
    prompt_path: paths.prompt,
    result_path: paths.resultMd,
    result_found: true,
    head_before: null,
    head_after: null,
    worktree_fingerprint_before: null,
    worktree_fingerprint_after: null,
    changed_paths: [],
    validation: { status: "missing", profile: null, artifact_path: null },
    commit: { attempted: false, allowed: false, status: "skipped", commit_sha: null },
    warnings: []
  }, null, 2)}\n`);
}

function runArtifactPaths(runId: string) {
  const dir = `.chatgpt/codex-runs/${runId}`;
  return {
    dir,
    prompt: `${dir}/PROMPT.md`,
    manifest: `${dir}/run.json`,
    resultMd: `${dir}/RESULT.md`,
    resultJson: `${dir}/RESULT.json`,
    status: `${dir}/runner.status.json`,
    events: `${dir}/runner.events.jsonl`
  };
}
