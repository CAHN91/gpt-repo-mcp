import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { SearchService } from "../src/services/search-service.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("SearchService", () => {
  test("finds literal matches with context", async () => {
    const fixture = await createRepoFixture();
    const result = await new SearchService(new PathSandbox(fixture.root)).search({
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
    const service = new SearchService(new PathSandbox(fixture.root));

    expect((await service.search({ query: "super-secret" })).returned_count).toBe(0);
    expect((await service.search({ query: "ignored" })).returned_count).toBe(0);
    expect((await service.search({ query: "nested" })).returned_count).toBe(0);
  });

  test("supports regex mode", async () => {
    const fixture = await createRepoFixture();
    const result = await new SearchService(new PathSandbox(fixture.root)).search({
      query: "fetch\\('/api/users'\\)",
      mode: "regex"
    });

    expect(result.returned_count).toBe(1);
    expect(result.results[0]?.path).toBe("src/app.ts");
  });

  test("supports include and exclude globs", async () => {
    const fixture = await createRepoFixture();
    const result = await new SearchService(new PathSandbox(fixture.root)).search({
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
    const service = new SearchService(new PathSandbox(fixture.root));

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
    const service = new SearchService(new PathSandbox(fixture.root));

    await expect(service.search({ query: "(", mode: "regex" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });
});
