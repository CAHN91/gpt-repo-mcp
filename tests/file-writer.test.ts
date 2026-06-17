import { createHash } from "node:crypto";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FileWriter } from "../src/services/file-writer.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy, type WritePolicyConfig } from "../src/services/write-policy.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("FileWriter", () => {
  test("write creates missing file", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    const result = await writer.write({
      path: ".chatgpt/notes.md",
      content: "# Notes\n",
      create_dirs: true
    });

    expect(result).toMatchObject({
      ok: true,
      path: ".chatgpt/notes.md",
      action: "write",
      dry_run: false,
      changed: true,
      created: true,
      bytes_written: Buffer.byteLength("# Notes\n"),
      summary: "Created .chatgpt/notes.md.",
      warnings: []
    });
    await expect(readFile(join(fixture.root, ".chatgpt", "notes.md"), "utf8")).resolves.toBe("# Notes\n");
  });

  test("write overwrites existing file without expected_sha256", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    const result = await writer.write({
      path: "docs/guide.md",
      content: "# New Guide\n"
    });

    expect(result).toMatchObject({
      action: "write",
      changed: true,
      created: false,
      old_sha256: sha256("# Guide\nSearchable docs\n"),
      new_sha256: sha256("# New Guide\n")
    });
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# New Guide\n");
  });

  test("write no-op when content is identical", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    const result = await writer.write({
      path: "docs/guide.md",
      content: "# Guide\nSearchable docs\n"
    });

    expect(result.changed).toBe(false);
    expect(result.bytes_written).toBe(0);
    expect(result.old_sha256).toBe(result.new_sha256);
    expect(result.summary).toBe("No changes for docs/guide.md.");
  });

  test("write requires content by default", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "docs/guide.md"
    })).rejects.toMatchObject({ code: "WRITE_CONTENT_REQUIRED" });
  });

  test("append appends to existing file", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    const result = await writer.write({
      path: "docs/guide.md",
      action: "append",
      content: "More docs\n"
    });

    expect(result.bytes_written).toBe(Buffer.byteLength("# Guide\nSearchable docs\nMore docs\n"));
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nSearchable docs\nMore docs\n");
  });

  test("prepend prepends to existing file", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await writer.write({
      path: "docs/guide.md",
      action: "prepend",
      content: "Intro\n"
    });

    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("Intro\n# Guide\nSearchable docs\n");
  });

  test("replace exact once succeeds", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await writer.write({
      path: "docs/guide.md",
      action: "replace",
      find: "Searchable docs",
      replace: "Updated docs"
    });

    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nUpdated docs\n");
  });

  test("replace requires find", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "docs/guide.md",
      action: "replace",
      replace: "value"
    })).rejects.toMatchObject({ code: "WRITE_FIND_REQUIRED" });
  });

  test("replace requires replacement content", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "docs/guide.md",
      action: "replace",
      find: "Searchable docs"
    })).rejects.toMatchObject({ code: "WRITE_CONTENT_REQUIRED" });
  });

  test("replace not found fails", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "docs/guide.md",
      action: "replace",
      find: "missing",
      replace: "value"
    })).rejects.toMatchObject({ code: "WRITE_FIND_NOT_FOUND" });
  });

  test("replace multiple matches fails", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });
    await writer.write({ path: "docs/guide.md", content: "needle\nneedle\n" });

    await expect(writer.write({
      path: "docs/guide.md",
      action: "replace",
      find: "needle",
      replace: "value"
    })).rejects.toMatchObject({ code: "WRITE_FIND_NOT_UNIQUE" });
  });

  test("insert_before succeeds", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await writer.write({
      path: "docs/guide.md",
      action: "insert_before",
      find: "Searchable docs",
      content: "Inserted\n"
    });

    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nInserted\nSearchable docs\n");
  });

  test("insert_before requires content", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "docs/guide.md",
      action: "insert_before",
      find: "Searchable docs"
    })).rejects.toMatchObject({ code: "WRITE_CONTENT_REQUIRED" });
  });

  test("insert_after succeeds", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await writer.write({
      path: "docs/guide.md",
      action: "insert_after",
      find: "# Guide\n",
      content: "Inserted\n"
    });

    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nInserted\nSearchable docs\n");
  });

  test("insert_after requires content", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "docs/guide.md",
      action: "insert_after",
      find: "# Guide\n"
    })).rejects.toMatchObject({ code: "WRITE_CONTENT_REQUIRED" });
  });

  test("dry_run writes nothing", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    const result = await writer.write({
      path: "docs/guide.md",
      content: "# Dry Run\n",
      dry_run: true
    });

    expect(result.dry_run).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.bytes_written).toBe(0);
    await expect(readFile(join(fixture.root, "docs", "guide.md"), "utf8")).resolves.toBe("# Guide\nSearchable docs\n");
  });

  test("secret content rejected", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "docs/guide.md",
      content: "OPENAI_API_KEY=sk-realSecretValue123\n"
    })).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
  });

  test("documentation placeholders are allowed", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await writer.write({
      path: "docs/secret-management.md",
      content: [
        "# Secret Management",
        "Use [REDACTED_SECRET] in examples.",
        "Set API_KEY=replace-me.",
        "Use your-api-key-here or <OPENAI_API_KEY>.",
        "Use sk-... only as a placeholder.",
        ""
      ].join("\n")
    });

    await expect(readFile(join(fixture.root, "docs", "secret-management.md"), "utf8")).resolves.toContain("sk-...");
  });

  test("realistic secret values are still rejected", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "docs/secret-management.md",
      content: "OPENAI_API_KEY=sk-realSecretValue123\n"
    })).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
  });

  test("legitimate secret and credential filenames are allowed when policy allows them", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true, allowed_globs: ["**"] });

    await writer.write({
      path: "docs/secret-plan.md",
      content: "not secret\n"
    });
    await writer.write({
      path: "src/auth/credentialStore.ts",
      content: "export const store = 'placeholder';\n",
      create_dirs: true
    });

    await expect(readFile(join(fixture.root, "docs", "secret-plan.md"), "utf8")).resolves.toBe("not secret\n");
    await expect(readFile(join(fixture.root, "src", "auth", "credentialStore.ts"), "utf8")).resolves.toContain("placeholder");
  });

  test("denied glob rejected", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true, allowed_globs: ["**"] });

    await expect(writer.write({
      path: "dist/generated.js",
      content: "generated\n"
    })).rejects.toMatchObject({ code: "WRITE_DENIED_GLOB" });
  });

  test("custom denied globs cannot replace hard default denials", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, {
      enabled: true,
      allowed_globs: ["**"],
      denied_globs: ["docs/private/**"]
    });

    await expect(writer.write({
      path: "dist/generated.js",
      content: "generated\n"
    })).rejects.toMatchObject({ code: "WRITE_DENIED_GLOB" });
  });

  test("broad write policy rejects nested dependency and generated paths", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true, allowed_globs: ["**"] });
    const deniedPaths = [
      "packages/app/node_modules/pkg/index.js",
      "apps/web/dist/client.js",
      "apps/web/.next/cache/file.js",
      "packages/api/coverage/report.json"
    ];

    for (const path of deniedPaths) {
      await expect(writer.write({
        path,
        content: "generated\n",
        create_dirs: true
      })).rejects.toMatchObject({ code: "WRITE_DENIED_GLOB" });
    }
  });

  test("default enabled policy allows exact root public docs", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    const publicDocs = [
      "README.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "SUPPORT.md",
      "LICENSE"
    ];

    for (const path of publicDocs) {
      await writer.write({
        path,
        content: `${path}\n`
      });
      await expect(readFile(join(fixture.root, path), "utf8")).resolves.toBe(`${path}\n`);
    }
  });

  test("default enabled policy still rejects root files outside public docs allowlist", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "package.json",
      content: "{}\n"
    })).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED_GLOB" });
    await expect(writer.write({
      path: "scripts/foo.mjs",
      content: "export {};\n",
      create_dirs: true
    })).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED_GLOB" });
    await expect(writer.write({
      path: "TODO.md",
      content: "# Todo\n"
    })).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED_GLOB" });
    await expect(writer.write({
      path: ".env.example",
      content: "EXAMPLE=value\n"
    })).rejects.toMatchObject({ code: "WRITE_DENIED_GLOB" });
  });

  test("path traversal rejected", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "../outside.md",
      content: "outside\n"
    })).rejects.toMatchObject({ code: "PATH_TRAVERSAL_REJECTED" });
  });

  test("absolute path rejected", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: join(fixture.root, "docs", "absolute.md"),
      content: "absolute\n"
    })).rejects.toMatchObject({ code: "ABSOLUTE_PATH_REJECTED" });
  });

  test("symlink escape rejected", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true, allowed_globs: ["**"] });
    await symlink(fixture.outside, join(fixture.root, "docs", "outside-dir"));

    await expect(writer.write({
      path: "docs/outside-dir/escape.md",
      content: "escape\n"
    })).rejects.toMatchObject({ code: "SYMLINK_ESCAPE_REJECTED" });
  });

  test("write policy is enforced against canonical paths through in-repo symlink parents", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true, allowed_globs: ["docs/**"] });
    await symlink(join(fixture.root, "dist"), join(fixture.root, "docs", "dist-link"));

    await expect(writer.write({
      path: "docs/dist-link/generated.js",
      content: "generated\n",
      create_dirs: true
    })).rejects.toMatchObject({ code: "WRITE_DENIED_GLOB" });
  });

  test("invalid UTF-8 edit target is rejected", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true, allowed_globs: ["docs/**"] });
    await writeFile(join(fixture.root, "docs", "invalid.md"), Buffer.from([0xc3, 0x28]));

    await expect(writer.write({
      path: "docs/invalid.md",
      action: "append",
      content: "text\n"
    })).rejects.toMatchObject({ code: "BINARY_FILE_REJECTED" });
  });

  test("source file write works when policy allows src/**", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true, allowed_globs: ["src/**"] });

    await writer.write({
      path: "src/app.ts",
      content: "export const changed = true;\n"
    });

    await expect(readFile(join(fixture.root, "src", "app.ts"), "utf8")).resolves.toBe("export const changed = true;\n");
  });

  test("source file write is rejected when policy only allows docs/.chatgpt/.codex", async () => {
    const fixture = await createRepoFixture();
    const writer = createWriter(fixture.root, { enabled: true });

    await expect(writer.write({
      path: "src/app.ts",
      content: "export const changed = true;\n"
    })).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED_GLOB" });
  });
});

function createWriter(root: string, policy: WritePolicyConfig) {
  return new FileWriter(root, new PathSandbox(root), new WritePolicy(policy));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
