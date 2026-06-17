import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { validateRepoPath } from "./path-sandbox.js";
import { SecretScanner } from "./secret-scanner.js";

const execFileAsync = promisify(execFile);
const GIT_REF_MAX_LENGTH = 200;
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@+~^-]*$/;

export class GitService {
  private readonly secretScanner = new SecretScanner();

  constructor(private readonly root: string) {}

  async status() {
    const [branch, headSha, porcelain] = await Promise.all([
      this.git(["rev-parse", "--abbrev-ref", "HEAD"]),
      this.git(["rev-parse", "HEAD"]),
      this.git(["status", "--porcelain=v1", "--untracked-files=all"])
    ]);
    const files = porcelain.split("\n").filter(Boolean).map(parseStatusLine);
    const counts: Record<string, number> = {};
    for (const file of files) {
      const key = `${file.index}${file.worktree}`.trim() || "clean";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return {
      branch: branch.trim(),
      head_sha: headSha.trim(),
      clean: files.length === 0,
      files,
      counts
    };
  }

  async diff(options: {
    base?: string;
    compare?: string;
    staged?: boolean;
    unstaged?: boolean;
    paths?: string[];
    max_bytes?: number;
    context_lines?: number;
  }) {
    const paths = options.paths?.map(validateRepoPath);
    const base = options.base ? validateGitRevision(options.base, "base") : undefined;
    const compare = options.compare ? validateGitRevision(options.compare, "compare") : undefined;
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", `--unified=${options.context_lines ?? 3}`];
    if (options.staged) {
      args.push("--cached");
    }
    if (base && compare) {
      args.push(`${base}...${compare}`);
    } else if (base) {
      args.push(base);
    }
    args.push("--", ...(paths ?? []));
    const maxBytes = Math.min(options.max_bytes ?? DEFAULT_LIMITS.max_diff_bytes, DEFAULT_LIMITS.max_diff_bytes);
    const raw = await this.git(args, DEFAULT_LIMITS.max_diff_bytes + 1);
    const truncated = Buffer.byteLength(raw) > maxBytes;
    const text = this.secretScanner.redact(truncated ? raw.slice(0, maxBytes) : raw);
    return {
      base,
      compare,
      staged: options.staged,
      unstaged: options.unstaged,
      files: parseDiff(text),
      truncated,
      warnings: truncated
        ? [`Diff truncated by max_bytes (${maxBytes}). Increase max_bytes or pass paths to narrow the diff before reviewing.`]
        : []
    };
  }

  private async git(args: string[], maxBuffer: number = DEFAULT_LIMITS.max_diff_bytes): Promise<string> {
    try {
      const result = await execFileAsync("git", args, {
        cwd: this.root,
        maxBuffer,
        env: { PATH: process.env.PATH ?? "" }
      });
      return result.stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git command failed";
      throw new RepoReaderError("GIT_ERROR", message);
    }
  }
}

function validateGitRevision(ref: string, label: "base" | "compare"): string {
  if (
    ref.length === 0 ||
    ref.length > GIT_REF_MAX_LENGTH ||
    ref.trim() !== ref ||
    ref.startsWith("-") ||
    hasUnsafeGitRevisionCharacter(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock") ||
    !SAFE_GIT_REF_PATTERN.test(ref)
  ) {
    throw new RepoReaderError("VALIDATION_ERROR", `Invalid git ${label} revision.`);
  }
  return ref;
}

function hasUnsafeGitRevisionCharacter(ref: string): boolean {
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || char === "\\" || char === ":") {
      return true;
    }
  }
  return false;
}

type StatusFile = {
  path: string;
  original_path?: string;
  index: string;
  worktree: string;
};

type DiffFile = {
  path: string;
  original_path?: string;
  status?: string;
  hunks: string[];
};

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

function parseDiff(diff: string) {
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
    if (!current) {
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.original_path = line.slice("rename from ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("new file mode ")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("@@")) {
      current.status ??= "modified";
      if (currentHunk.length) current.hunks.push(currentHunk.join("\n"));
      currentHunk = [line];
      continue;
    }
    if (currentHunk.length) {
      currentHunk.push(line);
    }
  }
  if (current) {
    if (currentHunk.length) current.hunks.push(currentHunk.join("\n"));
    files.push(current);
  }
  return files;
}
