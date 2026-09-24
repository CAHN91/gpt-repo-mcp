import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export async function atomicWriteFile(path: string, content: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, content);
    await renameWithTransientRetry(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithTransientRetry(from: string, to: string): Promise<void> {
  let retryIndex = 0;
  while (true) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (
        process.platform !== "win32"
        || !isTransientWindowsRenameError(error)
        || retryIndex >= WINDOWS_RENAME_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleep(WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex]!);
      retryIndex += 1;
    }
  }
}

function isTransientWindowsRenameError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export function isNotFoundError(error: unknown): boolean {
  return hasFsErrorCode(error, "ENOENT");
}

export function isAlreadyExistsError(error: unknown): boolean {
  return hasFsErrorCode(error, "EEXIST");
}

function hasFsErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === code
  );
}
