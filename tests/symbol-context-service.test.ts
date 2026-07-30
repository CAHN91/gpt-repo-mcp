import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { SymbolContextService } from "../src/services/symbol-context-service.js";
import { SymbolIndexService } from "../src/services/symbol-index-service.js";

const execFileAsync = promisify(execFile);

describe("SymbolContextService", () => {
  test("returns bounded definitions, calls, implementations, dependents, and affected tests", async () => {
    const root = await fixture();
    const service = new SymbolContextService(root, new PathSandbox(root));

    const result = await service.analyze({
      repo_id: "fixture",
      symbols: ["run", "Worker"],
      direction: "both",
      depth: 1
    });

    expect(result.definitions.map((definition) => definition.name)).toEqual(expect.arrayContaining(["run", "helper", "Worker", "WorkerImpl", "exercise"]));
    const byName = new Map(result.definitions.map((definition) => [definition.name, definition.id]));
    expect(result.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_symbol_id: byName.get("run"), to_symbol_id: byName.get("helper") }),
      expect.objectContaining({ from_symbol_id: byName.get("exercise"), to_symbol_id: byName.get("run") })
    ]));
    expect(result.implementations).toContainEqual(expect.objectContaining({
      interface_symbol_id: byName.get("Worker"),
      implementation_symbol_id: byName.get("WorkerImpl")
    }));
    expect(result.reverse_dependents.find((entry) => entry.symbol_id === byName.get("run"))?.paths).toContain("tests/run.test.ts");
    expect(result.affected_tests).toContain("tests/run.test.ts");
    expect(result.exports).toContain(byName.get("run"));
    expect(result.confidence).toBe("high");
    expect(result.truncated).toBe(false);
  });

  test("reuses HEAD/worktree-keyed content-free cache", async () => {
    const root = await fixture();
    const service = new SymbolContextService(root, new PathSandbox(root));
    const first = await service.analyze({ repo_id: "fixture", symbols: ["run"] });
    const second = await service.analyze({ repo_id: "fixture", symbols: ["run"] });

    expect(first.cache.hit).toBe(false);
    expect(second.cache).toMatchObject({ key: first.cache.key, path: first.cache.path, hit: true });
    const cacheText = await readFile(join(root, first.cache.path), "utf8");
    expect(cacheText).not.toContain("source secret marker");
    expect(cacheText).not.toContain(root);
  });

  test("reports truncation and no matches without guessing", async () => {
    const root = await fixture();
    const result = await new SymbolContextService(root, new PathSandbox(root)).analyze({
      repo_id: "fixture",
      symbols: ["missingSymbol"],
      max_files: 1
    });

    expect(result.definitions).toEqual([]);
    expect(result.confidence).toBe("low");
    expect(result.truncated).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining(["SYMBOL_QUERY_NO_MATCHES", "SYMBOL_FILE_LIMIT_REACHED"]));
  });

  test("rejects and rebuilds a cache containing unsafe or extra metadata", async () => {
    const root = await fixture();
    const service = new SymbolContextService(root, new PathSandbox(root));
    const first = await service.analyze({ repo_id: "fixture", symbols: ["run"] });
    const cachePath = join(root, first.cache.path);
    const tampered = JSON.parse(await readFile(cachePath, "utf8"));
    tampered.definitions[0].path = "/outside/private.ts";
    tampered.definitions[0].source_text = "must not escape";
    await writeFile(cachePath, JSON.stringify(tampered));

    const rebuilt = await service.analyze({ repo_id: "fixture", symbols: ["run"] });
    expect(rebuilt.cache.hit).toBe(false);
    expect(rebuilt.definitions.every((definition) => !definition.path.startsWith("/"))).toBe(true);
    expect(await readFile(cachePath, "utf8")).not.toContain("source_text");
  });

  test("writes a byte-bounded cache that the same service can reuse", async () => {
    const root = await largeFixture();
    const maxCacheBytes = 4_500;
    const service = new SymbolIndexService(root, new PathSandbox(root), {
      maxCacheBytes,
      maxCacheFiles: 5
    });

    const first = await service.load(500);
    const second = await service.load(500);

    expect((await stat(join(root, first.cache_path))).size).toBeLessThanOrEqual(maxCacheBytes);
    expect(first.index.truncated).toBe(true);
    expect(first.index.warnings).toContain("SYMBOL_CACHE_SIZE_LIMIT_REACHED");
    expect(second.cache_hit).toBe(true);
  });

  test("reports and rebuilds an oversized cache entry", async () => {
    const root = await fixture();
    const cacheOptions = { maxCacheBytes: 4_500, maxCacheFiles: 5 };
    const service = new SymbolIndexService(root, new PathSandbox(root), cacheOptions);
    const first = await service.load(200);
    const cachePath = join(root, first.cache_path);
    await writeFile(cachePath, `${await readFile(cachePath, "utf8")}${" ".repeat(cacheOptions.maxCacheBytes + 1)}`);

    const rebuilt = await service.load(200);

    expect(rebuilt.cache_hit).toBe(false);
    expect(rebuilt.index.warnings).toContain("SYMBOL_CACHE_TOO_LARGE_REBUILT");
    expect((await stat(cachePath)).size).toBeLessThanOrEqual(cacheOptions.maxCacheBytes);
  });

  test("prunes stale cache files while preserving the current entry", async () => {
    const root = await fixture();
    const cacheOptions = { maxCacheBytes: 20_000, maxCacheFiles: 3 };
    const service = new SymbolIndexService(root, new PathSandbox(root), cacheOptions);
    const first = await service.load(200);
    const cacheDirectory = join(root, ".chatgpt", "index", "symbols");
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(cacheDirectory, `stale-${index}.json`), "{}\n");
    }

    const cached = await service.load(200);
    const cacheFiles = (await readdir(cacheDirectory)).filter((path) => path.endsWith(".json"));

    expect(cached.cache_hit).toBe(true);
    expect(cacheFiles).toHaveLength(cacheOptions.maxCacheFiles);
    expect(cacheFiles).toContain(basename(first.cache_path));
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gpt-symbol-context-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "src", "worker.ts"), [
    "export interface Worker { work(): void }",
    "export class WorkerImpl implements Worker { work(): void {} }",
    "export function helper(): string { return 'source secret marker'; }",
    "export function run(): string { return helper(); }"
  ].join("\n"));
  await writeFile(join(root, "tests", "run.test.ts"), [
    "import { run } from '../src/worker.js';",
    "export function exercise(): string { return run(); }"
  ].join("\n"));
  await writeFile(join(root, "node_modules", "ignored", "hidden.ts"), "export function hidden(): void {}\n");
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "fixture@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Fixture"], { cwd: root });
  await execFileAsync("git", ["add", "src", "tests"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

async function largeFixture(): Promise<string> {
  const root = await fixture();
  await writeFile(
    join(root, "src", "many.ts"),
    Array.from({ length: 200 }, (_, index) => `export function generated${index}(): number { return ${index}; }`).join("\n")
  );
  return root;
}
