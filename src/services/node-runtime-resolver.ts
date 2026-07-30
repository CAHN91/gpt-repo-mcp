import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { RepoReaderError } from "../runtime/errors.js";

const execFileAsync = promisify(execFile);
const VERSION_FILE_LIMIT = 256;
const VERSION_CHECK_TIMEOUT_MS = 5_000;

export type NodeRuntimeSource = "package.json#volta.node" | ".node-version" | ".nvmrc" | "package.json#engines.node";

export type NodeRuntimeSelection = {
  name: "node";
  version: string;
  source: NodeRuntimeSource;
  bin_directory: string;
};

export type NodeRuntimeResolverOptions = {
  home?: string;
  env?: NodeJS.ProcessEnv;
};

type VersionRequest = { version: string; source: NodeRuntimeSource };

export class NodeRuntimeResolver {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly root: string, options: NodeRuntimeResolverOptions = {}) {
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
  }

  async resolve(): Promise<NodeRuntimeSelection | undefined> {
    const request = await this.readVersionRequest();
    if (!request) return undefined;

    for (const candidate of this.runtimeCandidates(request.version)) {
      if (await this.isSafeRuntimeExecutable(candidate.executable, candidate.runtimeRoot, request.version)) {
        return { name: "node", version: request.version, source: request.source, bin_directory: dirname(candidate.executable) };
      }
    }

    throw new RepoReaderError(
      "VALIDATION_NODE_RUNTIME_UNAVAILABLE",
      `Repository requires Node.js ${request.version}, but no safe installed runtime was found.`,
      { diagnostics: { recovery_hint: `Install Node.js ${request.version} with nvm, mise, fnm, Volta, or asdf, then retry validation.` } }
    );
  }

  private async readVersionRequest(): Promise<VersionRequest | undefined> {
    const packageJson = await this.readPackageJson();
    const volta = exactVersion(packageJson?.volta?.node);
    if (volta) return { version: volta, source: "package.json#volta.node" };

    const nodeVersion = exactVersion(await this.readSmallVersionFile(".node-version"));
    if (nodeVersion) return { version: nodeVersion, source: ".node-version" };

    const nvmrc = exactVersion(await this.readSmallVersionFile(".nvmrc"));
    if (nvmrc) return { version: nvmrc, source: ".nvmrc" };

    const engines = exactVersion(packageJson?.engines?.node);
    return engines ? { version: engines, source: "package.json#engines.node" } : undefined;
  }

  private async readPackageJson(): Promise<{ volta?: { node?: unknown }; engines?: { node?: unknown } } | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(this.root, "package.json"), "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? parsed as { volta?: { node?: unknown }; engines?: { node?: unknown } } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Validation requires a readable package.json.", {
        diagnostics: { recovery_hint: error instanceof Error ? error.message : "package.json could not be read" }
      });
    }
  }

  private async readSmallVersionFile(name: ".node-version" | ".nvmrc"): Promise<string | undefined> {
    const path = join(this.root, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > VERSION_FILE_LIMIT) return undefined;
      return (await readFile(path, "utf8")).trim();
    } catch {
      return undefined;
    }
  }

  private runtimeCandidates(version: string): Array<{ executable: string; runtimeRoot: string }> {
    const nvmRoot = this.env.NVM_DIR ? join(this.env.NVM_DIR, "versions", "node") : join(this.home, ".nvm", "versions", "node");
    return [
      { runtimeRoot: nvmRoot, executable: join(nvmRoot, `v${version}`, "bin", "node") },
      { runtimeRoot: join(this.home, ".local", "share", "mise", "installs", "node"), executable: join(this.home, ".local", "share", "mise", "installs", "node", version, "bin", "node") },
      { runtimeRoot: join(this.home, ".fnm", "node-versions"), executable: join(this.home, ".fnm", "node-versions", `v${version}`, "installation", "bin", "node") },
      { runtimeRoot: join(this.home, ".volta", "tools", "image", "node"), executable: join(this.home, ".volta", "tools", "image", "node", version, "bin", "node") },
      { runtimeRoot: join(this.home, ".asdf", "installs", "nodejs"), executable: join(this.home, ".asdf", "installs", "nodejs", version, "bin", "node") }
    ];
  }

  private async isSafeRuntimeExecutable(executable: string, runtimeRoot: string, version: string): Promise<boolean> {
    try {
      const [resolvedRoot, resolvedExecutable] = await Promise.all([realpath(runtimeRoot), realpath(executable)]);
      if (!isWithin(resolvedRoot, resolvedExecutable)) return false;
      const info = await stat(resolvedExecutable);
      if (!info.isFile()) return false;
      await access(resolvedExecutable, fsConstants.X_OK);
      const checked = await execFileAsync(resolvedExecutable, ["--version"], {
        timeout: VERSION_CHECK_TIMEOUT_MS,
        maxBuffer: 256,
        env: { PATH: dirname(resolvedExecutable) }
      });
      return exactVersion(checked.stdout.trim()) === version;
    } catch {
      return false;
    }
  }
}

function exactVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^=?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}
