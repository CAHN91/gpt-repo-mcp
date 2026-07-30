import ignore from "ignore";
import { DEFAULT_EXCLUDES } from "../policies/default-excludes.js";
import { RepoReaderError } from "../runtime/errors.js";
import type { RepoConfig } from "./root-registry.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { validateRepoPath } from "./path-sandbox.js";
import { WritePolicy } from "./write-policy.js";
import { OperationsPolicy } from "./operations-policy.js";

export type PolicyExplainOptions = {
  path?: string;
  operation?: "read" | "write" | "cleanup" | "validation";
};

type Decision = {
  allowed: boolean;
  code: string;
  reason: string;
  matched_globs: string[];
  notes: string[];
};

export class PolicyExplainService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(private readonly repo: RepoConfig) {}

  explain(options: PolicyExplainOptions) {
    const pathResult = options.path ? normalizeForPolicy(options.path) : undefined;
    const path = pathResult?.path;
    const writePolicy = new WritePolicy(this.repo.writes);
    const operationsPolicy = new OperationsPolicy(this.repo.operations);

    const read = this.explainRead(path, pathResult?.error);
    const write = this.explainWrite(path, pathResult?.error, writePolicy);
    const cleanup = this.explainCleanup(path, pathResult?.error, operationsPolicy);
    const validation = this.explainValidation(operationsPolicy);
    const operations = {
      enabled: operationsPolicy.config.enabled,
      git_stage_enabled: operationsPolicy.config.git_stage_enabled,
      git_commit_enabled: operationsPolicy.config.git_commit_enabled,
      validation_enabled: operationsPolicy.config.validation_enabled,
      cleanup_enabled: operationsPolicy.config.cleanup_enabled,
      max_paths_per_operation: operationsPolicy.config.max_paths_per_operation
    };

    const focused = options.operation ? { read, write, cleanup, validation }[options.operation] : undefined;
    const summary = focused
      ? `${options.operation} policy for ${path ?? "this repository"}: ${focused.reason}`
      : summarize(path, read, write, cleanup, operationsPolicy.config.enabled);

    return {
      ok: true as const,
      repo_id: this.repo.repo_id,
      ...(path ? { path } : {}),
      ...(options.operation ? { requested_operation: options.operation } : {}),
      summary,
      read,
      write,
      cleanup,
      validation,
      operations,
      effective_policy: {
        write_enabled: writePolicy.config.enabled,
        write_allowed_globs: writePolicy.config.allowed_globs,
        write_denied_globs: writePolicy.config.denied_globs,
        max_bytes_per_write: writePolicy.config.max_bytes_per_write,
        default_read_excludes: [...DEFAULT_EXCLUDES],
        cleanup_allowed_globs: operationsPolicy.config.cleanup_allowed_globs
      },
      guidance: guidance(path, read, write, cleanup, validation, operationsPolicy.config.enabled)
    };
  }

  private explainRead(path: string | undefined, pathError: RepoReaderError | undefined): Decision {
    if (!path) {
      return allowed("GENERAL_READ_POLICY", "Read tools are enabled for approved repositories and enforce default excludes, secret-candidate blocking, binary-file blocking, and size limits.", [], [
        "There is no per-repo read allowlist in config; reads are constrained by approved roots, default excludes, path sandboxing, secret checks, file type checks, and size limits."
      ]);
    }
    if (pathError) {
      return blocked(pathError.code, pathError.message, [], ["Use repo-relative POSIX paths only."]);
    }
    if (this.ignoreEngine.isSensitiveCandidate(path)) {
      return blocked("SECRET_CANDIDATE_BLOCKED", `Read tools block secret-looking paths such as ${path}.`, [], [
        "Default-exclude override does not bypass secret-candidate blocking."
      ]);
    }
    const matchedDefaultExcludes = matchingGlobs(path, [...DEFAULT_EXCLUDES]);
    if (matchedDefaultExcludes.length > 0) {
      return blocked("DEFAULT_EXCLUDE_BLOCKED", `${path} is blocked by default read excludes unless repo_fetch_file uses override_default_excludes.`, matchedDefaultExcludes, [
        "Generated/default-excluded files can only be fetched with repo_fetch_file and override_default_excludes: true.",
        "Search, tree, and read_many respect default excludes by default."
      ]);
    }
    return allowed("ALLOWED", `${path} is readable if it exists, is a regular UTF-8 text file, stays within size limits, and does not contain blocked secret values.`, [], []);
  }

  private explainWrite(path: string | undefined, pathError: RepoReaderError | undefined, policy: WritePolicy): Decision {
    if (!path) {
      return policy.config.enabled
        ? allowed("GENERAL_WRITE_POLICY", "Writes are enabled for this repository and are constrained by allowed globs, denied globs, hard secret paths, resulting-content secret scans, and size limits.", policy.config.allowed_globs, [])
        : blocked("WRITE_DISABLED", "Writes are disabled for this repository.", [], ["Use npm run add -- <path> --mode write or --mode ship, or enable writes in config.local.json for trusted repositories."]);
    }
    if (pathError) {
      return blocked(pathError.code, pathError.message, [], ["Use repo-relative POSIX paths only."]);
    }
    try {
      policy.assertAllowed({ path, bytes: 0, action: "write" });
      return allowed("ALLOWED", `${path} is writable by repo_write_file/repo_write_changes when content also passes size and secret scans.`, matchingGlobs(path, policy.config.allowed_globs), []);
    } catch (error) {
      const repoError = error instanceof RepoReaderError ? error : new RepoReaderError("INTERNAL_ERROR", "Unexpected policy error.");
      return blocked(repoError.code, repoError.message, matchingGlobs(path, policy.config.denied_globs), writeNotes(repoError.code));
    }
  }

  private explainCleanup(path: string | undefined, pathError: RepoReaderError | undefined, policy: OperationsPolicy): Decision {
    if (!path) {
      if (!policy.config.enabled) {
        return blocked("OPERATIONS_DISABLED", "Local operations are disabled for this repository.", [], ["Use --mode ship for trusted repositories when local validation, stage, commit, recover, and cleanup should be available."]);
      }
      if (!policy.config.cleanup_enabled) {
        return blocked("CLEANUP_DISABLED", "Cleanup operations are disabled for this repository.", [], []);
      }
      return allowed("GENERAL_CLEANUP_POLICY", "Cleanup is enabled for explicit untracked generated/local artifact paths matching cleanup_allowed_globs.", policy.config.cleanup_allowed_globs, [
        "Cleanup refuses tracked files even when they match cleanup_allowed_globs."
      ]);
    }
    if (pathError) {
      return blocked(pathError.code, pathError.message, [], ["Use repo-relative POSIX paths only."]);
    }
    if (!policy.config.enabled) {
      return blocked("OPERATIONS_DISABLED", "Local operations are disabled for this repository.", [], []);
    }
    if (!policy.config.cleanup_enabled) {
      return blocked("CLEANUP_DISABLED", "Cleanup operations are disabled for this repository.", [], []);
    }
    if (this.ignoreEngine.isSensitiveCandidate(path)) {
      return blocked("SECRET_CANDIDATE_BLOCKED", `Cleanup blocks secret-looking paths such as ${path}.`, [], []);
    }
    const matcher = ignore().add(policy.config.cleanup_allowed_globs);
    const matched = matchingGlobs(path, policy.config.cleanup_allowed_globs);
    if (!matcher.ignores(path) && !matcher.ignores(`${path}/placeholder`)) {
      return blocked("CLEANUP_NOT_ALLOWED_GLOB", `${path} is outside cleanup_allowed_globs.`, matched, []);
    }
    return allowed("ALLOWED", `${path} is cleanup-eligible if it exists and is untracked by git.`, matched, [
      "Cleanup refuses tracked files and does not run git clean."
    ]);
  }

  private explainValidation(policy: OperationsPolicy): Decision {
    if (!policy.config.enabled) {
      return blocked("OPERATIONS_DISABLED", "Local operations are disabled for this repository.", [], [
        "Use --mode ship for trusted repositories when local validation, stage, commit, recover, and cleanup should be available."
      ]);
    }
    if (!policy.config.validation_enabled) {
      return blocked("VALIDATION_DISABLED", "Validation operations are disabled for this repository.", [], [
        "Enable operations.validation_enabled for trusted repositories that should run allowlisted validation profiles."
      ]);
    }
    return allowed("GENERAL_VALIDATION_POLICY", "Validation is enabled for allowlisted project runner profiles.", [], [
      "repo_validate prioritizes matching npm scripts, safely selects an exact repo-declared Node.js version when already installed, and may use pytest fallback for detected Python tests; it never installs runtimes, accepts command strings, or uses a shell."
    ]);
  }
}

