import type { FailureDiagnoseInput, FailureDiagnostic } from "../contracts/failure-diagnose.contract.js";
import { OperationReceiptSchema } from "../contracts/operation-receipt.contract.js";
import { WorkSessionSchema } from "../contracts/work-session.contract.js";
import { readFilePrefix } from "./bounded-read.js";
import { parseFailureDiagnostics } from "./failure-diagnostic-parser.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";

const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 100_000;

type ValidationEvidence = {
  found: boolean;
  validation_id?: string;
  artifact_path?: string;
  status?: "passed" | "failed" | "skipped";
};

export type LoadedFailureEvidence = {
  validation: ValidationEvidence;
  diagnostics: FailureDiagnostic[];
  touched_paths: string[];
  warnings: string[];
  truncated: boolean;
};

export class FailureEvidenceLoader {
  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {}

  async load(input: FailureDiagnoseInput): Promise<LoadedFailureEvidence> {
    const warnings: string[] = [];
    const diagnostics: FailureDiagnostic[] = [];
    let truncated = false;
    const validationPath = input.validation_id
      ? `.chatgpt/validation/${input.validation_id}/result.json`
      : await this.latestValidationPath(warnings);
    let validation: ValidationEvidence = { found: false };
    if (validationPath) {
      const loaded = await this.readJson(validationPath);
      if (loaded) {
        truncated ||= loaded.truncated;
        const artifact = loaded.value as { validation_id?: unknown; status?: unknown; commands?: unknown };
        const validationId = typeof artifact.validation_id === "string" ? artifact.validation_id : input.validation_id;
        const status = artifact.status === "passed" || artifact.status === "failed" || artifact.status === "skipped" ? artifact.status : undefined;
        validation = { found: true, ...(validationId ? { validation_id: validationId } : {}), artifact_path: validationPath, ...(status ? { status } : {}) };
        diagnostics.push(...parseFailureDiagnostics(extractCommandText(artifact.commands), "validation", validationPath, this.root));
      } else {
        warnings.push("FAILURE_VALIDATION_ARTIFACT_MISSING");
      }
    } else {
      warnings.push("FAILURE_VALIDATION_NOT_FOUND");
    }

    return {
      validation,
      diagnostics,
      touched_paths: await this.touchedPaths(),
      warnings: [...new Set(warnings)].sort(),
      truncated
    };
  }

  private async latestValidationPath(warnings: string[]): Promise<string | undefined> {
    const latest = await this.readJson(".chatgpt/validation/latest.json");
    if (!latest) return undefined;
    const artifactPath = (latest.value as { artifact_path?: unknown }).artifact_path;
    if (typeof artifactPath !== "string" || !/^\.chatgpt\/validation\/validation-[A-Za-z0-9-]+\/result\.json$/.test(artifactPath)) {
      warnings.push("FAILURE_VALIDATION_LATEST_INVALID");
      return undefined;
    }
    return artifactPath;
  }

  private async touchedPaths(): Promise<string[]> {
    const paths: string[] = [];
    const pointer = await this.readJson(".chatgpt/work-sessions/current.json");
    const sessionPath = pointer && typeof (pointer.value as { session_path?: unknown }).session_path === "string"
      ? (pointer.value as { session_path: string }).session_path
      : undefined;
    if (sessionPath && /^\.chatgpt\/work-sessions\/[a-z0-9-]+\.json$/.test(sessionPath)) {
      const sessionJson = await this.readJson(sessionPath);
      const session = sessionJson ? WorkSessionSchema.safeParse(sessionJson.value) : undefined;
      if (session?.success) paths.push(...session.data.touched_files);
    }
    const receiptJson = await this.readJson(".chatgpt/operations/last-write.json");
    const receipt = receiptJson ? OperationReceiptSchema.safeParse(receiptJson.value) : undefined;
    if (receipt?.success) paths.push(...receipt.data.touched_paths);
    return [...new Set(paths)].sort();
  }

  private async readJson(path: string): Promise<{ value: unknown; truncated: boolean } | undefined> {
    try {
      const resolved = await this.sandbox.resolve(validateRepoPath(path));
      const bounded = await readFilePrefix(resolved.absolutePath, MAX_ARTIFACT_BYTES);
      if (bounded.truncated) return { value: {}, truncated: true };
      return { value: JSON.parse(bounded.buffer.toString("utf8")) as unknown, truncated: false };
    } catch {
      return undefined;
    }
  }
}

function extractCommandText(commands: unknown): string {
  if (!Array.isArray(commands)) return "";
  return commands.flatMap((command) => {
    if (!command || typeof command !== "object") return [];
    const value = command as { stdout_tail?: unknown; stderr_tail?: unknown };
    return [value.stdout_tail, value.stderr_tail].filter((item): item is string => typeof item === "string");
  }).join("\n").slice(0, MAX_EXTRACTED_TEXT_CHARS);
}
