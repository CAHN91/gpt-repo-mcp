import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { FailureDiagnoseService } from "../src/services/failure-diagnose-service.js";
import { OperationsPolicy } from "../src/services/operations-policy.js";
import { PathSandbox } from "../src/services/path-sandbox.js";

const execFileAsync = promisify(execFile);

describe("FailureDiagnoseService", () => {
  test("normalizes validation evidence and correlates changes, symbols, work state, and allowed tests", async () => {
    const root = await fixture();
    const result = await service(root).diagnose({ repo_id: "fixture" });

    expect(result.validation).toMatchObject({ found: true, validation_id: "validation-fixture", status: "failed" });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "typescript", code: "TS2322", path: "src/service.ts", line: 2 })
    ]));
    expect(result.candidates[0]).toMatchObject({ path: "src/service.ts", confidence: "high" });
    expect(result.candidates[0]?.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining("Diagnostic typescript TS2322"),
      "Diagnostic location overlaps an added or changed line in the current diff.",
      "Path is changed in the current worktree.",
      "Path is linked from the current work session or latest write receipt."
    ]));
    expect(result.candidates[0]?.symbols).toContain("compute");
    expect(result.next_tool_payloads.repo_symbol_context?.paths).toEqual(["src/service.ts"]);
    expect(result.next_tool_payloads.repo_validate?.test_paths).toContain("tests/service.test.ts");
    expect(result.correlations.touched_paths).toContain("src/service.ts");
  });

  test("does not suggest focused validation when repository policy does not allow test paths", async () => {
    const root = await fixture();
    const result = await new FailureDiagnoseService(root, new PathSandbox(root), new OperationsPolicy({ enabled: true, validation_enabled: true }))
      .diagnose({ repo_id: "fixture" });
    expect(result.next_tool_payloads.repo_validate).toBeUndefined();
  });
});

function service(root: string): FailureDiagnoseService {
  return new FailureDiagnoseService(root, new PathSandbox(root), new OperationsPolicy({
    enabled: true,
    validation_enabled: true,
    validation_test_path_globs: ["tests/**"]
  }));
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gpt-failure-diagnose-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src", "service.ts"), "export function compute(): number {\n  return 1;\n}\n");
  await writeFile(join(root, "tests", "service.test.ts"), "import { compute } from '../src/service.js';\nexport function exercise(): number { return compute(); }\n");
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "fixture@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await execFileAsync("git", ["add", "src", "tests"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });
  await writeFile(join(root, "src", "service.ts"), "export function compute(): number {\n  return 'wrong';\n}\n");

  const validationId = "validation-fixture";
  const validationPath = `.chatgpt/validation/${validationId}/result.json`;
  await mkdir(join(root, ".chatgpt", "validation", validationId), { recursive: true });
  await writeFile(join(root, validationPath), JSON.stringify({
    schema_version: 1,
    validation_id: validationId,
    repo_id: "fixture",
    profile: "typecheck",
    status: "failed",
    commands: [{ stderr_tail: "src/service.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'." }]
  }));
  await writeFile(join(root, ".chatgpt", "validation", "latest.json"), JSON.stringify({ artifact_path: validationPath }));

  const workSessionId = "failure-session";
  const sessionPath = `.chatgpt/work-sessions/${workSessionId}.json`;
  await mkdir(join(root, ".chatgpt", "work-sessions"), { recursive: true });
  await writeFile(join(root, sessionPath), JSON.stringify({
    schema_version: 1,
    work_session_id: workSessionId,
    repo_id: "fixture",
    title: "Failure session",
    objective: "Diagnose type failure",
    status: "active",
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z",
    constraints: [], files_inspected: [], decisions: [], assumptions: [],
    touched_files: ["src/service.ts"], pending_patchsets: [], validation_results: [], unresolved_risks: [],
    next_action: "Diagnose", warnings: []
  }));
  await writeFile(join(root, ".chatgpt", "work-sessions", "current.json"), JSON.stringify({ session_path: sessionPath }));
  return root;
}
