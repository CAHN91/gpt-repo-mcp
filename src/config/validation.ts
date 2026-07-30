import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { RepoReaderConfigSchema, type RepoReaderConfig } from "./schema.js";

export type ConfigIssue = {
  code: string;
  message: string;
};

export type ConfigWarning = {
  code: string;
  message: string;
};

export async function validateConfigDocument(document: unknown): Promise<{
  config?: RepoReaderConfig;
  issues: ConfigIssue[];
  warnings: ConfigWarning[];
}> {
  const parsed = RepoReaderConfigSchema.safeParse(document);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        code: "SCHEMA_INVALID",
        message: `${formatPath(issue.path)}: ${issue.message}`
      })),
      warnings: []
    };
  }

  const config = parsed.data;
  const rawRepos = getRawRepos(document);
  const issues: ConfigIssue[] = [];
  const warnings: ConfigWarning[] = [];

  const seenIds = new Set<string>();
  for (const repo of config.repos) {
    if (seenIds.has(repo.repo_id)) {
      issues.push({
        code: "DUPLICATE_REPO_ID",
        message: `Duplicate repo_id "${repo.repo_id}".`
      });
      continue;
    }
    seenIds.add(repo.repo_id);
  }

  const seenRoots = new Map<string, string>();
  for (const [index, repo] of config.repos.entries()) {
    const rootPath = resolve(repo.root);
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(rootPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        issues.push({
          code: "ROOT_MISSING",
          message: `Root does not exist for repo_id "${repo.repo_id}": ${repo.root}`
        });
        continue;
      }
      throw error;
    }

    if (!stats.isDirectory()) {
      issues.push({
        code: "ROOT_NOT_DIRECTORY",
        message: `Root is not a directory for repo_id "${repo.repo_id}": ${repo.root}`
      });
      continue;
    }

    const canonicalRoot = await realpath(rootPath);
    const duplicateOwner = seenRoots.get(canonicalRoot);
    if (duplicateOwner) {
      issues.push({
        code: "DUPLICATE_ROOT",
        message: `Duplicate root detected for repo_id "${repo.repo_id}" and "${duplicateOwner}": ${canonicalRoot}`
      });
      continue;
    }
    seenRoots.set(canonicalRoot, repo.repo_id);

    if (!repo.allow_non_git && !await looksLikeGitRepository(canonicalRoot)) {
      issues.push({
        code: "NOT_GIT_REPO",
        message: `Root is not a git repository for repo_id "${repo.repo_id}": ${canonicalRoot}`
      });
    }

    const writeGlobs = [
      ...(repo.writes?.allowed_globs ?? []),
      ...(repo.writes?.denied_globs ?? [])
    ];
    for (const glob of writeGlobs) {
      if (glob.trim().length === 0) {
        issues.push({
          code: "WRITE_GLOB_INVALID",
          message: `Write policy contains an empty glob for repo_id "${repo.repo_id}".`
        });
      }
    }

    const rawOperations = getRawOperations(rawRepos[index]);
    if (isShipLikeWithoutValidation(rawOperations)) {
      const explicitlyDisabled = hasOwn(rawOperations, "validation_enabled");
      warnings.push({
        code: "VALIDATION_NOT_ENABLED",
        message: explicitlyDisabled
          ? `Repo "${repo.repo_id}" explicitly disables validation for ship-like local operations. Runtime config preserves this opt-out.`
          : `Repo "${repo.repo_id}" uses legacy ship-like local operations with operations.validation_enabled omitted. Runtime config enables validation for this legacy shape; add validation_enabled explicitly to silence this warning.`
      });
    }
    if (isShipLikeWithoutFocusedValidation(repo.operations)) {
      warnings.push({
        code: "SHIP_VALIDATION_TEST_PATHS_NOT_CONFIGURED",
        message: `Repo "${repo.repo_id}" enables ship-like local operations without operations.validation_test_path_globs. Add focused test path globs for trusted ship-mode repos.`
      });
    }
  }

  return { config, issues, warnings };
}

function isShipLikeWithoutValidation(operations: RepoReaderConfig["repos"][number]["operations"]): boolean {
  return Boolean(
    operations?.enabled
      && operations.git_stage_enabled
      && operations.git_commit_enabled
      && operations.cleanup_enabled
      && !operations.validation_enabled
  );
}

function getRawRepos(document: unknown): unknown[] {
  if (!document || typeof document !== "object" || !("repos" in document)) {
    return [];
  }
  const repos = (document as { repos?: unknown }).repos;
  return Array.isArray(repos) ? repos : [];
}

function getRawOperations(repo: unknown): RepoReaderConfig["repos"][number]["operations"] {
  if (!repo || typeof repo !== "object" || !("operations" in repo)) {
    return undefined;
  }
  return (repo as { operations?: RepoReaderConfig["repos"][number]["operations"] }).operations;
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function isShipLikeWithoutFocusedValidation(operations: RepoReaderConfig["repos"][number]["operations"]): boolean {
  return Boolean(
    operations?.enabled
      && operations.git_stage_enabled
      && operations.git_commit_enabled
      && operations.cleanup_enabled
      && operations.validation_enabled
      && (operations.validation_test_path_globs?.length ?? 0) === 0
  );
}

async function looksLikeGitRepository(root: string): Promise<boolean> {
  try {
    await stat(join(root, ".git"));
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "config";
  }
  return `config.${path.map((segment) => String(segment)).join(".")}`;
}
