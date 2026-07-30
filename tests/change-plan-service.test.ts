import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ChangePlanService } from "../src/services/change-plan-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("ChangePlanService", () => {
  test("creates an evidence-grounded implementation plan", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "tests"), { recursive: true });
    await writeFile(join(fixture.root, "src", "validation.ts"), "export function validateFixture() { return true; }\n");
    await writeFile(join(fixture.root, "tests", "validation.test.ts"), "test('validation', () => {});\n");
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest",
        typecheck: "tsc --noEmit"
      }
    }, null, 2));

    const result = await new ChangePlanService(new PathSandbox(fixture.root)).plan({
      goal: "Add fixture validation",
      planning_depth: "standard"
    });

    expect(result.goal).toBe("Add fixture validation");
    expect(result.relevant_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/validation.ts" }),
      expect.objectContaining({ path: "tests/validation.test.ts" })
    ]));
    expect(result.proposed_steps.length).toBeGreaterThan(0);
    expect(result.test_strategy).toEqual(expect.arrayContaining([
      expect.stringContaining("targeted tests"),
      expect.stringContaining("typecheck")
    ]));
    expect(result.scan_complete).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test("uses import dependents and affected tests when ranking relevant files", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "tests"), { recursive: true });
    await writeFile(join(fixture.root, "src", "api.ts"), "export const api = true;\n");
    await writeFile(join(fixture.root, "src", "feature.ts"), "import { api } from './api';\nexport const feature = api;\n");
    await writeFile(join(fixture.root, "tests", "api.test.ts"), "import '../src/api';\n");

    const result = await new ChangePlanService(new PathSandbox(fixture.root)).plan({
      goal: "Change api behavior",
      include_globs: ["src/**/*.ts", "tests/**/*.ts"],
      max_files_to_inspect: 6
    });

    expect(result.relevant_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/api.ts", reason: expect.stringContaining("Path matches goal terms") }),
      expect.objectContaining({ path: "src/feature.ts", reason: expect.stringContaining("Depends on focused context") }),
      expect.objectContaining({ path: "tests/api.test.ts", reason: expect.stringContaining("Affected test") })
    ]));
    expect(result.test_strategy).toEqual(expect.arrayContaining([
      expect.stringContaining("affected tests")
    ]));
  });

  test("honors include globs and quick planning depth", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "alpha.ts"), "export const alpha = true;\n");
    await writeFile(join(fixture.root, "docs", "alpha.md"), "Alpha docs\n");

    const result = await new ChangePlanService(new PathSandbox(fixture.root)).plan({
      goal: "Change alpha behavior",
      include_globs: ["src/**/*.ts"],
      planning_depth: "quick"
    });

    expect(result.relevant_files.every((file) => file.path.startsWith("src/"))).toBe(true);
    expect(result.proposed_steps).toHaveLength(3);
  });

  test("keeps internal ChatGPT artifacts out of explicit-goal planning evidence", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, ".chatgpt", "codex-runs", "internal-run"), { recursive: true });
    await writeFile(join(fixture.root, ".chatgpt", "codex-runs", "internal-run", "PROMPT.md"), "Implement alpha behavior with exact matching terms.\n");
    await writeFile(join(fixture.root, "src", "alpha.ts"), "export const alpha = true;\n");

    const result = await new ChangePlanService(new PathSandbox(fixture.root)).plan({
      goal: "Implement alpha behavior"
    });

    expect(result.relevant_files.map((file) => file.path)).toContain("src/alpha.ts");
    expect(result.relevant_files.every((file) => !file.path.startsWith(".chatgpt/"))).toBe(true);
    expect(result.proposed_steps[0]).toMatchObject({
      title: "Anchor the chosen goal",
      description: expect.stringContaining("caller-supplied goal as authoritative")
    });
  });

  test("reports incomplete tree scans", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "many"), { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(fixture.root, "many", `file-${String(index).padStart(2, "0")}.ts`), "export const value = true;\n");
    }

    const result = await new ChangePlanService(new PathSandbox(fixture.root), {
      maxTreeEntries: 4,
      maxTreePages: 1
    }).plan({
      goal: "Change value",
      planning_depth: "deep"
    });

    expect(result.scan_complete).toBe(false);
    expect(result.warnings).toContain("TREE_SCAN_INCOMPLETE");
  });
});
