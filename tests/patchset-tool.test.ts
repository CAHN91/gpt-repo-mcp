import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { RootRegistry } from "../src/services/root-registry.js";
import type { PatchsetApplyResult, PatchsetPrepareResult, PatchsetReviewResult, PatchsetRollbackResult } from "../src/contracts/patchset.contract.js";
import { applyPatchsetHandler, preparePatchsetHandler, reviewPatchsetHandler, rollbackPatchsetHandler } from "../src/tools/handlers.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

const execFileAsync = promisify(execFile);

async function createContext() {
  const fixture = await createGitFixture();
  const registry = await RootRegistry.fromConfig({
    repos: [
      {
        repo_id: "fixture",
        display_name: "Fixture",
        root: fixture.root,
        writes: { enabled: true, allowed_globs: ["docs/**", "src/**"] },
        operations: { enabled: true, cleanup_enabled: true, cleanup_allowed_globs: ["docs/**", "src/**"] }
      }
    ],
    limits: {}
  });
  return { fixture, context: { registry } };
}

async function createGitFixture() {
  const fixture = await createRepoFixture();
  await execFileAsync("git", ["init"], { cwd: fixture.root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: fixture.root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: fixture.root });
  await execFileAsync("git", ["add", "."], { cwd: fixture.root });
  await execFileAsync("git", ["commit", "-m", "Initial"], { cwd: fixture.root });
  return fixture;
}

