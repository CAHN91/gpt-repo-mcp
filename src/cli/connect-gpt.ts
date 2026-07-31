#!/usr/bin/env node

import { readFile, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_OPERATIONS_POLICY, SHIP_VALIDATION_TEST_PATH_GLOBS } from "../policies/operations-defaults.js";
import { DEFAULT_WRITE_POLICY } from "../policies/write-defaults.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import {
  loadConfig,
  readConfigDocument,
  resolveConfigPath,
  writeConfigAtomic
} from "../config/store.js";
import { validateConfigDocument } from "../config/validation.js";
import { runDoctor, type DoctorChecks } from "./connect-gpt-doctor.js";

type CliIo = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  stdin?: NodeJS.ReadStream;
  doctorChecks?: Partial<DoctorChecks>;
};

type AddOptions = {
  allowNonGit: boolean;
  mode?: PermissionMode;
  repoIdOverride?: string;
  displayNameOverride?: string;
  path?: string;
};

type PermissionMode = "read" | "write" | "ship";

const usage = [
  "Usage:",
  "  gpt-repo doctor [--config <path>]",
  "  gpt-repo list [--config <path>]",
  "  gpt-repo add <path> [--mode read|write|ship] [--id <repo_id>] [--name <display_name>] [--allow-non-git] [--config <path>]",
  "  gpt-repo remove <repo_id> [--config <path>]",
  "  gpt-repo check [--config <path>]",
  "",
  "Compatibility:",
  "  connect-gpt config list|add|remove|check"
].join("\n");

export async function runConnectGptCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  try {
    const { args, configOverride } = parseGlobalArgs(argv);
    const configPath = resolveConfigPath({
      cliConfigPath: configOverride,
      env: io.env,
      cwd: io.cwd
    });

    const command = normalizeCommand(args);

    if (command.name === "doctor") {
      if (args.length !== 1) {
        throw new CliError("Usage: gpt-repo doctor [--config <path>]");
      }
      return await runDoctor(configPath, io);
    }

    if (command.name === "list") {
      return await handleList(configPath, io);
    }

    if (command.name === "add") {
      return await handleAdd(command.args, configPath, io);
    }

    if (command.name === "remove") {
      return await handleRemove(command.args, configPath, io);
    }

    if (command.name === "check") {
      return await handleCheck(configPath, io);
    }

    if (args[0] !== "config") {
      throw new CliError(`Unknown command "${args[0] ?? ""}".\n${usage}`);
    }

    if (args[1] === "list") {
      return await handleList(configPath, io);
    }

    if (args[1] === "add") {
      return await handleAdd(args.slice(2), configPath, io);
    }

    if (args[1] === "remove") {
      return await handleRemove(args.slice(2), configPath, io);
    }

    if (args[1] === "check") {
      return await handleCheck(configPath, io);
    }

    throw new CliError(`Unknown config command "${args[1] ?? ""}".\n${usage}`);
  } catch (error) {
    const message = error instanceof CliError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    io.stderr(`Error: ${message}`);
    return 1;
  }
}

async function handleList(configPath: string, io: CliIo): Promise<number> {
  const config = await loadConfig(configPath);
  if (config.repos.length === 0) {
    io.stdout("No approved repositories configured. Use `gpt-repo add <path>`.");
    return 0;
  }

  io.stdout("repo_id\tdisplay_name\troot");
  for (const repo of config.repos) {
    io.stdout(`${repo.repo_id}\t${repo.display_name}\t${repo.root}`);
  }
  return 0;
}

