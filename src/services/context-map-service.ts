import { dirname, join, normalize, parse } from "node:path";
import { readFile } from "node:fs/promises";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoTreeService } from "./repo-tree-service.js";
import { readFilePrefix } from "./bounded-read.js";
import type { PathSandbox } from "./path-sandbox.js";
import type {
  ContextMapComponentSignal,
  ContextMapEntryPoint,
  ContextMapImportEdge,
  ContextMapInput,
  ContextMapResult,
  ContextMapRouteSignal
} from "../contracts/context-map.contract.js";

type ContextMapOptions = Omit<ContextMapInput, "repo_id">;

export type ContextMapLimits = {
  maxTreeEntries: number;
  maxFiles: number;
};

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_PATH_PATTERN = /(^|\/)(__tests__|tests)(\/|$)|\.(test|spec)\.(ts|tsx|js|jsx)$/;
const MAX_IMPORT_FILE_BYTES = 96_000;

type PackageJson = {
  bin?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

export class ContextMapService {
  private readonly limits: ContextMapLimits;

  constructor(
    private readonly sandbox: PathSandbox,
    limits: Partial<ContextMapLimits> = {}
  ) {
    this.limits = {
      maxTreeEntries: limits.maxTreeEntries ?? DEFAULT_LIMITS.max_tree_entries,
      maxFiles: limits.maxFiles ?? DEFAULT_LIMITS.max_change_plan_files
    };
  }

  async map(options: ContextMapOptions = {}): Promise<ContextMapResult> {
    const warnings: string[] = [];
    const tree = await new RepoTreeService(this.sandbox).tree({
      include_files: true,
      include_generated: true,
      include_dependencies: true,
      respect_default_excludes: true,
      page_size: this.limits.maxTreeEntries,
      exclude_prefixes: [".chatgpt"]
    });
    if (tree.truncated) {
      warnings.push("TREE_TRUNCATED");
    }

    const filePaths = tree.entries.filter((entry) => entry.type === "file").map((entry) => entry.path);
    const fileSet = new Set(filePaths);
    const generatedPaths = filePaths.filter(isGeneratedPath).sort();
    const dependencyPaths = filePaths.filter(isDependencyPath).sort();
    const packageJson = await this.readPackageJson(fileSet, warnings);
    const sourceCandidates = filePaths
      .filter((path) => SOURCE_EXTENSIONS.test(path))
      .filter((path) => !isGeneratedPath(path) && !isDependencyPath(path))
      .sort();
    const maxFiles = Math.min(options.max_files ?? this.limits.maxFiles, this.limits.maxTreeEntries);
    const sourceFiles = sourceCandidates.slice(0, maxFiles);
    if (sourceCandidates.length > sourceFiles.length || (tree.truncated && options.max_files !== undefined)) {
      warnings.push("CONTEXT_FILE_LIMIT_REACHED");
    }

    const importEdges = await this.collectImportEdges(sourceFiles, fileSet, warnings);
    const inferredFocusPaths = inferFocusPaths(options, filePaths);
    const focusPaths = [...new Set(inferredFocusPaths.filter((path) => fileSet.has(path)))].sort();

    return {
      entrypoints: detectEntrypoints(filePaths, packageJson),
      import_edges: importEdges,
      reverse_dependents: reverseDependents(focusPaths, importEdges),
      affected_tests: affectedTests(focusPaths, filePaths, importEdges),
      generated_paths: generatedPaths,
      dependency_paths: dependencyPaths,
      route_signals: detectRouteSignals(filePaths),
      component_signals: detectComponentSignals(filePaths),
      framework_signals: detectFrameworkSignals(packageJson, filePaths),
      scanned_file_count: sourceFiles.length,
      truncated: tree.truncated || sourceCandidates.length > sourceFiles.length,
      warnings
    };
  }

  private async collectImportEdges(sourceFiles: string[], fileSet: Set<string>, warnings: string[]): Promise<ContextMapImportEdge[]> {
    const edges: ContextMapImportEdge[] = [];
    for (const path of sourceFiles) {
      let text: string;
      try {
        const resolved = await this.sandbox.resolve(path);
        const result = await readFilePrefix(resolved.absolutePath, MAX_IMPORT_FILE_BYTES);
        text = result.buffer.toString("utf8");
        if (result.truncated) {
          warnings.push(`IMPORT_FILE_TRUNCATED:${path}`);
        }
      } catch {
        warnings.push(`IMPORT_READ_SKIPPED:${path}`);
        continue;
      }

      for (const specifier of extractImportSpecifiers(text)) {
        if (!specifier.startsWith(".")) {
          continue;
        }
        const resolved = resolveRelativeImport(path, specifier, fileSet);
        edges.push({
          from: path,
          to: resolved.path,
          import: specifier,
          ...(resolved.unresolved ? { unresolved: true } : {})
        });
      }
    }
    return dedupeEdges(edges).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.import.localeCompare(b.import));
  }

  private async readPackageJson(fileSet: Set<string>, warnings: string[]): Promise<PackageJson | undefined> {
    if (!fileSet.has("package.json")) {
      return undefined;
    }
    try {
      const resolved = await this.sandbox.resolve("package.json");
      return JSON.parse(await readFile(resolved.absolutePath, "utf8")) as PackageJson;
    } catch {
      warnings.push("PACKAGE_JSON_PARSE_ERROR");
      return undefined;
    }
  }
}

