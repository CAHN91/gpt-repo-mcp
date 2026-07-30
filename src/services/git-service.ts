import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { internalAgentArtifactGitExcludes, isInternalAgentArtifact } from "../policies/internal-agent-artifacts.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { validateRepoPath } from "./path-sandbox.js";
import { runGitBounded } from "./git-exec.js";

const STATUS_LIMIT = 16 * 1024 * 1024;
const SMALL_GIT_LIMIT = 1024 * 1024;

export type GitPathState = {
  path: string;
  exists: boolean;
  kind: "file" | "symlink" | "missing" | "other";
  head_blob_sha256?: string;
  content_sha256: string;
};

export class GitService {
  constructor(private readonly root: string) {}

  async status() {
    const [branch, headSha, porcelain] = await Promise.all([
      this.gitText(["rev-parse", "--abbrev-ref", "HEAD"], SMALL_GIT_LIMIT),
      this.gitText(["rev-parse", "HEAD"], SMALL_GIT_LIMIT),
      this.gitText(["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ...internalAgentArtifactGitExcludes()], STATUS_LIMIT)
    ]);
    const files = porcelain.split("\n").filter(Boolean).map(parseStatusLine)
      .filter((file) => !isInternalAgentArtifact(file.path) && !isInternalAgentArtifact(file.original_path ?? ""));
    const counts: Record<string, number> = {};
    for (const file of files) {
      const key = `${file.index}${file.worktree}`.trim() || "clean";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return { branch: branch.trim(), head_sha: headSha.trim(), clean: files.length === 0, files, counts };
  }

  async diff(options: {
    base?: string;
    compare?: string;
    staged?: boolean;
    unstaged?: boolean;
    paths?: string[];
    max_bytes?: number;
    context_lines?: number;
    max_files?: number;
  }) {
    const requestedPaths = options.paths?.map(validateRepoPath);
    const candidatePaths = requestedPaths ?? await this.diffPathNames(options);
    const totalFileCount = candidatePaths.length;
    const selectedPaths = options.max_files ? candidatePaths.slice(0, options.max_files) : candidatePaths;
    const fileLimitTruncated = selectedPaths.length < totalFileCount;
    if (selectedPaths.length === 0) {
      return {
        base: options.base, compare: options.compare, staged: options.staged, unstaged: options.unstaged,
        files: [], total_file_count: totalFileCount, truncated: fileLimitTruncated,
        truncation_reason: fileLimitTruncated ? "max_files" as const : undefined,
        warnings: fileLimitTruncated ? [`Diff limited to ${selectedPaths.length} of ${totalFileCount} changed paths by max_files.`] : []
      };
    }
    const args = this.diffArgs(options, false);
    if (requestedPaths || fileLimitTruncated) {
      const expandedPaths = await this.expandRenamePaths(selectedPaths);
      args.push("--", ...expandedPaths);
    } else {
      args.push("--", ".", ...internalAgentArtifactGitExcludes());
    }
    const maxBytes = Math.min(options.max_bytes ?? DEFAULT_LIMITS.max_diff_bytes, DEFAULT_LIMITS.max_diff_bytes);
    const result = await runGitBounded({
      root: this.root,
      args,
      max_stdout_bytes: maxBytes,
      allow_stdout_truncation: true
    });
    const files = parseDiff(result.stdout).filter(
      (file) => !isInternalAgentArtifact(file.path) && !isInternalAgentArtifact(file.original_path ?? "")
    );
    const truncated = fileLimitTruncated || result.stdout_truncated;
    const reasons = [fileLimitTruncated ? "max_files" : undefined, result.stdout_truncated ? "max_bytes" : undefined].filter(Boolean);
    return {
      base: options.base,
      compare: options.compare,
      staged: options.staged,
      unstaged: options.unstaged,
      files,
      total_file_count: totalFileCount,
      truncated,
      truncation_reason: reasons.length === 0 ? undefined : reasons.join("+") as "max_files" | "max_bytes" | "max_files+max_bytes",
      warnings: [
        ...(fileLimitTruncated ? [`Diff limited to ${selectedPaths.length} of ${totalFileCount} changed paths by max_files.`] : []),
        ...(result.stdout_truncated ? [`Diff content truncated by max_bytes (${maxBytes}); Git completed successfully.`] : [])
      ]
    };
  }

  async pathStates(paths: readonly string[]): Promise<GitPathState[]> {
    const normalized = [...new Set(paths.map(validateRepoPath))].sort((a, b) => a.localeCompare(b));
    const states: GitPathState[] = [];
    for (const path of normalized) states.push(await this.pathState(path));
    return states;
  }

  async contentFingerprint(paths: readonly string[]): Promise<string> {
    const states = await this.pathStates(paths);
    if (states.length === 0) return "clean";
    const hash = createHash("sha256");
    for (const state of states) hash.update(JSON.stringify(state)).update("\0");
    return hash.digest("hex");
  }

  async reviewStateFingerprint(paths?: readonly string[]): Promise<string> {
    const selected = paths ? [...paths] : await this.changedProjectPaths(true);
    return this.contentFingerprint(selected);
  }

  async worktreeFingerprint(): Promise<string> {
    return this.contentFingerprint(await this.changedProjectPaths(true));
  }

  private async changedProjectPaths(excludeChatgpt: boolean): Promise<string[]> {
    const status = await this.status();
    return [...new Set(status.files.flatMap((file) => [file.original_path, file.path])
      .filter((path): path is string => Boolean(path))
      .filter((path) => !excludeChatgpt || !path.startsWith(".chatgpt/")))]
      .sort((a, b) => a.localeCompare(b));
  }

  private async pathState(path: string): Promise<GitPathState> {
    const absolute = join(this.root, path);
    let exists = true;
    let kind: GitPathState["kind"] = "file";
    let contentSha: string;
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        kind = "symlink";
        contentSha = createHash("sha256").update(await readlink(absolute)).digest("hex");
      } else if (stat.isFile()) {
        contentSha = await hashFile(absolute);
      } else {
        kind = "other";
        contentSha = createHash("sha256").update(`other:${stat.mode}:${stat.size}`).digest("hex");
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      exists = false;
      kind = "missing";
      contentSha = createHash("sha256").update("missing").digest("hex");
    }
    return {
      path,
      exists,
      kind,
      content_sha256: contentSha
    };
  }

  private async expandRenamePaths(paths: readonly string[]): Promise<string[]> {
    const selected = new Set(paths);
    const status = await this.status();
    return [...new Set(status.files.flatMap((entry) => {
      if (selected.has(entry.path) || (entry.original_path && selected.has(entry.original_path))) {
        return [entry.original_path, entry.path].filter((path): path is string => Boolean(path));
      }
      return selected.has(entry.path) ? [entry.path] : [];
    }).concat([...selected]))].sort((left, right) => left.localeCompare(right));
  }

  private async diffPathNames(options: { base?: string; compare?: string; staged?: boolean }): Promise<string[]> {
    const args = this.diffArgs(options, true);
    args.push("--", ".", ...internalAgentArtifactGitExcludes());
    const text = await this.gitText(args, STATUS_LIMIT);
    return [...new Set(text.split("\0").filter(Boolean).filter((path) => !isInternalAgentArtifact(path)))].sort((a, b) => a.localeCompare(b));
  }

  private diffArgs(options: { base?: string; compare?: string; staged?: boolean; context_lines?: number }, namesOnly: boolean): string[] {
    const args = ["diff", "--find-renames"];
    if (namesOnly) args.push("--name-only", "-z");
    else args.push(`--unified=${options.context_lines ?? 3}`);
    if (options.staged) args.push("--cached");
    if (options.base && options.compare) args.push(`${options.base}...${options.compare}`);
    else if (options.base) args.push(options.base);
    return args;
  }

  private async gitText(args: string[], maxBytes: number): Promise<string> {
    const result = await runGitBounded({ root: this.root, args, max_stdout_bytes: maxBytes });
    return result.stdout;
  }

}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}


type StatusFile = { path: string; original_path?: string; index: string; worktree: string };
type DiffFile = { path: string; original_path?: string; status?: string; hunks: string[] };

function parseStatusLine(line: string): StatusFile {
  const index = line.slice(0, 1);
  const worktree = line.slice(1, 2);
  const rawPath = line.slice(3);
  if (index === "R" || index === "C") {
    const [originalPath, path] = rawPath.split(" -> ");
    return { index, worktree, path: path ?? rawPath, original_path: originalPath };
  }
  return { index, worktree, path: rawPath };
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let currentHunk: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        if (currentHunk.length) current.hunks.push(currentHunk.join("\n"));
        files.push(current);
      }
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: match?.[2] ?? "unknown", hunks: [] };
      currentHunk = [];
      continue;
    }
    if (!current) continue;
    if (line.startsWith("rename from ")) { current.original_path = line.slice(12); current.status = "renamed"; continue; }
    if (line.startsWith("rename to ")) { current.path = line.slice(10); current.status = "renamed"; continue; }
    if (line.startsWith("new file mode ")) { current.status = "added"; continue; }
    if (line.startsWith("deleted file mode ")) { current.status = "deleted"; continue; }
    if (line.startsWith("@@")) {
      current.status ??= "modified";
      if (currentHunk.length) current.hunks.push(currentHunk.join("\n"));
      currentHunk = [line];
      continue;
    }
    if (currentHunk.length) currentHunk.push(line);
  }
  if (current) {
    if (currentHunk.length) current.hunks.push(currentHunk.join("\n"));
    files.push(current);
  }
  return files;
}