async function handleAdd(args: string[], configPath: string, io: CliIo): Promise<number> {
  const options = parseAddArgs(args);
  if (!options.path) {
    throw new CliError("Missing path for `gpt-repo add <path>`.");
  }
  const mode = await resolvePermissionMode(options, io);

  const candidatePath = resolve(io.cwd, options.path);
  const candidateRoot = await realpath(candidatePath);
  const candidateStats = await stat(candidateRoot);
  if (!candidateStats.isDirectory()) {
    throw new CliError(`Path is not a directory: ${candidateRoot}`);
  }
  if (!options.allowNonGit && !await looksLikeGitRepository(candidateRoot)) {
    throw new CliError("Path is not a git repository. Pass --allow-non-git to override.");
  }

  const inferredName = await inferDisplayName(candidateRoot);
  const inferredId = normalizeRepoId(options.repoIdOverride ?? inferredName);
  if (!inferredId) {
    throw new CliError("Could not infer a valid repo_id. Pass --id <repo_id>.");
  }
  const displayName = options.displayNameOverride ?? inferredName;

  const config = await loadConfig(configPath);
  if (config.repos.some((repo) => repo.repo_id === inferredId)) {
    throw new CliError(`Duplicate repo_id: "${inferredId}".`);
  }

  const existingRoots = await Promise.all(config.repos.map(async (repo) => ({
    repo_id: repo.repo_id,
    root: await canonicalizeForCompare(repo.root)
  })));
  if (existingRoots.some((entry) => entry.root === candidateRoot)) {
    throw new CliError(`Duplicate root: "${candidateRoot}".`);
  }

  config.repos.push({
    repo_id: inferredId,
    display_name: displayName,
    root: candidateRoot,
    ...createModeConfig(mode),
    ...(options.allowNonGit ? { allow_non_git: true } : {})
  });
  await writeConfigAtomic(configPath, config);

  io.stdout(`Added repo_id=${inferredId}`);
  io.stdout(`display_name=${displayName}`);
  io.stdout(`mode=${mode}`);
  io.stdout(`root=${candidateRoot}`);
  io.stdout("next: npm run connect");
  return 0;
}

async function handleRemove(args: string[], configPath: string, io: CliIo): Promise<number> {
  const repoIdArg = args[0];
  if (!repoIdArg || args.length !== 1) {
    throw new CliError("Usage: gpt-repo remove <repo_id>");
  }

  const normalizedRepoId = normalizeRepoId(repoIdArg);
  if (!normalizedRepoId) {
    throw new CliError(`Invalid repo_id: "${repoIdArg}"`);
  }

  const config = await loadConfig(configPath);
  let index = config.repos.findIndex((repo) => repo.repo_id === repoIdArg);
  if (index < 0) {
    const normalizedMatches = config.repos
      .map((repo, repoIndex) => ({
        repo,
        repoIndex,
        normalized: normalizeRepoId(repo.repo_id)
      }))
      .filter((entry) => entry.normalized === normalizedRepoId);
    if (normalizedMatches.length === 1) {
      index = normalizedMatches[0].repoIndex;
    } else if (normalizedMatches.length > 1) {
      throw new CliError(`Ambiguous repo_id "${repoIdArg}". Use one of: ${normalizedMatches.map((entry) => entry.repo.repo_id).join(", ")}`);
    }
  }

  if (index < 0) {
    throw new CliError(`repo_id does not exist: "${repoIdArg}"`);
  }

  const [removed] = config.repos.splice(index, 1);
  await writeConfigAtomic(configPath, config);
  io.stdout(`Removed repo_id=${removed.repo_id} display_name=${removed.display_name} root=${removed.root}`);
  return 0;
}

async function handleCheck(configPath: string, io: CliIo): Promise<number> {
  const document = await readConfigDocument(configPath);
  const result = await validateConfigDocument(document);
  if (result.issues.length > 0) {
    io.stderr(`FAIL ${result.issues.length} issue(s) found.`);
    for (const issue of result.issues) {
      io.stderr(`- [${issue.code}] ${issue.message}`);
    }
    return 1;
  }

  io.stdout(`PASS ${result.config?.repos.length ?? 0} repo(s) validated.`);
  for (const warning of result.warnings) {
    io.stdout(`WARN [${warning.code}] ${warning.message}`);
  }
  return 0;
}

function normalizeCommand(args: string[]): { name?: string; args: string[] } {
  if (args[0] === "config") {
    return { name: args[1], args: args.slice(2) };
  }
  if (args[0] === "add" || args[0] === "list" || args[0] === "remove" || args[0] === "check" || args[0] === "doctor") {
    return { name: args[0], args: args.slice(1) };
  }
  return { name: args[0], args: args.slice(1) };
}

