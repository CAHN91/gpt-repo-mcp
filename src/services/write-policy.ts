import ignore from "ignore";
import { DEFAULT_WRITE_POLICY } from "../policies/write-defaults.js";
import { RepoReaderError } from "../runtime/errors.js";
import { IgnoreEngine } from "./ignore-engine.js";

export type WritePolicyConfig = {
  enabled?: boolean;
  allowed_globs?: string[];
  denied_globs?: string[];
  max_bytes_per_write?: number;
};

export type EffectiveWritePolicy = {
  enabled: boolean;
  allowed_globs: string[];
  denied_globs: string[];
  max_bytes_per_write: number;
};

export class WritePolicy {
  readonly config: EffectiveWritePolicy;
  private readonly allowedMatcher = ignore();
  private readonly deniedMatcher = ignore();
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(config: WritePolicyConfig = {}) {
    this.config = {
      enabled: config.enabled ?? DEFAULT_WRITE_POLICY.enabled,
      allowed_globs: config.allowed_globs ?? [...DEFAULT_WRITE_POLICY.allowed_globs],
      denied_globs: [...DEFAULT_WRITE_POLICY.denied_globs, ...(config.denied_globs ?? [])],
      max_bytes_per_write: config.max_bytes_per_write ?? DEFAULT_WRITE_POLICY.max_bytes_per_write
    };
    this.allowedMatcher.add(this.config.allowed_globs);
    this.deniedMatcher.add(this.config.denied_globs);
  }

  assertAllowed(options: {
    path: string;
    bytes: number;
    action: "write" | "replace" | "append" | "prepend" | "insert_before" | "insert_after" | "edit";
  }): void {
    if (!this.config.enabled) {
      throw new RepoReaderError("WRITE_DISABLED", "Writes are disabled for this repository.");
    }
    if (options.bytes > this.config.max_bytes_per_write) {
      throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `Write exceeds max_bytes_per_write: ${options.path}`);
    }
    if (this.deniedMatcher.ignores(options.path)) {
      throw new RepoReaderError("WRITE_DENIED_GLOB", `Path is denied by write policy: ${options.path}`);
    }
    if (this.ignoreEngine.isSensitiveCandidate(options.path) && isHardSecretPath(options.path)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret candidate blocked: ${options.path}`);
    }
    if (!this.allowedMatcher.ignores(options.path)) {
      throw new RepoReaderError("WRITE_NOT_ALLOWED_GLOB", `Path is outside allowed write globs: ${options.path}`);
    }
  }
}

function isHardSecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.split("/").at(-1) ?? lower;
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx") ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    lower.split("/").includes("secrets") ||
    lower.split("/").includes("credentials")
  );
}
