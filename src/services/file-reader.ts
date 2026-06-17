import { createHash } from "node:crypto";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { FileClassifier } from "./file-classifier.js";
import { IgnoreEngine, isPublicEnvTemplatePath } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";
import { SecretScanner } from "./secret-scanner.js";
import { readFilePrefix } from "./bounded-read.js";

export type FetchFileOptions = {
  path: string;
  start_line?: number;
  end_line?: number;
  max_bytes?: number;
  override_default_excludes?: boolean;
};

export class FileReader {
  private readonly ignoreEngine = new IgnoreEngine();
  private readonly classifier = new FileClassifier(this.ignoreEngine);
  private readonly secretScanner = new SecretScanner();

  constructor(private readonly sandbox: PathSandbox) {}

  async read(options: FetchFileOptions) {
    const resolved = await this.sandbox.resolve(options.path);
    if (!resolved.stat.isFile()) {
      throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Not a regular file: ${resolved.repoPath}`);
    }

    const warnings: string[] = [];
    const policyPaths = uniquePaths([resolved.repoPath, resolved.canonicalRepoPath]);
    const ignoredPath = policyPaths.find((path) => this.ignoreEngine.isIgnored(path));
    if (ignoredPath && !options.override_default_excludes) {
      throw new RepoReaderError("DEFAULT_EXCLUDE_BLOCKED", `Path is excluded by default: ${ignoredPath}`);
    }
    if (ignoredPath && options.override_default_excludes) {
      warnings.push(`Read default-excluded path with override: ${ignoredPath}`);
    }
    const sensitivePath = policyPaths.find((path) => this.ignoreEngine.isSensitiveCandidate(path));
    if (sensitivePath) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret candidate blocked: ${sensitivePath}`);
    }

    const maxBytes = Math.min(options.max_bytes ?? DEFAULT_LIMITS.max_bytes_per_file, DEFAULT_LIMITS.max_bytes_per_file);
    const { buffer: content, truncated } = await readFilePrefix(resolved.absolutePath, maxBytes);
    if (truncated) {
      throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", `File exceeds max_bytes: ${resolved.repoPath}`);
    }
    const classification = await this.classifier.classify(resolved.repoPath, resolved.absolutePath);
    if (classification.is_binary) {
      throw new RepoReaderError("BINARY_FILE_REJECTED", `Binary file blocked: ${resolved.repoPath}`);
    }

    const rawText = content.toString("utf8");
    if (policyPaths.some(isPublicEnvTemplatePath) && this.secretScanner.hasSecretValue(rawText)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret candidate blocked: ${resolved.repoPath}`);
    }
    const text = this.secretScanner.redact(rawText);
    const lines = text.split(/\r?\n/);
    const startLine = options.start_line ?? 1;
    const endLine = options.end_line ?? lines.length;
    const selected = lines.slice(startLine - 1, endLine).join("\n");

    return {
      path: resolved.repoPath,
      language: classification.language,
      size_bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      total_lines: lines.length,
      start_line: startLine,
      end_line: Math.min(endLine, lines.length),
      truncated: false,
      text: selected,
      warnings
    };
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}