function parseGlobalArgs(argv: string[]): { args: string[]; configOverride?: string } {
  const args: string[] = [];
  let configOverride: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new CliError("Missing value for --config.");
      }
      configOverride = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configOverride = arg.slice("--config=".length);
      if (!configOverride) {
        throw new CliError("Missing value for --config.");
      }
      continue;
    }
    args.push(arg);
  }
  return { args, configOverride };
}

function parseAddArgs(args: string[]): AddOptions {
  const options: AddOptions = { allowNonGit: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-non-git") {
      options.allowNonGit = true;
      continue;
    }
    if (arg === "--read" || arg === "--write" || arg === "--ship") {
      options.mode = parsePermissionMode(arg.slice(2));
      continue;
    }
    if (arg === "--mode") {
      const value = args[index + 1];
      if (!value) {
        throw new CliError("Missing value for --mode.");
      }
      options.mode = parsePermissionMode(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      options.mode = parsePermissionMode(arg.slice("--mode=".length));
      continue;
    }
    if (arg === "--id") {
      const value = args[index + 1];
      if (!value) {
        throw new CliError("Missing value for --id.");
      }
      options.repoIdOverride = value;
      index += 1;
      continue;
    }
    if (arg === "--name") {
      const value = args[index + 1];
      if (!value) {
        throw new CliError("Missing value for --name.");
      }
      options.displayNameOverride = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CliError(`Unknown option: ${arg}`);
    }
    if (options.path) {
      throw new CliError(`Unexpected extra argument: ${arg}`);
    }
    options.path = arg;
  }

  return options;
}

function parsePermissionMode(value: string): PermissionMode {
  if (value === "read" || value === "write" || value === "ship") {
    return value;
  }
  throw new CliError(`Invalid mode "${value}". Use read, write, or ship.`);
}

async function resolvePermissionMode(options: AddOptions, io: CliIo): Promise<PermissionMode> {
  if (options.mode) {
    return options.mode;
  }
  if (io.stdin?.isTTY) {
    const rl = createInterface({ input: io.stdin, output: process.stdout });
    try {
      const answer = await rl.question("Permission mode? [read/write/ship] (read): ");
      const normalized = answer.trim().toLowerCase();
      return normalized ? parsePermissionMode(normalized) : "read";
    } finally {
      rl.close();
    }
  }
  return "read";
}

const SOLO_DEV_ALLOWED_GLOBS = ["**"];

function createModeConfig(mode: PermissionMode) {
  if (mode === "read") {
    return {
      writes: { enabled: false },
      operations: { enabled: false }
    };
  }

  const writes = {
    ...DEFAULT_WRITE_POLICY,
    enabled: true,
    allowed_globs: SOLO_DEV_ALLOWED_GLOBS
  };
  const operations = mode === "ship"
    ? {
        ...DEFAULT_OPERATIONS_POLICY,
        enabled: true,
        git_stage_enabled: true,
        git_commit_enabled: true,
        cleanup_enabled: true,
        validation_enabled: true,
        validation_test_path_globs: SHIP_VALIDATION_TEST_PATH_GLOBS
      }
    : { enabled: false };

  return { writes, operations };
}

async function inferDisplayName(root: string): Promise<string> {
  const packageName = await readPackageName(root);
  if (packageName) {
    return packageName;
  }
  return basename(root);
}

async function readPackageName(root: string): Promise<string | undefined> {
  const packageJsonPath = join(root, "package.json");
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
      return parsed.name.trim();
    }
    return undefined;
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

function normalizeRepoId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function canonicalizeForCompare(root: string): Promise<string> {
  const resolved = resolve(root);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (isNotFoundError(error)) {
      return resolved;
    }
    throw error;
  }
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

function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    stdin: process.stdin
  };
}

class CliError extends Error {}

const currentModule = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === currentModule) {
  const code = await runConnectGptCli(process.argv.slice(2));
  process.exitCode = code;
}
