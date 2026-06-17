import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FileReader } from "../src/services/file-reader.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("FileReader", () => {
  test("reads a normal text file with line bounds and metadata", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    const result = await reader.read({ path: "src/app.ts", start_line: 2, end_line: 2 });

    expect(result.path).toBe("src/app.ts");
    expect(result.language).toBe("typescript");
    expect(result.total_lines).toBe(4);
    expect(result.start_line).toBe(2);
    expect(result.end_line).toBe(2);
    expect(result.text).toBe("  return fetch('/api/users');");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("blocks secret candidates even when default excludes are overridden", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: ".env", override_default_excludes: true })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("blocks in-repo symlink aliases to secret candidate paths", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    await mkdir(join(fixture.root, "secrets"), { recursive: true });
    await writeFile(join(fixture.root, "secrets", "api.txt"), "not secret\n");
    await symlink(join(fixture.root, "secrets"), join(fixture.root, "docs", "public-files"));

    await expect(reader.read({ path: "docs/public-files/api.txt", override_default_excludes: true })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("reads safe files whose paths mention secret or credential", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    await writeFile(join(fixture.root, "docs", "secret-management.md"), "# Secret Management\nUse placeholders.\n");

    const result = await reader.read({ path: "docs/secret-management.md" });

    expect(result.path).toBe("docs/secret-management.md");
    expect(result.text).toContain("Use placeholders.");
  });

  test("still blocks files inside secrets directories", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    await mkdir(join(fixture.root, "secrets"), { recursive: true });
    await writeFile(join(fixture.root, "secrets", "foo.txt"), "not secret\n");

    await expect(reader.read({ path: "secrets/foo.txt" })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("reads public env templates with placeholder-safe content", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    const safeContent = [
      "GPT_REPO_CONFIG=./config.local.json",
      "PORT=8787",
      "CONTROL_PLANE_API_KEY=",
      "TUNNEL_CLIENT_BIN=/path/to/tunnel-client",
      ""
    ].join("\n");

    for (const path of [".env.example", ".env.sample", ".env.template", "example.env"]) {
      await writeFile(join(fixture.root, path), safeContent);
      const result = await reader.read({ path, override_default_excludes: true });
      expect(result.path).toBe(path);
      expect(result.text).toContain("GPT_REPO_CONFIG=./config.local.json");
      expect(result.text).toContain("CONTROL_PLANE_API_KEY=");
    }
  });

  test("still blocks real env files and arbitrary env suffixes", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    await writeFile(join(fixture.root, ".env.local"), "PORT=8787\n");
    await writeFile(join(fixture.root, ".env.production"), "PORT=8787\n");
    await writeFile(join(fixture.root, ".env.anything"), "PORT=8787\n");

    for (const path of [".env", ".env.local", ".env.production", ".env.anything"]) {
      await expect(reader.read({ path, override_default_excludes: true })).rejects.toMatchObject({
        code: "SECRET_CANDIDATE_BLOCKED"
      });
    }
  });

  test("blocks public env templates containing secret-looking values", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));
    await writeFile(join(fixture.root, ".env.example"), "OPENAI_API_KEY=sk-realSecretValue123\n");

    await expect(reader.read({ path: ".env.example", override_default_excludes: true })).rejects.toMatchObject({
      code: "SECRET_CANDIDATE_BLOCKED"
    });
  });

  test("blocks binary files", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: "binary.bin" })).rejects.toMatchObject({
      code: "BINARY_FILE_REJECTED"
    });
  });

  test("allows generated files only with an explicit override warning", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: "dist/bundle.js" })).rejects.toMatchObject({
      code: "DEFAULT_EXCLUDE_BLOCKED"
    });

    const result = await reader.read({ path: "dist/bundle.js", override_default_excludes: true });
    expect(result.warnings).toEqual(["Read default-excluded path with override: dist/bundle.js"]);
  });

  test("enforces max_bytes", async () => {
    const fixture = await createRepoFixture();
    const reader = new FileReader(new PathSandbox(fixture.root));

    await expect(reader.read({ path: "src/app.ts", max_bytes: 10 })).rejects.toMatchObject({
      code: "SIZE_LIMIT_EXCEEDED"
    });
  });
});
