import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PatchsetManifestStore, patchsetAffectedPaths } from "../src/services/patchset-manifest-store.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("PatchsetManifestStore", () => {
  test("prepares and reads patchset manifests without touching target files", async () => {
    const fixture = await createRepoFixture();
    const store = new PatchsetManifestStore(fixture.root, new WritePolicy({
      enabled: true,
      allowed_globs: ["docs/**", "src/**"]
    }));

    const prepared = await store.prepare({
      repo_id: "fixture",
      intent: "Update docs",
      base_head_sha: "a".repeat(40),
      files: [
        { path: "docs/new.md", operation: "create", content: "New\n", expected_missing: true },
        { path: "src/app.ts", operation: "modify", content: "Changed\n" }
      ]
    });

    expect(prepared.patchset_id).toMatch(/^patchset-/);
    expect(prepared.manifest_path).toBe(`.chatgpt/patchsets/${prepared.patchset_id}/manifest.json`);
    expect(prepared.affected_paths).toEqual(["docs/new.md", "src/app.ts"]);
    expect(prepared.manifest.counts).toEqual({ files: 2, creates: 1, modifies: 1, deletes: 0, renames: 0, edits: 0 });
    await expect(access(join(fixture.root, "docs", "new.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const stored = await store.read(prepared.patchset_id);

    expect(stored).toMatchObject({
      manifest_path: prepared.manifest_path,
      manifest: {
        patchset_id: prepared.patchset_id,
        repo_id: "fixture",
        intent: "Update docs"
      }
    });
    await expect(readFile(join(fixture.root, prepared.manifest_path), "utf8")).resolves.toContain(prepared.patchset_id);
  });

  test("reports affected paths including rename destinations", () => {
    expect(patchsetAffectedPaths([
      { path: "docs/a.md", operation: "delete" },
      { path: "docs/old.md", operation: "rename", new_path: "docs/new.md" }
    ])).toEqual(["docs/a.md", "docs/old.md", "docs/new.md"]);
  });
});