function extractImportSpecifiers(text: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function resolveRelativeImport(fromPath: string, specifier: string, fileSet: Set<string>): { path: string; unresolved: boolean } {
  const base = normalizeRepoPath(join(dirname(fromPath), specifier));
  const candidates = importCandidates(base);
  const found = candidates.find((candidate) => fileSet.has(candidate));
  return found ? { path: found, unresolved: false } : { path: candidates[0], unresolved: true };
}

function importCandidates(base: string): string[] {
  if (SOURCE_EXTENSIONS.test(base) || /\.(json|css)$/.test(base)) {
    return [base];
  }
  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`
  ];
}

function normalizeRepoPath(path: string): string {
  return normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function dedupeEdges(edges: ContextMapImportEdge[]): ContextMapImportEdge[] {
  const seen = new Set<string>();
  const result: ContextMapImportEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}\0${edge.import}\0${edge.unresolved ? "1" : "0"}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(edge);
    }
  }
  return result;
}

function inferFocusPaths(options: ContextMapOptions, filePaths: string[]): string[] {
  const explicit = options.focus_paths ?? [];
  const terms = goalTerms(options.goal ?? "");
  if (terms.length === 0) {
    return explicit;
  }
  const inferred = filePaths.filter((path) => {
    const lower = path.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });
  return [...explicit, ...inferred];
}

function reverseDependents(focusPaths: string[], importEdges: ContextMapImportEdge[]) {
  return focusPaths.map((path) => ({
    path,
    dependents: [...new Set(importEdges.filter((edge) => edge.to === path && !edge.unresolved).map((edge) => edge.from))].sort()
  })).filter((entry) => entry.dependents.length > 0);
}

function affectedTests(focusPaths: string[], filePaths: string[], importEdges: ContextMapImportEdge[]): string[] {
  const tests = filePaths.filter(isTestPath);
  const dependents = new Set(importEdges.filter((edge) => focusPaths.includes(edge.to) && !edge.unresolved).map((edge) => edge.from));
  const affected = new Set<string>();

  for (const testPath of tests) {
    const importedTargets = importEdges.filter((edge) => edge.from === testPath && !edge.unresolved).map((edge) => edge.to);
    if (importedTargets.some((target) => focusPaths.includes(target) || dependents.has(target))) {
      affected.add(testPath);
      continue;
    }
    if (focusPaths.some((focusPath) => hasTestAffinity(testPath, focusPath))) {
      affected.add(testPath);
    }
  }

  return [...affected].sort();
}

function hasTestAffinity(testPath: string, focusPath: string): boolean {
  const test = parsePath(testPath);
  const focus = parsePath(focusPath);
  const normalizedTestName = test.name.replace(/\.(test|spec)$/i, "");
  if (normalizedTestName === focus.name) {
    return true;
  }
  if (test.dir === focus.dir && normalizedTestName === focus.name) {
    return true;
  }
  return /(^|\/)(__tests__|tests)(\/|$)/.test(testPath) && testPath.toLowerCase().includes(focus.name.toLowerCase());
}

function parsePath(path: string): { dir: string; name: string } {
  const parsed = parse(path);
  return { dir: parsed.dir, name: parsed.name };
}

function detectEntrypoints(filePaths: string[], packageJson: PackageJson | undefined): ContextMapEntryPoint[] {
  const fileSet = new Set(filePaths);
  const entrypoints: ContextMapEntryPoint[] = [];
  if (packageJson && fileSet.has("package.json")) {
    entrypoints.push({ path: "package.json", kind: "package", reason: "Package metadata defines scripts, exports, or dependencies." });
  }
  for (const path of filePaths) {
    if (/^(src\/)?(index|main|server|app|cli)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
      entrypoints.push({ path, kind: path.includes("cli") ? "cli" : "runtime", reason: "Conventional runtime entrypoint path." });
    }
    if (/^(vite|next|astro|svelte|nuxt|webpack|tsup|rollup|eslint|vitest|jest)\.config\.(ts|js|mjs|cjs)$/.test(path)) {
      entrypoints.push({ path, kind: "config", reason: "Project tooling configuration entrypoint." });
    }
  }
  return dedupeByPath(entrypoints).slice(0, 20);
}

function detectRouteSignals(filePaths: string[]): ContextMapRouteSignal[] {
  return filePaths.flatMap((path): ContextMapRouteSignal[] => {
    const appRoute = path.match(/^src\/app\/(.+)\/(page|route)\.(tsx|ts|jsx|js)$/) ?? path.match(/^app\/(.+)\/(page|route)\.(tsx|ts|jsx|js)$/);
    if (appRoute) {
      return [{ path, route: `/${cleanRoute(appRoute[1])}`, kind: appRoute[2] === "route" ? "api-route" : "app-route" }];
    }
    const pagesRoute = path.match(/^(src\/)?pages\/(.+)\.(tsx|ts|jsx|js)$/);
    if (pagesRoute) {
      const routePath = pagesRoute[2].replace(/\/index$/, "");
      const route = cleanRoute(routePath);
      return [{ path, route: route ? `/${route}` : "/", kind: routePath.startsWith("api/") ? "api-route" : "pages-route" }];
    }
    return [];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function cleanRoute(value: string): string {
  return value.replace(/\/page$/, "").replace(/\(.*?\)\//g, "").replace(/\[(.*?)\]/g, ":$1").replace(/\/index$/, "");
}

function detectComponentSignals(filePaths: string[]): ContextMapComponentSignal[] {
  return filePaths
    .filter((path) => /\.(tsx|jsx)$/.test(path))
    .filter((path) => /(^|\/)(components?|ui)\//i.test(path) || /^[A-Z]/.test(parse(path).name))
    .map((path) => ({ path, name: parse(path).name }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, 40);
}

function detectFrameworkSignals(packageJson: PackageJson | undefined, filePaths: string[]): string[] {
  const signals = new Set<string>();
  const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  if ("@modelcontextprotocol/sdk" in deps) signals.add("mcp-server");
  if ("next" in deps || filePaths.some((path) => /^(src\/)?app\/.+\/page\./.test(path))) signals.add("nextjs");
  if ("vite" in deps || filePaths.some((path) => path.startsWith("vite.config."))) signals.add("vite");
  if ("react" in deps || filePaths.some((path) => /\.(tsx|jsx)$/.test(path))) signals.add("react");
  if ("vitest" in deps || filePaths.some((path) => path.startsWith("vitest.config."))) signals.add("vitest");
  if ("jest" in deps || filePaths.some((path) => path.startsWith("jest.config."))) signals.add("jest");
  return [...signals].sort();
}

function dedupeByPath<T extends { path: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (!seen.has(item.path)) {
      seen.add(item.path);
      result.push(item);
    }
  }
  return result;
}

function goalTerms(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[^a-z0-9åäö]+/i)
    .filter((term) => term.length >= 3)
    .slice(0, 12);
}

function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERN.test(path);
}

function isGeneratedPath(path: string): boolean {
  return /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.astro|\.cache|\.turbo|playwright-report|test-results)(\/|$)/.test(path);
}

function isDependencyPath(path: string): boolean {
  return /(^|\/)(node_modules|vendor|third_party)(\/|$)/.test(path);
}
