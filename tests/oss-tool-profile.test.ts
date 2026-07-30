import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { OSS_TOOL_ORDER } from "../src/tools/oss-tool-profile.js";
import { CANONICAL_TOOL_ORDER } from "../src/tools/registry.js";

const runnerExecutionFiles = new Set([
  "src/agent-runner/adapter-executor.ts",
  "src/agent-runner/adapter-factory.ts",
  "src/agent-runner/adapter.ts",
  "src/agent-runner/codex-sdk-adapter.ts",
  "src/agent-runner/codex-sdk-env.ts",
  "src/agent-runner/codex-sdk-loader.ts",
  "src/agent-runner/codex-sdk-output-schema.ts",
  "src/agent-runner/codex-sdk-output.ts",
  "src/agent-runner/daemon.ts",
  "src/agent-runner/policy.ts",
  "src/agent-runner/run-once.ts",
  "src/agent-runner/run-watch.ts",
  "src/agent-runner/supervisor.ts"
]);

describe("OSS tool profile", () => {
  test("explicitly includes the reviewed canonical tool surface", () => {
    expect(OSS_TOOL_ORDER).toEqual(CANONICAL_TOOL_ORDER);
    expect(new Set(OSS_TOOL_ORDER).size).toBe(OSS_TOOL_ORDER.length);
  });

  test("server runtime does not reach agent-runner execution modules", () => {
    const reachable = collectRelativeImports("src/server.ts");
    expect([...reachable].filter((file) => runnerExecutionFiles.has(file))).toEqual([]);
    expect([...reachable].filter((file) => file.startsWith("src/agent-runner/")).sort()).toEqual([]);
  });
});

function collectRelativeImports(entrypoint: string): Set<string> {
  const root = process.cwd();
  const visited = new Set<string>();
  const pending = [entrypoint];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    const source = readFileSync(resolve(root, file), "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const dependency = resolveTypeScriptImport(root, file, specifier);
      if (dependency && !visited.has(dependency)) {
        pending.push(dependency);
      }
    }
  }

  return visited;
}

function relativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith(".")) {
        specifiers.push(match[1]);
      }
    }
  }

  return specifiers;
}

function resolveTypeScriptImport(root: string, importer: string, specifier: string): string | undefined {
  const unresolved = resolve(root, dirname(importer), specifier);
  const candidates = [
    unresolved.replace(/\.js$/, ".ts"),
    `${unresolved}.ts`,
    join(unresolved, "index.ts")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return normalize(relative(root, candidate)).split(sep).join("/");
    }
  }

  return undefined;
}
