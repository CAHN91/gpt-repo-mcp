import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { ProductContract } from "../src/contracts/product-contract.contract.js";
import { DelegationV3TaskService } from "../src/services/delegation-v3-task-service.js";
import { AgentRunsService } from "../src/services/agent-runs-service.js";
import { AgentRunnerStatusSchema } from "../src/delegation/artifact-contracts.js";
import { DelegationRunStore as AgentRunnerRunStore } from "../src/delegation/run-store.js";
import { parseCodexRunManifest } from "../src/services/codex-run-manifest.js";
import {
  CodexCorrectiveLineageSchema,
  CodexRunManifestV2Schema,
  type CodexRunManifest,
  type CodexRunManifestV2
} from "../src/services/codex-run-manifest.js";
import {
  renderCodexManifest,
  renderCodexManifestWithLineage,
  renderCodexPrompt
} from "../src/legacy/codex-v2/renderer.js";
import { codexRunPaths } from "../src/services/codex-run-paths.js";
import { prepareCodexTaskHandler, writeCodexTaskHandler } from "../src/tools/handlers.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";
import { overspecifiedProductTaskInput, securityTaskInput } from "./fixtures/delegation-v3-fixtures.js";

const execFileAsync = promisify(execFile);
const FIXED_NOW = new Date("2026-07-18T23:00:00.000Z");

function productContract(): ProductContract {
  return {
    schema_version: 1,
    product: {
      name: "Fixture Operations",
      purpose: "Help a repository operator delegate coherent work without losing the intended outcome."
    },
    primary_users: [{
      id: "repo-operator",
      role: "Repository operator",
      technical_level: "Technical but time-constrained",
      work_context: "Coordinates ChatGPT and implementation agents across a trusted local repository."
    }],
    jobs_to_be_done: [{
      id: "delegate-coherent-work",
      statement: "Delegate complete repository work without prescribing every internal implementation step."
    }],
    must_reduce: ["Prompt micromanagement", "Repeated context reconstruction"],
    must_not_become: ["A file-by-file prompt factory", "A new approval bureaucracy"],
    experience_principles: ["Outcome before implementation detail", "Repository truth before agent claims"],
    canonical_docs: ["docs/guide.md"],
    governance: {
      mode: "advisory",
      product_review_required_for: ["product_slice", "product_correction"],
      checkpoint_every_root_runs: 5
    }
  };
}

function productTask() {
  return {
    repo_id: "fixture",
    title: "Restore coherent operator flow",
    task_kind: "product_correction" as const,
    assignment: "Restore a complete and understandable operator flow without prescribing every internal implementation step.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "The current flow exposes internal details before the operator understands the outcome.",
      desired_outcome: "The operator sees the intended result and next action before implementation detail.",
      why_now: "The repository is adopting product-grounded Delegation v3."
    },
    product_alignment: {
      primary_user_id: "repo-operator",
      job_ids: ["delegate-coherent-work"],
      user_problem: "The operator must supervise low-level implementation instead of reviewing the resulting product outcome.",
      product_goal: "Keep product intent explicit while the implementation agent owns coherent connected work.",
      additional_must_not_become: ["A developer-only workflow"],
      product_acceptance_criteria: [
        "The product user and desired outcome appear before implementation detail.",
        "The task permits logically connected changes within authorization."
      ]
    },
    relevant_context: "Preserve the repository's local-first and no-push operating model.",
    starting_points: ["src/**", "docs/guide.md"],
    authorization_scope: ["src/**", "tests/**", "docs/**"],
    forbidden_paths: ["config.local.json"],
    hard_constraints: ["Preserve repository path and write-policy enforcement."],
    must_preserve: ["Historical v1 and v2 runs remain reviewable."],
    explicit_exclusions: ["Do not add arbitrary command execution."],
    technical_acceptance_criteria: ["Typecheck and tests pass."],
    validation: { profile: "all" as const, test_paths: [] },
    runner: { mode: "manual" as const }
  };
}