describe("patchset tools", () => {
  test("prepare apply and review patchset through handlers", async () => {
    const { fixture, context } = await createContext();
    const prepare = await preparePatchsetHandler({
      repo_id: "fixture",
      intent: "Patch docs and app",
      files: [
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true },
        {
          path: "src/app.ts",
          operation: "modify",
          content: "export function safeFetch() {\n  return fetch('/api/accounts');\n}\n"
        }
      ]
    }, context);
    const prepared = prepare.structuredContent as PatchsetPrepareResult;

    expect(prepare.isError).toBeUndefined();
    expect(prepared.patchset_id).toMatch(/^patchset-/);
    await expect(readFile(join(fixture.root, "docs", "new.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const apply = await applyPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id
    }, context);
    const applied = apply.structuredContent as PatchsetApplyResult;

    expect(apply.isError).toBeUndefined();
    expect(applied).toMatchObject({
      ok: true,
      patchset_id: prepared.patchset_id,
      changed_paths: ["docs/new.md", "src/app.ts"]
    });

    const review = await reviewPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id
    }, context);
    const reviewed = review.structuredContent as PatchsetReviewResult;

    expect(review.isError).toBeUndefined();
    expect(reviewed).toMatchObject({
      ok: true,
      patchset_id: prepared.patchset_id,
      applied: true,
      manifest_path: prepared.manifest_path,
      git_review: {
        ok: true,
        changed_paths: expect.arrayContaining([
          expect.objectContaining({ path: "docs/new.md" }),
          expect.objectContaining({ path: "src/app.ts" })
        ])
      }
    });
  });

  test("prepare apply review and rollback structured patchset through handlers", async () => {
    const { fixture, context } = await createContext();
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout.trim();

    const prepare = await preparePatchsetHandler({
      repo_id: "fixture",
      intent: "Structured handler workflow",
      base_head_sha: head,
      files: [
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true },
        { path: "docs/guide.md", operation: "modify", content: "# Changed\n" },
        {
          path: "src/app.ts",
          operation: "modify",
          content: "export function safeFetch() {\n  return fetch('/api/accounts');\n}\n"
        }
      ]
    }, context);
    const prepared = prepare.structuredContent as PatchsetPrepareResult;
    expect(prepare.isError).toBeUndefined();

    const apply = await applyPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    }, context);
    const applied = apply.structuredContent as PatchsetApplyResult;

    expect(apply.isError).toBeUndefined();
    expect(applied).toMatchObject({
      ok: true,
      patchset_id: prepared.patchset_id,
      changed_paths: ["docs/new.md", "docs/guide.md", "src/app.ts"],
      created_paths: ["docs/new.md"],
      modified_paths: ["docs/guide.md", "src/app.ts"]
    });

    const review = await reviewPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id
    }, context);
    const reviewed = review.structuredContent as PatchsetReviewResult;

    expect(review.isError).toBeUndefined();
    expect(reviewed).toMatchObject({
      ok: true,
      patchset_id: prepared.patchset_id,
      applied: true,
      rolled_back: false
    });

    const rollback = await rollbackPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    }, context);
    const rolledBack = rollback.structuredContent as PatchsetRollbackResult;

    expect(rollback.isError).toBeUndefined();
    expect(rolledBack).toMatchObject({
      ok: true,
      patchset_id: prepared.patchset_id,
      restored_paths: expect.arrayContaining(["docs/guide.md", "src/app.ts"]),
      deleted_paths: ["docs/new.md"]
    });
  });

  test("prepare apply review and rollback delete and rename through handlers", async () => {
    const { fixture, context } = await createContext();
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout.trim();

    const prepare = await preparePatchsetHandler({
      repo_id: "fixture",
      intent: "Structured delete rename workflow",
      base_head_sha: head,
      files: [
        { path: "docs/guide.md", operation: "delete" },
        { path: "src/app.ts", operation: "rename", new_path: "src/app-renamed.ts" }
      ]
    }, context);
    const prepared = prepare.structuredContent as PatchsetPrepareResult;
    expect(prepare.isError).toBeUndefined();
    expect(prepared.affected_paths).toEqual(["docs/guide.md", "src/app.ts", "src/app-renamed.ts"]);

    const apply = await applyPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    }, context);
    const applied = apply.structuredContent as PatchsetApplyResult;

    expect(apply.isError).toBeUndefined();
    expect(applied).toMatchObject({
      ok: true,
      deleted_paths: ["docs/guide.md"],
      renamed_paths: [{ from: "src/app.ts", to: "src/app-renamed.ts" }]
    });

    const review = await reviewPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id
    }, context);
    const reviewed = review.structuredContent as PatchsetReviewResult;

    expect(review.isError).toBeUndefined();
    expect(reviewed).toMatchObject({
      ok: true,
      applied: true,
      rolled_back: false
    });

    const rollback = await rollbackPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    }, context);
    const rolledBack = rollback.structuredContent as PatchsetRollbackResult;

    expect(rollback.isError).toBeUndefined();
    expect(rolledBack).toMatchObject({
      ok: true,
      restored_paths: ["docs/guide.md", "src/app.ts"],
      deleted_paths: ["src/app-renamed.ts"]
    });
  });

  test("prepare apply review and rollback structured edit hunks through handlers", async () => {
    const { fixture, context } = await createContext();
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixture.root })).stdout.trim();

    const prepare = await preparePatchsetHandler({
      repo_id: "fixture",
      intent: "Structured edit workflow",
      base_head_sha: head,
      files: [
        {
          path: "src/app.ts",
          operation: "edit",
          hunks: [
            { find: "rawFetch", replace: "safeFetch" },
            { find: "/api/users", replace: "/api/accounts" }
          ]
        }
      ]
    }, context);
    const prepared = prepare.structuredContent as PatchsetPrepareResult;
    expect(prepare.isError).toBeUndefined();
    expect(prepared.manifest.files[0]).toMatchObject({ operation: "edit", hunk_count: 2 });

    const apply = await applyPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    }, context);
    const applied = apply.structuredContent as PatchsetApplyResult;

    expect(apply.isError).toBeUndefined();
    expect(applied).toMatchObject({
      ok: true,
      changed_paths: ["src/app.ts"],
      modified_paths: ["src/app.ts"],
      hunk_diagnostics: [
        { path: "src/app.ts", hunk_index: 0, status: "matched", occurrences: 1 },
        { path: "src/app.ts", hunk_index: 1, status: "matched", occurrences: 1 }
      ]
    });
    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toContain("safeFetch");

    const review = await reviewPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id
    }, context);
    expect(review.isError).toBeUndefined();

    const rollback = await rollbackPatchsetHandler({
      repo_id: "fixture",
      patchset_id: prepared.patchset_id,
      expected_head_sha: head
    }, context);
    const rolledBack = rollback.structuredContent as PatchsetRollbackResult;

    expect(rollback.isError).toBeUndefined();
    expect(rolledBack).toMatchObject({
      ok: true,
      restored_paths: ["src/app.ts"],
      deleted_paths: []
    });
  });
});
