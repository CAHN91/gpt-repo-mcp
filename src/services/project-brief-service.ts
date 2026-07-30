import { extname } from "node:path";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import type { ContextMapEntryPoint } from "../contracts/context-map.contract.js";
import type { ProjectBriefInclude, ProjectBriefInput } from "../contracts/project.contract.js";
import { ProjectProductBriefSchema } from "../contracts/project-product-brief.contract.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { readFilePrefix } from "./bounded-read.js";
import { ContextMapService } from "./context-map-service.js";
import { GitService } from "./git-service.js";
import { IgnoreEngine } from "./ignore-engine.js";
import type { PathSandbox } from "./path-sandbox.js";
import { ProductContractService } from "./product-contract-service.js";
import { DelegationDriftService } from "./delegation-drift-service.js";
import { projectProductBrief } from "./project-product-brief.js";
import { RepoTreeService } from "./repo-tree-service.js";
import type { RepoConfig } from "./root-registry.js";

const DEFAULT_INCLUDE: ProjectBriefInclude[] = ["package", "readme", "architecture", "scripts", "recent_git", "todos"];
const MAX_DOCS = 5;
const MAX_ENTRYPOINTS = 12;
const MAX_SCRIPTS = 20;
const MAX_TREE_ENTRIES = 500;

const KNOWN_PROJECT_PATHS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "Cargo.toml",
  "Cargo.lock",
  "README.md",
  "ARCHITECTURE.md",
  "ROADMAP.md",
  "docs/ARCHITECTURE.md",
  "docs/DESIGN.md",
  "docs/OVERVIEW.md",
  "docs/ROADMAP.md",
  "src/index.ts",
  "src/index.js",
  "src/server.ts",
  "src/server.js",
  "src/main.ts",
  "src/main.js",
  "src/app.ts",
  "src/app.js",
  "index.ts",
  "index.js",
  "server.ts",
  "server.js"
] as const;

type ProjectBriefOptions = Omit<ProjectBriefInput, "repo_id">;

type PackageJson = {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  type?: unknown;
};