function technicalTask() {
  return {
    repo_id: "fixture",
    title: "Add delegation infrastructure",
    task_kind: "technical_infrastructure" as const,
    assignment: "Add the bounded technical capability needed for coherent repository delegation.",
    outcome: {
      beneficiary: "Repository operator",
      current_problem: "The repository has no shared task contract.",
      desired_outcome: "Delegation metadata is structured, bounded, and reviewable.",
      why_now: "The public task surface is being cut over to v3."
    },
    technical_context: {
      enabling_value: "Allow ChatGPT and implementation agents to coordinate work without brittle prompts."
    },
    starting_points: ["src/**"],
    authorization_scope: ["src/**", "tests/**"],
    forbidden_paths: [],
    hard_constraints: ["Preserve existing write boundaries."],
    must_preserve: ["No automatic push."],
    explicit_exclusions: ["Do not add a hosted service."],
    technical_acceptance_criteria: ["The task artifacts validate as schema version 3."],
    runner: { mode: "manual" as const }
  };
}

describe("DelegationV3TaskService", () => {
  test("writes a product-grounded prompt and strict v3 manifest", async () => {
    const fixture = await repoFixture(true);
    const service = taskService(fixture.root);

    const result = await service.write(productTask());

    expect(result.schema_version).toBe(3);
    expect(result.task_kind).toBe("product_correction");
    expect(result.review_requirement).toBe("product_required");
    expect(result.product_contract_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty("result_path");
    expect(result.written_paths).toEqual([result.prompt_path, result.manifest_path, result.review_gate_path]);

    const prompt = await readFile(join(fixture.root, result.prompt_path), "utf8");
    const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(fixture.root, result.manifest_path), "utf8")));
    expect(manifest.schema_version).toBe(3);
    if (manifest.schema_version !== 3) throw new Error("Expected v3 manifest.");
    expect(manifest.product_binding.kind).toBe("selected");
    expect(manifest.review_requirement).toBe("product_required");
    expect(manifest).not.toHaveProperty("result_path");
    expect(manifest.task).not.toHaveProperty("objective");
    expect(manifest.task).not.toHaveProperty("context_summary");
    expect(manifest.task).not.toHaveProperty("inspect_first");
    expect(manifest.task).not.toHaveProperty("allowed_paths");
    expect(manifest.task).not.toHaveProperty("implementation_scope");
    expect(manifest.task).not.toHaveProperty("verification_commands");

    const productFrame = prompt.indexOf("## Product or Operational Frame");
    const assignment = prompt.indexOf("## Assignment");
    const startingPoints = prompt.indexOf("## Starting Points");
    const authorization = prompt.indexOf("## Authorization Boundary");
    const responsibility = prompt.indexOf("## Implementation Responsibility");
    const productCriteria = prompt.indexOf("## Product Acceptance Criteria");
    const technicalCriteria = prompt.indexOf("## Technical Acceptance Criteria");
    expect(productFrame).toBeGreaterThanOrEqual(0);
    expect(productFrame).toBeLessThan(assignment);
    expect(startingPoints).toBeLessThan(authorization);
    expect(authorization).toBeLessThan(responsibility);
    expect(responsibility).toBeLessThan(productCriteria);
    expect(productCriteria).toBeLessThan(technicalCriteria);
    expect(prompt).toContain("They are not an exhaustive read or implementation list");
    expect(prompt).toContain("They do not predict which files must change");
    expect(prompt).toContain("Complete logically connected work inside the authorization boundary");
    expect(prompt).toContain("structured scope-extension request");
    expect(prompt).toContain("strict JSON");
    expect(prompt).not.toContain("RESULT.md");

    const agentRun = await new AgentRunsService(fixture.root, new PathSandbox(fixture.root)).read({
      repo_id: "fixture",
      run_id: result.run_id
    });
    expect(agentRun.mode).toBe("detail");
    expect(agentRun.run).toMatchObject({
      run_id: result.run_id,
      manifest_version: 3,
      effective_status: "manual",
      prompt_path: result.prompt_path,
      result_json_path: result.result_json_path
    });
    expect(agentRun.run).not.toHaveProperty("legacy_result_path");
    expect(agentRun.run?.result_presence).not.toHaveProperty("legacy_result_md");
  });

  test("dry-run returns metadata without writing task artifacts", async () => {
    const fixture = await repoFixture(true);
    const service = taskService(fixture.root);

    const result = await service.write({ ...productTask(), dry_run: true });

    expect(result.dry_run).toBe(true);
    expect(result.written_paths).toEqual([]);
    await expect(access(join(fixture.root, result.prompt_path))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(fixture.root, result.manifest_path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("prepare and write share one normalized v3 task and audit path", async () => {
    const fixture = await repoFixture(true);
    const service = taskService(fixture.root);
    const input = {
      ...productTask(),
      run_id: "2026-07-18T230000Z-parity"
    };

    const prepared = await service.prepare(input);
    const written = await service.write({ ...input, dry_run: true });

    expect(written).toMatchObject({
      schema_version: prepared.schema_version,
      repo_id: prepared.repo_id,
      run_id: prepared.run_id,
      task_kind: prepared.task_kind,
      prompt_path: prepared.prompt_path,
      result_json_path: prepared.result_json_path,
      manifest_path: prepared.manifest_path,
      review_requirement: prepared.review_requirement,
      product_contract_sha256: prepared.product_contract_sha256,
      delegation_audit: prepared.delegation_audit,
      warnings: prepared.warnings,
      dry_run: true,
      written_paths: []
    });
  });

  test("technical tasks work in advisory mode without a product contract", async () => {
    const fixture = await repoFixture(false);
    const service = taskService(fixture.root);

    const result = await service.write(technicalTask());
    const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(fixture.root, result.manifest_path), "utf8")));

    expect(result.review_requirement).toBe("technical_only");
    expect(result.product_contract_sha256).toBeUndefined();
    expect(result.warnings).toContain("PRODUCT_CONTRACT_MISSING");
    expect(manifest.schema_version).toBe(3);
    if (manifest.schema_version !== 3) throw new Error("Expected v3 manifest.");
    expect(manifest.product_binding).toEqual({ kind: "not_required" });
    expect(manifest.delegation_audit.product_grounding).toBe("not_required");
  });

  test("product tasks fail when repository product grounding is missing", async () => {
    const fixture = await repoFixture(false);
    const service = taskService(fixture.root);

    await expect(service.prepare(productTask())).rejects.toMatchObject({
      code: "PRODUCT_CONTRACT_MISSING"
    });
  });

  test("persists advisory overspecification warnings through output, manifest, and prompt", async () => {
    const fixture = await repoFixture(true);
    const result = await taskService(fixture.root).write(overspecifiedProductTaskInput());
    const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(fixture.root, result.manifest_path), "utf8")));
    const prompt = await readFile(join(fixture.root, result.prompt_path), "utf8");

    expect(result.delegation_audit).toMatchObject({
      verdict: "passed_with_warnings",
      mode: "advisory",
      product_grounding: "complete",
      closed_world_risk: "high",
      overspecification_risk: "high",
      warnings: ["DELEGATION_CLOSED_WORLD_RISK", "DELEGATION_OVERSPECIFICATION_RISK"]
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      "DELEGATION_CLOSED_WORLD_RISK",
      "DELEGATION_OVERSPECIFICATION_RISK"
    ]));
    expect(manifest.schema_version).toBe(3);
    if (manifest.schema_version !== 3) throw new Error("Expected v3 manifest.");
    expect(manifest.delegation_audit).toEqual(result.delegation_audit);
    expect(prompt).toContain("## Delegation Audit");
    expect(prompt).toContain("- closed_world_risk: high");
    expect(prompt).toContain("- overspecification_risk: high");
  });

  test("persists justified security precision without overspecification warnings", async () => {
    const fixture = await repoFixture(true);
    const result = await taskService(fixture.root).write(securityTaskInput());
    const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(fixture.root, result.manifest_path), "utf8")));
    const prompt = await readFile(join(fixture.root, result.prompt_path), "utf8");

    expect(result.delegation_audit).toMatchObject({
      verdict: "passed",
      product_grounding: "not_required",
      closed_world_risk: "low",
      overspecification_risk: "low",
      warnings: []
    });
    expect(result.delegation_audit.signals).toEqual([
      expect.stringMatching(/^security\/migration precision confined to declared contracts:/)
    ]);
    expect(manifest.schema_version).toBe(3);
    if (manifest.schema_version !== 3) throw new Error("Expected v3 manifest.");
    expect(manifest.delegation_audit).toEqual(result.delegation_audit);
    expect(prompt).toContain("## Delegation Audit");
    expect(prompt).toContain("- product_grounding: not_required");
    expect(prompt).not.toContain("DELEGATION_OVERSPECIFICATION_RISK");
  });

  test("queued v3 task creation writes bounded handoff metadata without starting a runner", async () => {
    const fixture = await repoFixture(true);
    const service = taskService(fixture.root);

    const prepared = await service.prepare({
      ...technicalTask(),
      runner: { mode: "queued", requested_runner: "codex_sdk", max_runtime_ms: 30_000 }
    });
    const written = await service.write({
      ...technicalTask(),
      runner: { mode: "queued", requested_runner: "codex_sdk", max_runtime_ms: 30_000 }
    });
    const manifest = parseCodexRunManifest(JSON.parse(await readFile(join(fixture.root, written.manifest_path), "utf8")));

    expect(prepared.schema_version).toBe(3);
    expect(written.written_paths).toEqual([written.prompt_path, written.manifest_path, written.review_gate_path]);
    expect(manifest.schema_version).toBe(3);
    if (manifest.schema_version !== 3) throw new Error("Expected v3 manifest.");
    expect(manifest.task.runner).toEqual({
      mode: "queued",
      requested_runner: "codex_sdk",
      max_runtime_ms: 30_000
    });
    await expect(new AgentRunnerRunStore(fixture.root).readStatus(written.run_id)).resolves.toBeUndefined();
  });

  test("v3 service source is independent from legacy creation code", () => {
    const source = readFileSource("src/services/delegation-v3-task-service.ts");
    expect(source).not.toContain("codex-task-service");
    expect(source).not.toContain("codex-task-renderer");
    expect(source).not.toContain("legacy/codex-v2");
  });

  test("delegation artifacts use the canonical versioned manifest parser without a duplicate permissive contract", () => {
    const contractsSource = readFileSource("src/delegation/artifact-contracts.ts");
    const storeSource = readFileSource("src/delegation/run-store.ts");

    expect(AgentRunnerStatusSchema).toBeDefined();
    expect(contractsSource).not.toContain("export const AgentRunnerRunManifestSchema");
    expect(contractsSource).not.toContain("export type AgentRunnerRunManifest");
    expect(storeSource).toContain("parseCodexRunManifest");
  });

  test("historical compatibility stays available behind the explicit legacy boundary", () => {
    type LegacyManifestCompatibility = CodexRunManifestV2 extends CodexRunManifest ? true : false;
    const typeCompatibility: LegacyManifestCompatibility = true;

    expect(typeCompatibility).toBe(true);
    expect(CodexCorrectiveLineageSchema).toBeDefined();
    expect(CodexRunManifestV2Schema).toBeDefined();
    expect(renderCodexPrompt).toBeTypeOf("function");
    expect(renderCodexManifest).toBeTypeOf("function");
    expect(renderCodexManifestWithLineage).toBeTypeOf("function");
    expect(codexRunPaths).toBeTypeOf("function");
    expect(prepareCodexTaskHandler).toBeTypeOf("function");
    expect(writeCodexTaskHandler).toBeTypeOf("function");
    expect(codexRunPaths("2026-07-18T230000Z-compatibility")).toMatchObject({
      promptPath: ".chatgpt/codex-runs/2026-07-18T230000Z-compatibility/PROMPT.md",
      manifestPath: ".chatgpt/codex-runs/2026-07-18T230000Z-compatibility/run.json"
    });
  });
});

function taskService(root: string): DelegationV3TaskService {
  return new DelegationV3TaskService(
    root,
    new PathSandbox(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => FIXED_NOW
  );
}

async function repoFixture(withProductContract: boolean) {
  const fixture = await createRepoFixture();
  await writeFile(join(fixture.root, "README.md"), "# Fixture Operations\n");
  if (withProductContract) {
    await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(productContract(), null, 2)}\n`);
  }
  await execFileAsync("git", ["init"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["add", "--", "README.md", "docs/guide.md", "src/app.ts", ...(withProductContract ? ["docs/product-contract.json"] : [])], {
    cwd: fixture.root,
    env: { PATH: process.env.PATH ?? "" }
  });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: fixture.root, env: { PATH: process.env.PATH ?? "" } });
  return fixture;
}

function readFileSource(path: string): string {
  return readFileSync(path, "utf8");
}
