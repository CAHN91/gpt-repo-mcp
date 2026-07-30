import { describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { RepoTreeService } from "../src/services/repo-tree-service.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

class CountingSandbox extends PathSandbox {
  readonly resolvedPaths: string[] = [];

  override async resolve(repoPath: string) {
    this.resolvedPaths.push(repoPath);
    return super.resolve(repoPath);
  }
}

describe("RepoTreeService", () => {
  test("returns structure without file contents and summarizes default excludes", async () => {
    const fixture = await createRepoFixture();
    const sandbox = new PathSandbox(fixture.root);
    const result = await new RepoTreeService(sandbox).tree({ include_files: true });

    expect(result.entries).toContainEqual({ path: "src/app.ts", type: "file", size_bytes: expect.any(Number) });
    expect(result.entries.some((entry) => "text" in entry)).toBe(false);
    expect(result.entries.some((entry) => entry.path.startsWith("node_modules/"))).toBe(false);
    expect(result.excluded_summary.default_excludes).toBeGreaterThan(0);
  });

  test("reports nested repos and submodules without recursing into them", async () => {
    const fixture = await createRepoFixture();
    const sandbox = new PathSandbox(fixture.root);
    const result = await new RepoTreeService(sandbox).tree({ include_files: true });

    expect(result.entries).toContainEqual({ path: "vendor/nested", type: "nested_repo" });
    expect(result.entries).toContainEqual({ path: "vendor/submodule", type: "submodule" });
    expect(result.entries.some((entry) => entry.path === "vendor/nested/index.ts")).toBe(false);
    expect(result.entries.some((entry) => entry.path === "vendor/submodule/README.md")).toBe(false);
  });

  test("respects max_depth", async () => {
    const fixture = await createRepoFixture();
    const sandbox = new PathSandbox(fixture.root);
    const result = await new RepoTreeService(sandbox).tree({ max_depth: 1, include_files: true });

    expect(result.entries).toContainEqual({ path: "src", type: "directory" });
    expect(result.entries.some((entry) => entry.path === "src/app.ts")).toBe(false);
  });

  test("paginates deterministic tree entries with cursor", async () => {
    const fixture = await createRepoFixture();
    const sandbox = new PathSandbox(fixture.root);
    const service = new RepoTreeService(sandbox);

    const first = await service.tree({ include_files: true, page_size: 3 });
    expect(first.entries.map((entry) => entry.path)).toEqual(["binary.bin", "docs", "docs/guide.md"]);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toMatch(/^v2:/);

    const second = await service.tree({ include_files: true, page_size: 3, cursor: first.next_cursor });
    expect(second.entries.map((entry) => entry.path)).toEqual(["src", "src/admin.controller.ts", "src/app.ts"]);
    expect(second.truncated).toBe(true);
    expect(second.next_cursor).toMatch(/^v2:/);
  });

  test("continues to accept legacy numeric cursors", async () => {
    const fixture = await createRepoFixture();
    const sandbox = new PathSandbox(fixture.root);
    const result = await new RepoTreeService(sandbox).tree({
      include_files: true,
      page_size: 3,
      cursor: "3"
    });

    expect(result.entries.map((entry) => entry.path)).toEqual(["src", "src/admin.controller.ts", "src/app.ts"]);
    expect(result.next_cursor).toMatch(/^v2:/);
  });

  test("respects include_generated and include_dependencies flags", async () => {
    const fixture = await createRepoFixture();
    const sandbox = new PathSandbox(fixture.root);
    const service = new RepoTreeService(sandbox);

    const defaults = await service.tree({ include_files: true });
    expect(defaults.entries.some((entry) => entry.path === "dist/bundle.js")).toBe(false);
    expect(defaults.entries.some((entry) => entry.path === "node_modules/pkg/index.js")).toBe(false);

    const included = await service.tree({
      include_files: true,
      include_generated: true,
      include_dependencies: true
    });
    expect(included.entries.some((entry) => entry.path === "dist/bundle.js")).toBe(true);
    expect(included.entries.some((entry) => entry.path === "node_modules/pkg/index.js")).toBe(true);
  });

  test("returns useful excluded summary keys", async () => {
    const fixture = await createRepoFixture();
    const sandbox = new PathSandbox(fixture.root);
    const result = await new RepoTreeService(sandbox).tree({ include_files: true });

    expect(result.excluded_summary).toMatchObject({
      default_excludes: expect.any(Number),
      dependencies: expect.any(Number),
      generated: expect.any(Number),
      secret_candidates: expect.any(Number)
    });
  });

  test("bounds large trees with page_size before reading everything", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "many"), { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(fixture.root, "many", `file-${index}.ts`), `export const value${index} = ${index};\n`);
    }

    const result = await new RepoTreeService(new PathSandbox(fixture.root)).tree({
      path: "many",
      include_files: true,
      page_size: 4
    });

    expect(result.entries.map((entry) => entry.path)).toEqual([
      "many",
      "many/file-0.ts",
      "many/file-1.ts",
      "many/file-2.ts"
    ]);
    expect(result.truncated).toBe(true);
    expect(result.next_cursor).toMatch(/^v2:/);
  });

  test("stops resolving entries after it has enough for the requested page", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "many"), { recursive: true });
    for (let index = 0; index < 100; index += 1) {
      await writeFile(join(fixture.root, "many", `file-${String(index).padStart(3, "0")}.ts`), "export {};\n");
    }
    const sandbox = new CountingSandbox(fixture.root);

    const result = await new RepoTreeService(sandbox).tree({
      path: "many",
      include_files: true,
      page_size: 3
    });

    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(sandbox.resolvedPaths.length).toBeLessThan(20);
  });

  test("prunes consumer-excluded prefixes before resolving their descendants", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, ".chatgpt", "backlog"), { recursive: true });
    await writeFile(join(fixture.root, ".chatgpt", "backlog", "noise.ts"), "export {};\n");
    const sandbox = new CountingSandbox(fixture.root);

    const result = await new RepoTreeService(sandbox).tree({
      include_files: true,
      page_size: 100,
      exclude_prefixes: [".chatgpt"]
    });

    expect(result.entries.every((entry) => !entry.path.startsWith(".chatgpt"))).toBe(true);
    expect(sandbox.resolvedPaths.every((path) => !path.startsWith(".chatgpt"))).toBe(true);
    expect(result.excluded_summary.consumer_excludes).toBeGreaterThan(0);
  });
});