export class ProjectBriefService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(private readonly repo: RepoConfig, private readonly sandbox: PathSandbox) {}

  async brief(options: ProjectBriefOptions = {}) {
    const include = new Set(options.include ?? DEFAULT_INCLUDE);
    const warnings: string[] = [];
    const productContext = await new ProductContractService(this.sandbox).load();
    const delegationDrift = await new DelegationDriftService(this.repo.root, this.sandbox).analyze(this.repo.repo_id);
    const baseProductBrief = projectProductBrief(productContext);
    const productBrief = baseProductBrief.status === "configured"
      ? ProjectProductBriefSchema.parse({ ...baseProductBrief, delegation_checkpoint: delegationDrift.checkpoint })
      : baseProductBrief;
    if (delegationDrift.checkpoint.status === "due") warnings.push("DELEGATION_PRODUCT_CHECKPOINT_DUE");
    const tree = await new RepoTreeService(this.sandbox).tree({
      include_files: true,
      max_depth: 4,
      page_size: MAX_TREE_ENTRIES,
      respect_default_excludes: true,
      exclude_prefixes: [".chatgpt"]
    });
    const treePaths = tree.entries.filter((entry) => entry.type === "file").map((entry) => entry.path);
    const knownPaths = await this.discoverKnownPaths(warnings);
    const filePaths = uniqueSorted([...knownPaths, ...treePaths]);
    if (tree.truncated) warnings.push("TREE_TRUNCATED");

    const packageJson = include.has("package") || include.has("scripts")
      ? await this.readPackageJson(filePaths, warnings)
      : undefined;
    const allScripts = include.has("scripts") && packageJson?.scripts ? normalizeScripts(packageJson.scripts) : [];
    const scripts = allScripts.slice(0, MAX_SCRIPTS);
    const canonicalPaths = productContext.status === "configured"
      ? new Set(productContext.contract.canonical_docs)
      : new Set<string>();
    const docs = include.has("readme") || include.has("architecture") || include.has("todos")
      ? await this.readKeyDocs(filePaths, include, canonicalPaths, warnings)
      : [];
    const recentGitWarnings = include.has("recent_git") ? await this.collectRecentGitWarnings(warnings) : [];
    const likelyEntrypoints = detectEntrypoints(filePaths, packageJson);
    const contextMap = await new ContextMapService(this.sandbox).map({
      focus_paths: likelyEntrypoints.filter((path) => path !== "package.json"),
      max_files: 40
    });
    const projectType = detectProjectType(packageJson, filePaths);
    warnings.push(...recentGitWarnings);

    return {
      repo: {
        repo_id: this.repo.repo_id,
        display_name: this.repo.display_name
      },
      product_brief: productBrief,
      project_type: projectType,
      languages: detectLanguages(filePaths),
      package_managers: detectPackageManagers(filePaths),
      scripts,
      key_docs: docs,
      likely_entrypoints: likelyEntrypoints,
      entrypoint_signals: mergeEntrypointSignals(
        contextMap.entrypoints,
        directEntrypointSignals(likelyEntrypoints)
      ).slice(0, MAX_ENTRYPOINTS),
      framework_signals: uniqueSorted([
        ...contextMap.framework_signals,
        ...frameworkSignalsForProjectType(projectType)
      ]),
      test_commands: detectTestCommands(scripts, filePaths),
      truncated: tree.truncated || contextMap.truncated || allScripts.length > scripts.length,
      warnings: [...new Set([...warnings, ...contextMap.warnings])]
    };
  }

  private async discoverKnownPaths(warnings: string[]): Promise<string[]> {
    const discovered: string[] = [];
    for (const path of KNOWN_PROJECT_PATHS) {
      try {
        const resolved = await this.sandbox.resolve(path);
        if (resolved.stat.isFile() && !resolved.stat.isSymbolicLink()) discovered.push(resolved.repoPath);
      } catch (error) {
        if (!isNotFoundError(error)) warnings.push(`KNOWN_PATH_SKIPPED:${path}`);
      }
    }
    return discovered;
  }

  private async readPackageJson(filePaths: string[], warnings: string[]): Promise<PackageJson | undefined> {
    if (!filePaths.includes("package.json")) return undefined;
    const text = await this.readTextIfPresent("package.json", warnings);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as PackageJson;
    } catch {
      warnings.push("PACKAGE_JSON_PARSE_ERROR");
      return undefined;
    }
  }

  private async readKeyDocs(
    filePaths: string[],
    include: Set<ProjectBriefInclude>,
    canonicalPaths: ReadonlySet<string>,
    warnings: string[]
  ) {
    const candidates = filePaths
      .filter((path) => isDocCandidate(path, include))
      .filter((path) => !canonicalPaths.has(path))
      .filter((path) => !path.startsWith(".chatgpt/"))
      .filter((path) => !this.ignoreEngine.isInternalArtifact(path) && !this.ignoreEngine.isIgnored(path))
      .sort(compareDocCandidates)
      .slice(0, MAX_DOCS);
    const docs = [];
    for (const path of candidates) {
      const text = await this.readTextIfPresent(path, warnings);
      if (text) docs.push({ path, summary: summarizeMarkdown(text) });
    }
    return docs;
  }

  private async collectRecentGitWarnings(warnings: string[]): Promise<string[]> {
    try {
      const status = await new GitService(this.repo.root).status();
      return status.clean ? [] : [`GIT_DIRTY:${status.files.length}`];
    } catch {
      warnings.push("GIT_STATUS_UNAVAILABLE");
      return [];
    }
  }

  private async readTextIfPresent(path: string, warnings: string[]): Promise<string | undefined> {
    try {
      const resolved = await this.sandbox.resolve(path);
      const result = await readFilePrefix(resolved.absolutePath, DEFAULT_LIMITS.max_project_brief_doc_bytes);
      if (result.truncated) warnings.push(`FILE_TRUNCATED:${path}`);
      return result.buffer.toString("utf8");
    } catch {
      warnings.push(`READ_SKIPPED:${path}`);
      return undefined;
    }
  }
}

function normalizeScripts(scripts: Record<string, unknown>) {
  return Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, command]) => ({ name, command }))
    .sort((left, right) => scriptRank(left.name) - scriptRank(right.name) || left.name.localeCompare(right.name));
}

function scriptRank(name: string): number {
  const normalized = name.toLowerCase();
  if (normalized === "test") return 0;
  if (normalized === "build") return 1;
  if (normalized === "typecheck") return 2;
  if (normalized === "lint") return 3;
  if (normalized === "smoke") return 4;
  if (/^(test|build|typecheck|lint|smoke)(:|$)/.test(normalized)) return 5;
  return 10;
}

function detectProjectType(packageJson: PackageJson | undefined, filePaths: string[]): string | undefined {
  if (packageJson) {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if ("@modelcontextprotocol/sdk" in deps) return "mcp-server";
    if ("next" in deps) return "nextjs-app";
    if ("vite" in deps) return "vite-app";
    return packageJson.type === "module" ? "node-module" : "node-project";
  }
  if (filePaths.includes("pyproject.toml")) return "python-project";
  if (filePaths.includes("Cargo.toml")) return "rust-project";
  return undefined;
}

