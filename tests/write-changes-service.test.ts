import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WriteChangesService } from "../src/services/write-changes-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy, type WritePolicyConfig } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

class FailAfterMarkerSandbox extends PathSandbox {
  constructor(
    root: string,
    private readonly markerPath: string,
    private readonly failedPath: string
  ) {
    super(root);
  }

  override async resolve(repoPath: string) {
    if (repoPath === this.failedPath) {
      try {
        await access(this.markerPath);
        throw new Error("Injected filesystem failure");
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
    return super.resolve(repoPath);
  }
}

class MutateOnSecondResolveSandbox extends PathSandbox {
  private resolves = 0;

  constructor(root: string, private readonly targetPath: string) {
    super(root);
  }

  override async resolve(repoPath: string) {
    const resolved = await super.resolve(repoPath);
    if (repoPath === "docs/guide.md") {
      this.resolves += 1;
      if (this.resolves === 2) {
        await writeFile(this.targetPath, "external change\n");
      }
    }
    return resolved;
  }
}

describe("WriteChangesService", () => {
  test("multi-file write creates two new files", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true });

    const result = await service.apply({
      changes: [
        { type: "write", path: "docs/one.md", content: "One\n" },
        { type: "write", path: "docs/two.md", content: "Two\n" }
      ]
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: false,
      changed_paths: ["docs/one.md", "docs/two.md"],
      counts: {
        requested: 2,
        changed: 2,
        created: 2,
        unchanged: 0
      },
      summary: "Applied 2 changes across 2 files.",
      warnings: [],
      next_steps: [
        "Run repo_git_review to inspect the resulting diff.",
        "If the edit pack is wrong, use the repo_write_recover payload returned by repo_git_review.",
        "If the diff is good, use the repo_write_stage_commit payload returned by repo_git_review."
      ]
    });
    expect(result.files.map((file) => ({
      path: file.path,
      type: file.type,
      changed: file.changed,
      created: file.created
    }))).toEqual([
      { path: "docs/one.md", type: "write", changed: true, created: true },
      { path: "docs/two.md", type: "write", changed: true, created: true }
    ]);
    await expect(readFile(join(fixture.root, "docs", "one.md"), "utf8")).resolves.toBe("One\n");
    await expect(readFile(join(fixture.root, "docs", "two.md"), "utf8")).resolves.toBe("Two\n");
  });

