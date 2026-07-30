import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { TaskInventoryService } from "../src/services/task-inventory-service.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

class CountingSandbox extends PathSandbox {
  readonly resolvedPaths: string[] = [];

  override async resolve(repoPath: string) {
    this.resolvedPaths.push(repoPath);
    return super.resolve(repoPath);
  }
}

describe("TaskInventoryService", () => {
  test("finds TODO, FIXME, HACK, checkbox, and roadmap items", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "TODO.md"), [
      "# Tasks",
      "- [ ] Add onboarding flow",
      "- [x] Keep completed task visible",
      "Roadmap: support write tools later",
      ""
    ].join("\n"));
    await writeFile(join(fixture.root, "src", "tasks.ts"), [
      "export const value = 1;",
      "// TODO: tighten validation",
      "// FIXME: handle empty state",
      "// HACK: temporary fixture",
      ""
    ].join("\n"));

    const result = await new TaskInventoryService(new PathSandbox(fixture.root)).inventory();

    expect(result.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "TODO.md", line: 2, kind: "checkbox", text: "Add onboarding flow" }),
      expect.objectContaining({ path: "TODO.md", line: 3, kind: "checkbox", text: "Keep completed task visible" }),
      expect.objectContaining({ path: "TODO.md", line: 4, kind: "roadmap" }),
      expect.objectContaining({ path: "src/tasks.ts", line: 2, kind: "todo" }),
      expect.objectContaining({ path: "src/tasks.ts", line: 3, kind: "fixme" }),
      expect.objectContaining({ path: "src/tasks.ts", line: 4, kind: "hack" })
    ]));
    expect(result.matched_count).toBe(6);
    expect(result.returned_count).toBe(6);
    expect(result.scanned_file_count).toBeGreaterThanOrEqual(2);
    expect(result.scan_complete).toBe(true);
    expect(result.truncated).toBe(false);
  });

  test("supports labels, globs, and pagination", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "one.ts"), "// TODO: one\n// FIXME: two\n");
    await writeFile(join(fixture.root, "docs", "tasks.md"), "- [ ] docs task\n");

    const service = new TaskInventoryService(new PathSandbox(fixture.root));
    const first = await service.inventory({
      include_globs: ["src/**/*.ts"],
      labels: ["todo", "fixme"],
      max_results: 1
    });

    expect(first.tasks.map((task) => task.kind)).toEqual(["todo"]);
    expect(first.matched_count).toBe(2);
    expect(first.scan_complete).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe("1");

    const second = await service.inventory({
      include_globs: ["src/**/*.ts"],
      labels: ["todo", "fixme"],
      max_results: 1,
      cursor: first.next_cursor
    });

    expect(second.tasks.map((task) => task.kind)).toEqual(["fixme"]);
    expect(second.scan_complete).toBe(true);
    expect(second.truncated).toBe(false);
  });

  test("scans internal tree pages before paginating task results", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "many"), { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(fixture.root, "many", `file-${String(index).padStart(2, "0")}.ts`), "export const value = true;\n");
    }
    await writeFile(join(fixture.root, "many", "file-07.ts"), "// TODO: task past first tree page\n");

    const result = await new TaskInventoryService(new PathSandbox(fixture.root), {
      maxTreeEntries: 4
    }).inventory({
      include_globs: ["many/**/*.ts"]
    });

    expect(result.tasks).toEqual([
      expect.objectContaining({ path: "many/file-07.ts", kind: "todo" })
    ]);
    expect(result.matched_count).toBe(1);
    expect(result.scan_complete).toBe(true);
    expect(result.warnings).not.toContain("SCAN_TREE_PAGE_LIMIT_REACHED");
  });

  test("reports file limit instead of tree page limit when file cap stops scan first", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "many"), { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      await writeFile(join(fixture.root, "many", `file-${String(index).padStart(2, "0")}.ts`), "// TODO: task\n");
    }

    const result = await new TaskInventoryService(new PathSandbox(fixture.root), {
      maxFiles: 3,
      maxTreeEntries: 4
    }).inventory({
      include_globs: ["many/**/*.ts"]
    });

    expect(result.scan_complete).toBe(false);
    expect(result.warnings).toContain("SCAN_FILE_LIMIT_REACHED");
    expect(result.warnings).not.toContain("SCAN_TREE_PAGE_LIMIT_REACHED");
  });

  test("reports bounded file reads while scanning tasks", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "large.ts"), `// TODO: visible task\n${"x".repeat(130_000)}\n`);

    const result = await new TaskInventoryService(new PathSandbox(fixture.root)).inventory({
      include_globs: ["src/large.ts"]
    });

    expect(result.tasks).toEqual([
      expect.objectContaining({ path: "src/large.ts", kind: "todo" })
    ]);
    expect(result.scan_complete).toBe(true);
    expect(result.warnings).toContain("FILE_TRUNCATED:src/large.ts");
  });

  test("excludes internal ChatGPT artifacts from backlog discovery", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, ".chatgpt", "codex-runs", "internal-run"), { recursive: true });
    await writeFile(join(fixture.root, ".chatgpt", "codex-runs", "internal-run", "PROMPT.md"), "TODO: internal agent instruction\n");
    await writeFile(join(fixture.root, ".chatgpt", "backlog.md"), "- [ ] Internal local note\n");
    await writeFile(join(fixture.root, "TODO.md"), "- [ ] Public repository task\n");
    const sandbox = new CountingSandbox(fixture.root);

    const result = await new TaskInventoryService(sandbox).inventory();

    expect(result.tasks).toEqual([
      expect.objectContaining({ path: "TODO.md", text: "Public repository task" })
    ]);
    expect(result.tasks.every((task) => !task.path.startsWith(".chatgpt/"))).toBe(true);
    expect(sandbox.resolvedPaths).not.toContain(".chatgpt/backlog.md");
  });

  test("skips secret candidates, default excludes, and binary files", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, ".env"), "TODO=do-not-return\n");
    await writeFile(join(fixture.root, "node_modules", "pkg", "todo.js"), "// TODO: ignored dependency\n");
    await writeFile(join(fixture.root, "binary.bin"), Buffer.from([0, 1, 2, 3]));

    const result = await new TaskInventoryService(new PathSandbox(fixture.root)).inventory();

    expect(result.tasks.map((task) => task.path)).not.toContain(".env");
    expect(result.tasks.map((task) => task.path)).not.toContain("node_modules/pkg/todo.js");
    expect(result.tasks.map((task) => task.path)).not.toContain("binary.bin");
  });
});
