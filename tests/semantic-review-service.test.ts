import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { SemanticReviewService } from "../src/services/semantic-review-service.js";

const execFileAsync = promisify(execFile);

describe("SemanticReviewService", () => {
  test("returns concrete contract, schema, config, async, and test-gap findings", async () => {
    const root = await baseFixture();
    await writeFile(join(root, "src", "api.ts"), [
      "export function handle(): string {",
      "  Promise.resolve().catch(() => {});",
      "  return process.env.NEW_API_MODE ?? 'ok';",
      "}"
    ].join("\n"));

    const result = await review(root);
    const categories = result.findings.map((finding) => finding.category);
    expect(categories).toEqual(expect.arrayContaining(["public_contract", "api_schema", "configuration", "async_error", "test_gap"]));
    const contract = result.findings.find((finding) => finding.category === "public_contract");
    expect(contract).toMatchObject({ priority: "high", confidence: "high", blocks_ship: true, path: "src/api.ts" });
    expect(contract?.affected_symbols).toContain("ApiResponse");
    expect(contract?.related_paths).toContain("tests/api.test.ts");
    expect(result.ship_readiness.status).toBe("review_required");
    expect(result.summary.blocking).toBeGreaterThan(0);
  });

  test("detects schema changes without migrations and authorization control-flow changes", async () => {
    const root = await baseFixture();
    await writeFile(join(root, "src", "database.schema.ts"), "export interface Account { id: string; tenantId: string }\n");
    await writeFile(join(root, "src", "auth.ts"), "export function authorize(role: string): boolean { if (role === 'admin') return true; return false; }\n");
    await execFileAsync("git", ["add", "src/database.schema.ts", "src/auth.ts"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "add risk fixtures"], { cwd: root });
    await writeFile(join(root, "src", "database.schema.ts"), "export interface Account { id: string; tenantId: string; region: string }\n");
    await writeFile(join(root, "src", "auth.ts"), "export function authorize(role: string): boolean { if (role !== 'guest') return true; return false; }\n");

    const result = await review(root);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "migration", path: "src/database.schema.ts" }),
      expect.objectContaining({ category: "authorization", path: "src/auth.ts" })
    ]));
  });

  test("does not report semantic findings for a pure internal file rename", async () => {
    const root = await baseFixture();
    await writeFile(join(root, "src", "internal.ts"), "function localOnly(): number { return 1; }\nexport { localOnly };\n");
    await execFileAsync("git", ["add", "src/internal.ts"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "add internal"], { cwd: root });
    await execFileAsync("git", ["mv", "src/internal.ts", "src/internal-renamed.ts"], { cwd: root });

    const result = await review(root, { paths: ["src/internal-renamed.ts"] });
    expect(result.findings).toEqual([]);
    expect(result.ship_readiness.status).toBe("ready");
  });

  test("links failed validation to failure diagnosis without treating low-confidence findings as blockers", async () => {
    const root = await baseFixture();
    await writeFile(join(root, "src", "api.ts"), "export interface ApiResponse { ok: boolean }\nexport function handle(): string { return 'changed'; }\n");
    const validationId = "validation-semantic";
    const artifactPath = `.chatgpt/validation/${validationId}/result.json`;
    await mkdir(join(root, ".chatgpt", "validation", validationId), { recursive: true });
    await writeFile(join(root, artifactPath), JSON.stringify({ validation_id: validationId, status: "failed", commands: [] }));
    await writeFile(join(root, ".chatgpt", "validation", "latest.json"), JSON.stringify({ artifact_path: artifactPath }));

    const result = await review(root, { categories: ["test_gap"] });
    expect(result.findings.every((finding) => finding.blocks_ship === false)).toBe(true);
    expect(result.ship_readiness).toMatchObject({ status: "review_required", validation_status: "failed", blocking_finding_ids: [] });
    expect(result.next_tool_payloads.repo_failure_diagnose).toEqual({ repo_id: "fixture" });
  });
});

async function review(root: string, options: { paths?: string[]; categories?: Array<"test_gap"> } = {}) {
  return new SemanticReviewService(root, new PathSandbox(root)).review({ repo_id: "fixture", ...options });
}

async function baseFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gpt-semantic-review-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src", "api.ts"), [
    "export interface ApiResponse { ok: boolean }",
    "export function handle(): string { return 'ok'; }"
  ].join("\n"));
  await writeFile(join(root, "tests", "api.test.ts"), "import { handle } from '../src/api.js';\nexport function exercise(): string { return handle(); }\n");
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "fixture@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await execFileAsync("git", ["add", "src", "tests"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}
