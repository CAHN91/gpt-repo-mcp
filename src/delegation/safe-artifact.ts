import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { RepoReaderError } from "../runtime/errors.js";
import { atomicWriteJson, isNotFoundError } from "../runtime/fs-helpers.js";

// Shared boundary for repository-owned delegation artifacts.
export async function readSafeRunArtifact(root: string, path: string, maxBytes: number): Promise<string | undefined> {
  const absolute = join(root, path);
  try {
    const [rootReal, targetReal, stat] = await Promise.all([realpath(root), realpath(absolute), lstat(absolute)]);
    if (!isWithin(rootReal, targetReal) || !stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      throw artifactError(path);
    }
    return await readFile(targetReal, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

export async function assertSafeRunDirectory(root: string, path: string): Promise<void> {
  const absolute = join(root, path);
  const [rootReal, targetReal, stat] = await Promise.all([realpath(root), realpath(absolute), lstat(absolute)]);
  if (!isWithin(rootReal, targetReal) || !stat.isDirectory() || stat.isSymbolicLink()) throw artifactError(path);
}

export async function writeSafeRunJson(root: string, path: string, value: unknown): Promise<void> {
  await assertSafeRunDirectory(root, path.split("/").slice(0, -1).join("/"));
  const absolute = join(root, path);
  try {
    const [rootReal, targetReal, stat] = await Promise.all([realpath(root), realpath(absolute), lstat(absolute)]);
    if (!isWithin(rootReal, targetReal) || !stat.isFile() || stat.isSymbolicLink()) throw artifactError(path);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  await atomicWriteJson(absolute, value);
}

function isWithin(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function artifactError(path: string): RepoReaderError {
  return new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Runner artifact is missing, oversized, or unsafe.", {
    diagnostics: { path }
  });
}
