import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import { RepoReaderError } from "../runtime/errors.js";
import { normalizeRepoPath } from "./ignore-engine.js";

export type BoundaryClassification =
  | { kind: "normal"; path: string }
  | { kind: "nested_repo"; path: string }
  | { kind: "submodule"; path: string };

export class PathSandbox {
  constructor(private readonly root: string) {}

  async resolve(repoPath: string): Promise<{
    repoPath: string;
    canonicalRepoPath: string;
    absolutePath: string;
    stat: Awaited<ReturnType<typeof lstat>>;
  }> {
    const normalized = validateRepoPath(repoPath);
    const absolutePath = join(this.root, normalized);
    const [rootReal, targetReal, stat] = await Promise.all([
      realpath(this.root),
      realpath(absolutePath),
      lstat(absolutePath)
    ]);

    if (!isWithin(rootReal, targetReal)) {
      throw new RepoReaderError("SYMLINK_ESCAPE_REJECTED", `Path escapes approved repository: ${normalized}`);
    }
    if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
      throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Unsupported file type: ${normalized}`);
    }

    return {
      repoPath: normalized,
      canonicalRepoPath: toRepoPath(relative(rootReal, targetReal)),
      absolutePath: targetReal,
      stat
    };
  }

  async classifyBoundary(repoPath: string): Promise<BoundaryClassification> {
    const normalized = validateRepoPath(repoPath);
    const absolutePath = join(this.root, normalized);

    try {
      const dotGit = await lstat(join(absolutePath, ".git"));
      if (dotGit.isDirectory()) {
        return { kind: "nested_repo", path: normalized };
      }
      if (dotGit.isFile()) {
        return { kind: "submodule", path: normalized };
      }
    } catch {
      // Absence of .git means normal boundary.
    }

    return { kind: "normal", path: normalized };
  }
}

export function validateRepoPath(repoPath: string): string {
  if (repoPath.length === 0) {
    return ".";
  }
  if (repoPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(repoPath)) {
    throw new RepoReaderError("ABSOLUTE_PATH_REJECTED", `Absolute paths are not allowed: ${repoPath}`);
  }

  const normalized = posix.normalize(normalizeRepoPath(repoPath));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new RepoReaderError("PATH_TRAVERSAL_REJECTED", `Path traversal is not allowed: ${repoPath}`);
  }
  return normalized === "." ? "." : normalized.replace(/^\.\//, "");
}

function isWithin(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function toRepoPath(platformRelativePath: string): string {
  if (platformRelativePath === "") {
    return ".";
  }
  return platformRelativePath.split(sep).join(posix.sep);
}
