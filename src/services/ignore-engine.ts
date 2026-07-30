import ignore from "ignore";
import { posix } from "node:path";
import { DEFAULT_EXCLUDES } from "../policies/default-excludes.js";
import { isInternalAgentArtifact } from "../policies/internal-agent-artifacts.js";

const PUBLIC_ENV_TEMPLATE_PATHS = new Set([".env.example", ".env.sample", ".env.template", "example.env"]);

export class IgnoreEngine {
  private readonly matcher = ignore().add([...DEFAULT_EXCLUDES]);

  isIgnored(repoPath: string): boolean {
    const normalized = normalizeRepoPath(repoPath);
    return this.matcher.ignores(normalized);
  }

  isSensitiveCandidate(repoPath: string): boolean {
    const normalized = normalizeRepoPath(repoPath);
    if (this.isInternalArtifact(normalized)) {
      return true;
    }
    if (isPublicEnvTemplatePath(normalized)) {
      return false;
    }
    const lower = normalized.toLowerCase();
    const base = posix.basename(lower);
    const segments = lower.split("/");

    return (
      base === ".env" ||
      base.startsWith(".env.") ||
      base.endsWith(".pem") ||
      base.endsWith(".key") ||
      base.endsWith(".p12") ||
      base.endsWith(".pfx") ||
      base === "id_rsa" ||
      base === "id_ed25519" ||
      segments.includes("secrets") ||
      segments.includes("credentials")
    );
  }

  isInternalArtifact(repoPath: string): boolean {
    return isInternalAgentArtifact(normalizeRepoPath(repoPath));
  }
}

export function normalizeRepoPath(repoPath: string): string {
  return repoPath.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function isPublicEnvTemplatePath(repoPath: string): boolean {
  return PUBLIC_ENV_TEMPLATE_PATHS.has(normalizeRepoPath(repoPath));
}