function normalizeForPolicy(path: string): { path?: string; error?: RepoReaderError } {
  try {
    return { path: validateRepoPath(path) };
  } catch (error) {
    return { error: error instanceof RepoReaderError ? error : new RepoReaderError("INTERNAL_ERROR", "Unexpected path policy error.") };
  }
}

function matchingGlobs(path: string, globs: string[]): string[] {
  return globs.filter((glob) => ignore().add(glob).ignores(path));
}

function allowed(code: string, reason: string, matchedGlobs: string[], notes: string[]): Decision {
  return { allowed: true, code, reason, matched_globs: matchedGlobs, notes };
}

function blocked(code: string, reason: string, matchedGlobs: string[], notes: string[]): Decision {
  return { allowed: false, code, reason, matched_globs: matchedGlobs, notes };
}

function writeNotes(code: string): string[] {
  if (code === "WRITE_DISABLED") {
    return ["Use npm run add -- <path> --mode write or --mode ship for trusted repositories."];
  }
  if (code === "WRITE_DENIED_GLOB" || code === "SECRET_CANDIDATE_BLOCKED") {
    return ["Denied globs and hard secret path checks win over allowed globs."];
  }
  if (code === "WRITE_NOT_ALLOWED_GLOB") {
    return ["For clone-based solo-dev setup, --mode write and --mode ship use a broad write policy with hard denies."];
  }
  return [];
}

