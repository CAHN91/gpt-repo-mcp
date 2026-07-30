import { realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";

const ALLOWED_ENV_TEMPLATE_PATHS = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  "example.env"
]);

export function gitOperationEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {})
  };
}

export async function assertExistingParentWithinRoot(root: string, repoPath: string): Promise<void> {
  let parent = dirname(repoPath);
  while (parent !== ".") {
    const absoluteParent = join(root, parent);
    try {
      await assertRealPathWithinRoot(root, absoluteParent);
      return;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      parent = dirname(parent);
    }
  }
  await assertRealPathWithinRoot(root, root);
}

export async function assertRealPathWithinRoot(root: string, target: string): Promise<void> {
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  const rel = relative(resolve(rootReal), resolve(targetReal));
  if (rel !== "" && (rel.startsWith("..") || rel.includes(`..${sep}`))) {
    throw new RepoReaderError("SYMLINK_ESCAPE_REJECTED", `Path escapes approved repository: ${target}`);
  }
}

export function samePathSet(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

export function assertNoDuplicateDeletionPaths(
  cleanupPreview: Array<{ path: string }>,
  discardPreview: Array<{ path: string }>
): void {
  const cleanupPaths = new Set(cleanupPreview.map((entry) => entry.path));
  const duplicate = discardPreview.find((entry) => cleanupPaths.has(entry.path));
  if (duplicate) {
    throw new RepoReaderError("GIT_OPERATION_UNSAFE_PATHSPEC", "Recovery path appears in multiple deletion phases.", {
      diagnostics: { failed_path: duplicate.path }
    });
  }
}

export function isGeneratedOrDependencyPath(path: string): boolean {
  return /(^|\/)(node_modules|dist|coverage|test-results|\.cache|\.next)(\/|$)/.test(path);
}

export function isAllowedEnvTemplatePath(repoPath: string): boolean {
  return ALLOWED_ENV_TEMPLATE_PATHS.has(repoPath);
}

export function isHardSecretPath(repoPath: string): boolean {
  const lower = repoPath.toLowerCase();
  const base = lower.split("/").at(-1) ?? lower;
  const segments = lower.split("/");
  return (
    base === ".env"
    || base.startsWith(".env.")
    || base.endsWith(".pem")
    || base.endsWith(".key")
    || base.endsWith(".p12")
    || base.endsWith(".pfx")
    || base === "id_rsa"
    || base === "id_ed25519"
    || segments.includes("secrets")
    || segments.includes("credentials")
  );
}
