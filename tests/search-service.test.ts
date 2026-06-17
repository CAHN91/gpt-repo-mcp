import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { SearchService } from "../src/services/search-service.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("SearchService", () => {
  test("finds literal matches with context", async () => {
    const fixture = await createRepoFixture();
    const result = await new SearchService(fixture.root, new PathSandbox(fixture.root)).search({
      query: "/api/users",
      context_lines: 1
    });

    expect(result.returned_count).toBe(1);
    expect(result.results[0]).toMatchObject({
      path: "src/app.ts",
      line: 2,
      text: "  return fetch('/api/users');",
      before: ["export function rawFetch() {"],
      after: ["}"]
    });
  });

  test("skips secret candidates, default excludes, binary files, and nested repo contents", async () => {
    const fixture = await createRepoFixture();
    const service = new SearchService(fixture.root, new PathSandbox(fixture.root));

    expect((await service.search({ query: "super-secret" })).returned_count).toBe(0);
    expect((await service.search({ query: "ignored" })).returned_count).toBe(0);
    expect((await service.search({ query: "nested" })).returned_count).toBe(0);
  });

  test("supports regex mode", async () => {
    const fixture = await createRepoFixture();
    const result = await new SearchService(fixture.root, new PathSandbox(fixture.root)).search({
      query: "fetch\\('/api/users'\\)",
      mode: "regex"
    });

    expect(result.returned_count).toBe(1);
    expect(result.results[0]?.path).toBe("src/app.ts");
  });

  test("redacts secret-looking values from matching lines and context", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "config.ts"), [
      "export const label = 'before';",
      "export const apiKey = 'sk-realSecretValue123';",
      "export const enabled = true;",
      ""
    ].join("\n"));

    const result = await new SearchService(fixture.root, new PathSandbox(fixture.root)).search({
      query: "apiKey",
      include_globs: ["src/config.ts"],
      context_lines: 1
    });

    expect(result.returned_count).toBe(1);
    expect(result.results[0]?.text).toBe("export const apiKey = '[REDACTED_SECRET]';");
    expect(result.results[0]?.before).toEqual(["export const label = 'before';"]);
    expect(JSON.stringify(result.results)).not.toContain("sk-realSecretValue123");
  });

  test("skips files larger than the per-file byte limit", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "src", "big.txt"), `needle\n${"A".repeat(130_000)}`);

    const result = await new SearchService(fixture.root, new PathSandbox(fixture.root)).search({
      query: "needle",
      include_globs: ["src/big.txt"]
    });

    expect(result.returned_count).toBe(0);
    expect(result.warnings).toEqual([
      "Skipped src/big.txt: file exceeds max_bytes_per_file (128000)."
    ]);
  });

  test("rejects overly long regex queries before compiling them", async () => {
    const fixture = await createRepoFixture();
    const service = new SearchService(fixture.root, new PathSandbox(fixture.root));

    await expect(service.search({
      query: "a".repeat(201),
      mode: "regex"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("supports include and exclude globs", async () => {
    const fixture = await createRepoFixture();
    const result = await new SearchService(fixture.root, new PathSandbox(fixture.root)).search({
      query: "true",
      include_globs: ["src/**/*.controller.ts"],
      exclude_globs: ["src/admin.*"]
    });

    expect(result.results.map((match) => match.path)).toEqual(["src/users.controller.ts"]);
    expect(result.matched_count).toBe(1);
    expect(result.returned_count).toBe(1);
  });

  test("paginates deterministic results with cursor", async () => {
    const fixture = await createRepoFixture();
    const service = new SearchService(fixture.root, new PathSandbox(fixture.root));

    const first = await service.search({
      query: "export",
      include_globs: ["src/**/*.ts"],
      max_results: 2
    });

    expect(first.results.map((match) => match.path)).toEqual(["src/admin.controller.ts", "src/app.ts"]);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe("2");

    const second = await service.search({
      query: "export",
      include_globs: ["src/**/*.ts"],
      max_results: 2,
      cursor: first.next_cursor
    });

    expect(second.results.map((match) => match.path)).toEqual(["src/controllers.ts", "src/controllers.ts"]);
    expect(second.truncated).toBe(true);
    expect(second.next_cursor).toBe("4");
  });

  test("rejects invalid regex with a stable policy error", async () => {
    const fixture = await createRepoFixture();
    const service = new SearchService(fixture.root, new PathSandbox(fixture.root));

    await expect(service.search({ query: "(", mode: "regex" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });
});
