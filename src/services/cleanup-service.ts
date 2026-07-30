import ignore from "ignore";
import { execFile } from "node:child_process";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { validateRepoPath } from "./path-sandbox.js";
import { OperationsPolicy } from "./operations-policy.js";

const execFileAsync = promisify(execFile);

type CleanupInput = {
  paths: string[];
  dry_run?: boolean;
};

type CleanupTarget = {
  path: string;
  absolutePath: string;
  type: "file" | "directory";
};

export class CleanupService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(private readonly root: string, private readonly policy: OperationsPolicy) {}

  async cleanup(input: CleanupInput) {
    this.policy.assertCleanupAllowed(input.paths);
    const matcher = ignore().add(this.policy.config.cleanup_allowed_globs);
    const targets = await Promise.all(input.paths.map((path) => this.resolveTarget(path, matcher)));
    const existingTargets = targets.filter((target): target is CleanupTarget => target !== undefined);

    if (!input.dry_run) {
      for (const target of existingTargets) {
        await rm(target.absolutePath, { recursive: target.type === "directory" });
      }
    }

    return {
      ok: true as const,
      dry_run: input.dry_run ?? false,
      deleted: existingTargets.map((target) => ({ path: target.path, type: target.type })),
      skipped: targets.flatMap((target, index) => target ? [] : [{ path: input.paths[index] ?? "", reason: "NOT_FOUND" }]),
      warnings: []
    };
  }

  private async resolveTarget(path: string, matcher: ReturnType<typeof ignore>): Promise<CleanupTarget | undefined> {
    const repoPath = this.validateCleanupPath(path, matcher);
    const absolutePath = join(this.root, repoPath);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(absolutePath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }

    if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
      throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Unsupported cleanup target: ${repoPath}`);
    }
    await assertWithinRoot(this.root, absolutePath);
    await this.assertUntracked(repoPath);

    if (stat.isDirectory()) {
      await this.assertDirectorySafe(repoPath, absolutePath);
      return { path: repoPath, absolutePath, type: "directory" };
    }
    return { path: repoPath, absolutePath, type: "file" };
  }

  private validateCleanupPath(path: string, matcher: ReturnType<typeof ignore>): string {
    const repoPath = validateRepoPath(path);
    if (
      repoPath === "."
      || repoPath === "*"
      || /[*?[\]{}]/.test(repoPath)
      || /[\0\r\n;&|`$<>]/.test(repoPath)
      || repoPath.startsWith(":")
      || repoPath.startsWith("-")
    ) {
      throw new RepoReaderError("CLEANUP_UNSAFE_PATH", `Unsafe cleanup path rejected: ${path}`);
    }
    if (repoPath === ".git" || repoPath.startsWith(".git/")) {
      throw new RepoReaderError("CLEANUP_UNSAFE_PATH", `Git internals cannot be cleaned up: ${path}`);
    }
    if (this.ignoreEngine.isSensitiveCandidate(repoPath)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret candidate blocked: ${repoPath}`);
    }
    if (!matcher.ignores(repoPath) && !matcher.ignores(`${repoPath}/placeholder`)) {
      throw new RepoReaderError("CLEANUP_NOT_ALLOWED_GLOB", `Path is outside cleanup_allowed_globs: ${repoPath}`);
    }
    return repoPath;
  }

  private async assertDirectorySafe(repoPath: string, absolutePath: string): Promise<void> {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      const childRepoPath = `${repoPath}/${entry.name}`;
      const childAbsolutePath = join(absolutePath, entry.name);
      const stat = await lstat(childAbsolutePath);
      if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
        throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Unsupported cleanup target: ${childRepoPath}`);
      }
      await assertWithinRoot(this.root, childAbsolutePath);
      if (stat.isDirectory()) {
        await this.assertDirectorySafe(childRepoPath, childAbsolutePath);
      }
    }
  }

  private async assertUntracked(repoPath: string): Promise<void> {
    const trackedPaths = await this.trackedPathsUnder(repoPath);
    if (trackedPaths.length > 0) {
      throw new RepoReaderError("CLEANUP_TRACKED_PATH", `Cleanup target is tracked by git: ${repoPath}`, {
        diagnostics: { actual_paths: trackedPaths }
      });
    }
  }

  private async trackedPathsUnder(repoPath: string): Promise<string[]> {
    try {
      const result = await execFileAsync("git", ["ls-files", "--", repoPath], {
        cwd: this.root,
        env: { PATH: process.env.PATH ?? "" },
        maxBuffer: 128 * 1024
      });
      return result.stdout.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}

async function assertWithinRoot(root: string, target: string): Promise<void> {
  const [rootReal, targetReal] = await Promise.all([
    realpath(root),
    realpath(target)
  ]);
  const rel = relative(resolve(rootReal), resolve(targetReal));
  if (rel !== "" && (rel.startsWith("..") || rel.includes(`..${sep}`))) {
    throw new RepoReaderError("SYMLINK_ESCAPE_REJECTED", "Path escapes approved repository.");
  }
}