function detectLanguages(filePaths: string[]): string[] {
  const languages = new Set<string>();
  for (const path of filePaths) {
    const language = languageByExtension(extname(path));
    if (language) languages.add(language);
  }
  return [...languages].sort();
}

function languageByExtension(extension: string): string | undefined {
  return {
    ".cjs": "JavaScript",
    ".css": "CSS",
    ".go": "Go",
    ".html": "HTML",
    ".java": "Java",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".md": "Markdown",
    ".mjs": "JavaScript",
    ".py": "Python",
    ".rs": "Rust",
    ".tsx": "TypeScript",
    ".ts": "TypeScript"
  }[extension];
}

function detectPackageManagers(filePaths: string[]): string[] {
  const managers = [];
  if (filePaths.includes("package-lock.json")) managers.push("npm");
  if (filePaths.includes("pnpm-lock.yaml")) managers.push("pnpm");
  if (filePaths.includes("yarn.lock")) managers.push("yarn");
  if (filePaths.includes("bun.lockb") || filePaths.includes("bun.lock")) managers.push("bun");
  if (filePaths.includes("pyproject.toml")) managers.push("python");
  if (filePaths.includes("Cargo.lock") || filePaths.includes("Cargo.toml")) managers.push("cargo");
  return managers;
}

function detectEntrypoints(filePaths: string[], packageJson: PackageJson | undefined): string[] {
  const preferredNames = new Set([
    "src/index.ts", "src/index.js", "src/server.ts", "src/server.js", "src/main.ts", "src/main.js",
    "src/app.ts", "src/app.js", "index.ts", "index.js", "server.ts", "server.js"
  ]);
  const entrypoints = filePaths.filter((path) => preferredNames.has(path));
  if (packageJson && filePaths.includes("package.json")) entrypoints.unshift("package.json");
  return [...new Set(entrypoints)].slice(0, MAX_ENTRYPOINTS);
}

function directEntrypointSignals(entrypoints: readonly string[]): ContextMapEntryPoint[] {
  return entrypoints.map((path) => ({
    path,
    kind: path === "package.json" ? "package" as const : "runtime" as const,
    reason: path === "package.json"
      ? "Directly discovered project manifest."
      : "Directly discovered conventional runtime entrypoint."
  }));
}

function mergeEntrypointSignals(
  discovered: readonly ContextMapEntryPoint[],
  direct: readonly ContextMapEntryPoint[]
): ContextMapEntryPoint[] {
  const byPath = new Map<string, ContextMapEntryPoint>();
  for (const entry of [...direct, ...discovered]) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  return [...byPath.values()];
}

function frameworkSignalsForProjectType(projectType: string | undefined): string[] {
  return projectType && ["mcp-server", "nextjs-app", "vite-app"].includes(projectType) ? [projectType] : [];
}

function detectTestCommands(scripts: Array<{ name: string; command: string }>, filePaths: string[]): string[] {
  const commands = scripts
    .filter((script) => /test|lint|typecheck|build/i.test(script.name))
    .map((script) => `npm run ${script.name}`);
  if (commands.length > 0) return commands;
  if (filePaths.some((path) => path.endsWith("pytest.ini") || path.startsWith("tests/"))) return ["pytest"];
  return [];
}

function isDocCandidate(path: string, include: Set<ProjectBriefInclude>): boolean {
  const lower = path.toLowerCase();
  if (include.has("readme") && /(^|\/)readme\.md$/.test(lower)) return true;
  if (include.has("architecture") && /(^|\/)(architecture|arch|design|overview)\.md$/.test(lower)) return true;
  if (include.has("todos") && /(^|\/)(todo|todos|roadmap)\.md$/.test(lower)) return true;
  return false;
}

function compareDocCandidates(left: string, right: string): number {
  const score = (path: string): number => {
    const lower = path.toLowerCase();
    if (lower === "readme.md") return 0;
    if (lower === "docs/architecture.md") return 10;
    if (lower === "docs/design.md" || lower === "docs/overview.md") return 20;
    if (lower === "docs/roadmap.md") return 30;
    if (/(^|\/)readme\.md$/.test(lower)) return 40;
    if (/(^|\/)(architecture|arch|design|overview)\.md$/.test(lower)) return 50;
    return 60;
  };
  return score(left) - score(right) || left.localeCompare(right);
}

function summarizeMarkdown(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => line.startsWith("#"));
  const firstBody = lines.find((line) => !line.startsWith("#"));
  return [heading, firstBody].filter(Boolean).join(" ").slice(0, 240);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