  test("mixes write append and replace", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["docs/**", "src/**"] });

    const result = await service.apply({
      changes: [
        { type: "write", path: "docs/new.md", content: "New\n" },
        { type: "append", path: "docs/guide.md", content: "Appended\n" },
        { type: "replace", path: "src/app.ts", find: "rawFetch", replace: "safeFetch" }
      ]
    });

    expect(result.changed_paths).toEqual(["docs/new.md", "docs/guide.md", "src/app.ts"]);
    expect(result.counts).toMatchObject({ requested: 3, changed: 3, created: 1, unchanged: 0 });
    await expect(readFile(join(fixture.root, "docs", "new.md"), "utf8")).resolves.toBe("New\n");
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nSearchable docs\nAppended\n");
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("safeFetch");
  });

  test("rejects stale per-change expected_old_sha256 before applying any changes", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["docs/**", "src/**"] });

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/new.md", content: "New\n" },
        { type: "replace", path: "src/app.ts", find: "rawFetch", replace: "safeFetch", expected_old_sha256: "0".repeat(64) }
      ]
    })).rejects.toMatchObject({
      code: "WRITE_STALE_EXPECTED_SHA",
      diagnostics: {
        failed_path: "src/app.ts",
        expected_old_sha256: "0".repeat(64)
      }
    });

    await expect(access(join(fixture.root, "docs", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("rawFetch");
  });

  test("grouped edit applies two replacements to one file result", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["src/**"] });

    const result = await service.apply({
      changes: [
        {
          type: "edit",
          path: "src/app.ts",
          edits: [
            { type: "replace", find: "rawFetch", replace: "safeFetch" },
            { type: "replace", find: "fetch('/api/users')", replace: "fetch('/api/accounts')" }
          ]
        }
      ]
    });

    expect(result.changed_paths).toEqual(["src/app.ts"]);
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "src/app.ts",
        type: "edit",
        changed: true,
        created: false,
        summary: "Applied 2 edits to src/app.ts."
      })
    ]);
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toBe([
      "export function safeFetch() {",
      "  return fetch('/api/accounts');",
      "}",
      ""
    ].join("\n"));
  });

  test("grouped edit applies replace insert_before and insert_after in order", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["src/**"] });

    await service.apply({
      changes: [
        {
          type: "edit",
          path: "src/app.ts",
          edits: [
            { type: "replace", find: "rawFetch", replace: "safeFetch" },
            { type: "insert_after", find: "export function safeFetch() {", content: "\n  const enabled = true;" },
            { type: "insert_before", find: "  return fetch('/api/users');", content: "  const route = '/api/users';\n" }
          ]
        }
      ]
    });

    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toBe([
      "export function safeFetch() {",
      "  const enabled = true;",
      "  const route = '/api/users';",
      "  return fetch('/api/users');",
      "}",
      ""
    ].join("\n"));
  });

  test("dry_run writes nothing but returns changed paths files and counts", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true });

    const result = await service.apply({
      dry_run: true,
      changes: [
        { type: "write", path: "docs/dry.md", content: "Dry\n" },
        { type: "append", path: "docs/guide.md", content: "Preview\n" }
      ]
    });

    expect(result.dry_run).toBe(true);
    expect(result.changed_paths).toEqual(["docs/dry.md", "docs/guide.md"]);
    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.bytes_written === 0)).toBe(true);
    expect(result.counts).toEqual({ requested: 2, changed: 2, created: 1, unchanged: 0 });
    await expect(access(join(fixture.root, "docs", "dry.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nSearchable docs\n");
  });

  test("dry_run does not create missing parent directories", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["generated/**"] });

    await service.apply({
      dry_run: true,
      changes: [
        { type: "write", path: "generated/nested/preview.md", content: "Preview\n" }
      ]
    });

    await expect(access(join(fixture.root, "generated"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("no-op write increments unchanged count", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true });

    const result = await service.apply({
      changes: [
        { type: "write", path: "docs/guide.md", content: "# Guide\nSearchable docs\n" }
      ]
    });

    expect(result.changed_paths).toEqual([]);
    expect(result.counts).toEqual({ requested: 1, changed: 0, created: 0, unchanged: 1 });
    expect(result.summary).toBe("No changes across 1 requested file.");
  });

  test("hard-risk path is blocked", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["**"] });

    await expect(service.apply({
      changes: [
        { type: "write", path: "secrets/notes.md", content: "not secret\n" }
      ]
    })).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
  });

  test("secret resulting content is blocked", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true });

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/secret-management.md", content: "OPENAI_API_KEY=sk-realSecretValue123\n" }
      ]
    })).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
  });

  test("replace requires find", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true });

    await expect(service.apply({
      changes: [
        { type: "replace", path: "docs/guide.md", replace: "Updated" }
      ]
    })).rejects.toMatchObject({ code: "WRITE_FIND_REQUIRED" });
  });

  test("grouped edit requires find", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["src/**"] });

    await expect(service.apply({
      changes: [
        {
          type: "edit",
          path: "src/app.ts",
          edits: [{ type: "replace", replace: "safeFetch" }]
        }
      ]
    })).rejects.toMatchObject({ code: "WRITE_FIND_REQUIRED" });
  });

  test("grouped edit requires replace or content", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["src/**"] });

    await expect(service.apply({
      changes: [
        {
          type: "edit",
          path: "src/app.ts",
          edits: [
            { type: "replace", find: "rawFetch" },
            { type: "insert_after", find: "export function rawFetch() {" }
          ]
        }
      ]
    })).rejects.toMatchObject({ code: "WRITE_CONTENT_REQUIRED" });
  });

  test("grouped edit find not found does not write target", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["src/**"] });

    await expect(service.apply({
      changes: [
        {
          type: "edit",
          path: "src/app.ts",
          edits: [
            { type: "replace", find: "rawFetch", replace: "safeFetch" },
            { type: "replace", find: "missingNeedle", replace: "never" }
          ]
        }
      ]
    })).rejects.toMatchObject({ code: "WRITE_FIND_NOT_FOUND" });
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("rawFetch");
  });

  test("ambiguous find fails", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true });
    await writeFile(join(fixture.root, "docs", "guide.md"), "needle\nneedle\n");

    await expect(service.apply({
      changes: [
        { type: "replace", path: "docs/guide.md", find: "needle", replace: "value" }
      ]
    })).rejects.toMatchObject({ code: "WRITE_FIND_NOT_UNIQUE" });
  });

  test("grouped edit ambiguous find fails", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["docs/**"] });
    await writeFile(join(fixture.root, "docs", "guide.md"), "needle\nneedle\n");

    await expect(service.apply({
      changes: [
        {
          type: "edit",
          path: "docs/guide.md",
          edits: [{ type: "replace", find: "needle", replace: "value" }]
        }
      ]
    })).rejects.toMatchObject({ code: "WRITE_FIND_NOT_UNIQUE" });
  });

  test("grouped edit missing file fails", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["src/**"] });

    await expect(service.apply({
      changes: [
        {
          type: "edit",
          path: "src/missing.ts",
          edits: [{ type: "replace", find: "needle", replace: "value" }]
        }
      ]
    })).rejects.toMatchObject({ code: "WRITE_TARGET_MISSING" });
  });

  test("grouped edit invalid UTF-8 target fails", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["docs/**"] });
    await writeFile(join(fixture.root, "docs", "invalid.md"), Buffer.from([0xc3, 0x28]));

    await expect(service.apply({
      changes: [
        {
          type: "edit",
          path: "docs/invalid.md",
          edits: [{ type: "replace", find: "needle", replace: "value" }]
        }
      ]
    })).rejects.toMatchObject({ code: "BINARY_FILE_REJECTED" });
  });

  test("grouped edit does not bypass top-level duplicate path guard", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["src/**"] });

    await expect(service.apply({
      changes: [
        {
          type: "edit",
          path: "src/app.ts",
          edits: [{ type: "replace", find: "rawFetch", replace: "safeFetch" }]
        },
        { type: "write", path: "src/app.ts", content: "export const overwritten = true;\n" }
      ]
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("prevalidates the entire pack before changing any file", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["docs/**", "src/**"] });

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/applied-a.md", content: "A\n" },
        { type: "append", path: "docs/guide.md", content: "Applied\n" },
        { type: "replace", path: "src/app.ts", find: "missingNeedle", replace: "safeFetch" }
      ]
    })).rejects.toMatchObject({
      code: "WRITE_FIND_NOT_FOUND",
      diagnostics: {}
    });
    await expect(access(join(fixture.root, "docs", "applied-a.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nSearchable docs\n");
  });

  test("prevalidates grouped edits before changing earlier paths", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["docs/**", "src/**"] });

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/applied-a.md", content: "A\n" },
        {
          type: "edit",
          path: "src/app.ts",
          edits: [
            { type: "replace", find: "rawFetch", replace: "safeFetch" },
            { type: "replace", find: "missingNeedle", replace: "never" }
          ]
        }
      ]
    })).rejects.toMatchObject({
      code: "WRITE_FIND_NOT_FOUND",
      diagnostics: {}
    });
    await expect(access(join(fixture.root, "docs", "applied-a.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("rawFetch");
  });

  test("rolls back earlier writes when a later filesystem operation fails", async () => {
    const fixture = await createRepoFixture();
    const markerPath = join(fixture.root, "docs", "atomic-marker.md");
    const sandbox = new FailAfterMarkerSandbox(fixture.root, markerPath, "docs/guide.md");
    const service = new WriteChangesService(
      fixture.root,
      sandbox,
      new WritePolicy({ enabled: true, allowed_globs: ["docs/**"] })
    );

    await expect(service.apply({
      changes: [
        { type: "write", path: "./docs/atomic-marker.md", content: "temporary\n" },
        { type: "append", path: "docs/guide.md", content: "never\n" }
      ]
    })).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Atomic edit pack failed and was rolled back.",
      diagnostics: {
        rolled_back_paths: ["docs/atomic-marker.md"],
        failed_path: "docs/guide.md"
      }
    });

    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nSearchable docs\n");
  });

  test("rejects target drift between prevalidation and apply", async () => {
    const fixture = await createRepoFixture();
    const targetPath = join(fixture.root, "docs", "guide.md");
    const service = new WriteChangesService(
      fixture.root,
      new MutateOnSecondResolveSandbox(fixture.root, targetPath),
      new WritePolicy({ enabled: true, allowed_globs: ["docs/**"] })
    );

    await expect(service.apply({
      changes: [
        { type: "append", path: "docs/guide.md", content: "pack change\n" }
      ]
    })).rejects.toMatchObject({
      code: "WRITE_STALE_EXPECTED_SHA"
    });

    await expect(readFile(targetPath, "utf8")).resolves.toBe("external change\n");
  });

  test("invalid UTF-8 edit target fails", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true });
    await writeFile(join(fixture.root, "docs", "invalid.md"), Buffer.from([0xc3, 0x28]));

    await expect(service.apply({
      changes: [
        { type: "append", path: "docs/invalid.md", content: "text\n" }
      ]
    })).rejects.toMatchObject({ code: "BINARY_FILE_REJECTED" });
  });

  test("batch change limit is enforced", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true });

    await expect(service.apply({
      changes: Array.from({ length: 26 }, (_, index) => ({
        type: "write",
        path: `docs/${index}.md`,
        content: `${index}\n`
      }))
    })).rejects.toMatchObject({ code: "SIZE_LIMIT_EXCEEDED" });
  });

  test("batch content payload limit is enforced", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, {
      enabled: true,
      max_bytes_per_write: 10 * 1024 * 1024
    });

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/large.md", content: "x".repeat(5 * 1024 * 1024 + 1) }
      ]
    })).rejects.toMatchObject({ code: "SIZE_LIMIT_EXCEEDED" });
  });
});

function createService(root: string, policy: WritePolicyConfig) {
  return new WriteChangesService(root, new PathSandbox(root), new WritePolicy(policy));
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
