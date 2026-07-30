import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicWriteJson, isNotFoundError } from "../runtime/fs-helpers.js";
import { RepoReaderConfigSchema, type RepoReaderConfig } from "./schema.js";

export function resolveConfigPath(options: {
  cliConfigPath?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): string {
  const selected = options.cliConfigPath
    ?? options.env.GPT_REPO_CONFIG
    ?? options.env.REPO_READER_CONFIG
    ?? "./config.local.json";
  return resolve(options.cwd, selected);
}

export async function loadConfig(configPath: string): Promise<RepoReaderConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return RepoReaderConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isNotFoundError(error)) {
      return RepoReaderConfigSchema.parse({});
    }
    throw error;
  }
}

export async function readConfigDocument(configPath: string): Promise<unknown> {
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw);
}

export async function writeConfigAtomic(configPath: string, config: RepoReaderConfig): Promise<void> {
  await atomicWriteJson(configPath, config);
}
