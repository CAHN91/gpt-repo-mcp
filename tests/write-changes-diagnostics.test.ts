import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WriteChangesService } from "../src/services/write-changes-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy, type WritePolicyConfig } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("WriteChangesService diagnostics", () => {
  test("unsafe paths fail prevalidation before earlier changes are applied", async () => {
    const fixture = await createRepoFixture();
    const service = createService(fixture.root, { enabled: true, allowed_globs: ["docs/**"] });
    const unsafePath = ["..", "outside.md"].join("/");

    await expect(service.apply({
      changes: [
        { type: "write", path: "docs/applied-a.md", content: "A\n" },
        { type: "write", path: unsafePath, content: "outside\n" }
      ]
    })).rejects.toMatchObject({
      code: "PATH_TRAVERSAL_REJECTED",
      diagnostics: {}
    });
    await expect(access(join(fixture.root, "docs", "applied-a.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function createService(root: string, policy: WritePolicyConfig) {
  return new WriteChangesService(root, new PathSandbox(root), new WritePolicy(policy));
}