function summarize(path: string | undefined, read: Decision, write: Decision, cleanup: Decision, operationsEnabled: boolean): string {
  if (!path) {
    return operationsEnabled
      ? "Repository policy loaded; writes and local operations depend on the effective toggles and globs below."
      : "Repository policy loaded; local operations are disabled and writes depend on writes.enabled.";
  }
  if (!write.allowed) {
    return `Write to ${path} is blocked: ${write.reason}`;
  }
  if (!read.allowed) {
    return `Read of ${path} is blocked or constrained: ${read.reason}`;
  }
  if (!cleanup.allowed) {
    return `${path} is readable and writable, but cleanup is blocked or constrained: ${cleanup.reason}`;
  }
  return `${path} is readable, writable, and cleanup-eligible under the current policy constraints.`;
}

function guidance(path: string | undefined, read: Decision, write: Decision, cleanup: Decision, validation: Decision, operationsEnabled: boolean): string[] {
  const items: string[] = [];
  if (!path) {
    items.push("Pass a repo-relative path to explain exactly why a specific read, write, or cleanup call would be allowed or blocked.");
  }
  if (!write.allowed) {
    items.push(`For write failures, check write.code=${write.code} and compare the path against effective_policy.write_allowed_globs and write_denied_globs.`);
  }
  if (!read.allowed) {
    items.push(`For read failures, check read.code=${read.code}; override_default_excludes can help only for default-excluded non-secret files.`);
  }
  if (!cleanup.allowed && operationsEnabled) {
    items.push(`For cleanup failures, check cleanup.code=${cleanup.code}; cleanup only deletes explicit untracked paths matching cleanup_allowed_globs.`);
  }
  if (!validation.allowed && validation.code === "VALIDATION_DISABLED") {
    items.push("Enable operations.validation_enabled for trusted repositories that should run allowlisted validation profiles.");
  }
  if (!operationsEnabled) {
    items.push("Use --mode ship for trusted repositories when local validation, stage, commit, recover, and cleanup operations should be enabled.");
  }
  return items;
}
