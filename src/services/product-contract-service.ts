import { createHash } from "node:crypto";
import {
  ProductContextSelectionInputSchema,
  ProductContextSnapshotSchema,
  ProductContractLoadResultSchema,
  ProductContractSchema,
  type ProductContract,
  type ProductContractConfigured,
  type ProductContractDiagnosticCode,
  type ProductContractLoadResult,
  type ProductContextSelectionInput,
  type ProductContextSelectionResult,
  type ProductTaskKind
} from "../contracts/product-contract.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { readFilePrefix } from "./bounded-read.js";
import { FileClassifier } from "./file-classifier.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";
import { SecretScanner } from "./secret-scanner.js";

export const PRODUCT_CONTRACT_PATH = "docs/product-contract.json";
export const MAX_PRODUCT_CONTRACT_BYTES = 64 * 1024;

export type ProductContractServiceOptions = {
  max_bytes?: number;
};

type Diagnostic = {
  code: ProductContractDiagnosticCode;
  message: string;
  fields?: string[];
};

class ProductContractLoadFailure extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

export class ProductContractService {
  private readonly ignoreEngine = new IgnoreEngine();
  private readonly classifier = new FileClassifier(this.ignoreEngine);
  private readonly maxBytes: number;

  constructor(
    private readonly sandbox: PathSandbox,
    options: ProductContractServiceOptions = {}
  ) {
    this.maxBytes = Math.min(options.max_bytes ?? MAX_PRODUCT_CONTRACT_BYTES, MAX_PRODUCT_CONTRACT_BYTES);
  }

  async load(): Promise<ProductContractLoadResult> {
    try {
      const resolved = await this.sandbox.resolve(PRODUCT_CONTRACT_PATH);
      if (!resolved.stat.isFile() || resolved.stat.isSymbolicLink()) {
        return this.invalid(diagnostic("PRODUCT_CONTRACT_UNSUPPORTED"));
      }
      if (this.ignoreEngine.isInternalArtifact(resolved.repoPath) || this.ignoreEngine.isIgnored(resolved.repoPath)) {
        return this.invalid(diagnostic("PRODUCT_CONTRACT_UNSAFE"));
      }
      if (this.ignoreEngine.isSensitiveCandidate(resolved.repoPath)) {
        return this.invalid(diagnostic("PRODUCT_CONTRACT_SECRET_BLOCKED"));
      }

      const { buffer, truncated } = await readFilePrefix(resolved.absolutePath, this.maxBytes);
      if (truncated) {
        return this.invalid(diagnostic("PRODUCT_CONTRACT_TRUNCATED"));
      }
      const classification = await this.classifier.classify(resolved.repoPath, resolved.absolutePath);
      if (classification.is_binary) {
        return this.invalid(diagnostic("PRODUCT_CONTRACT_UNSUPPORTED"));
      }

      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        return this.invalid(diagnostic("PRODUCT_CONTRACT_UNSUPPORTED"));
      }
      if (new SecretScanner().hasSecretValue(text)) {
        return this.invalid(diagnostic("PRODUCT_CONTRACT_SECRET_BLOCKED"));
      }

      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return this.invalid(diagnostic("PRODUCT_CONTRACT_MALFORMED"));
      }
      if (!isRecord(value) || value.schema_version !== 1) {
        return this.invalid(diagnostic("PRODUCT_CONTRACT_UNSUPPORTED"));
      }

      const parsed = ProductContractSchema.safeParse(value);
      if (!parsed.success) {
        const fields = uniqueIssuePaths(parsed.error.issues);
        const canonicalPathIssue = parsed.error.issues.some((issue) => issue.path[0] === "canonical_docs");
        return this.invalid({
          ...diagnostic(canonicalPathIssue ? "PRODUCT_CONTRACT_UNSAFE" : "PRODUCT_CONTRACT_MALFORMED"),
          ...(fields.length > 0 ? { fields } : {})
        });
      }
      const contract = normalizeProductContract(parsed.data);

      let canonicalDocuments: Array<{ path: string; size_bytes: number }>;
      try {
        canonicalDocuments = await this.validateCanonicalDocuments(contract);
      } catch (error) {
        if (error instanceof ProductContractLoadFailure) {
          return this.invalid(error.diagnostic);
        }
        throw error;
      }

      return ProductContractLoadResultSchema.parse({
        status: "configured",
        source_path: resolved.repoPath,
        size_bytes: buffer.byteLength,
        contract_sha256: hashCanonical(contract),
        contract,
        canonical_documents: canonicalDocuments,
        warnings: []
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return ProductContractLoadResultSchema.parse({
          status: "missing",
          source_path: PRODUCT_CONTRACT_PATH,
          diagnostic: diagnostic("PRODUCT_CONTRACT_MISSING"),
          warnings: []
        });
      }
      if (error instanceof RepoReaderError) {
        return this.invalid(diagnostic(mapRepoError(error)));
      }
      return this.invalid(diagnostic("PRODUCT_CONTRACT_UNSAFE"));
    }
  }

  async requireConfigured(): Promise<ProductContractConfigured> {
    const result = await this.load();
    if (result.status === "configured") return result;
    throw new RepoReaderError(result.diagnostic.code, result.diagnostic.message, {
      diagnostics: { failed_path: result.source_path }
    });
  }

  async select(rawInput: ProductContextSelectionInput): Promise<ProductContextSelectionResult> {
    const input = ProductContextSelectionInputSchema.parse(rawInput);
    const configured = await this.requireConfigured();
    const primaryUser = configured.contract.primary_users.find(({ id }) => id === input.primary_user_id);
    const requestedJobs = new Set(input.job_ids);
    const jobs = configured.contract.jobs_to_be_done.filter(({ id }) => requestedJobs.has(id));
    if (!primaryUser || jobs.length !== requestedJobs.size) {
      throw new RepoReaderError(
        "PRODUCT_CONTRACT_SELECTION_INVALID",
        diagnosticMessage("PRODUCT_CONTRACT_SELECTION_INVALID"),
        { diagnostics: { failed_path: configured.source_path } }
      );
    }

    const snapshot = ProductContextSnapshotSchema.parse({
      schema_version: 1,
      product: configured.contract.product,
      primary_user: primaryUser,
      jobs_to_be_done: jobs,
      must_reduce: configured.contract.must_reduce,
      must_not_become: configured.contract.must_not_become,
      experience_principles: configured.contract.experience_principles,
      canonical_docs: configured.contract.canonical_docs,
      governance: configured.contract.governance
    });
    return {
      source_path: configured.source_path,
      contract_sha256: configured.contract_sha256,
      snapshot_sha256: hashCanonical(snapshot),
      snapshot
    };
  }

  private async validateCanonicalDocuments(contract: ProductContract): Promise<Array<{ path: string; size_bytes: number }>> {
    const documents: Array<{ path: string; size_bytes: number }> = [];
    for (const path of contract.canonical_docs) {
      if (
        this.ignoreEngine.isInternalArtifact(path)
        || this.ignoreEngine.isIgnored(path)
        || this.ignoreEngine.isSensitiveCandidate(path)
      ) {
        throw canonicalDocumentFailure();
      }
      try {
        const resolved = await this.sandbox.resolve(path);
        if (!resolved.stat.isFile() || resolved.stat.isSymbolicLink()) {
          throw canonicalDocumentFailure();
        }
        documents.push({ path: resolved.repoPath, size_bytes: Number(resolved.stat.size) });
      } catch (error) {
        if (error instanceof ProductContractLoadFailure) throw error;
        throw canonicalDocumentFailure();
      }
    }
    return documents;
  }

  private invalid(diagnosticValue: Diagnostic): ProductContractLoadResult {
    return ProductContractLoadResultSchema.parse({
      status: "invalid",
      source_path: PRODUCT_CONTRACT_PATH,
      diagnostic: diagnosticValue,
      warnings: []
    });
  }
}

function normalizeProductContract(contract: ProductContract): ProductContract {
  return {
    schema_version: 1,
    product: {
      name: contract.product.name.trim(),
      purpose: contract.product.purpose.trim()
    },
    primary_users: contract.primary_users.map((user) => ({
      id: user.id,
      role: user.role.trim(),
      technical_level: user.technical_level.trim(),
      work_context: user.work_context.trim()
    })),
    jobs_to_be_done: contract.jobs_to_be_done.map((job) => ({
      id: job.id,
      statement: job.statement.trim()
    })),
    must_reduce: contract.must_reduce.map((value) => value.trim()),
    must_not_become: contract.must_not_become.map((value) => value.trim()),
    experience_principles: contract.experience_principles.map((value) => value.trim()),
    canonical_docs: [...contract.canonical_docs],
    governance: {
      mode: contract.governance.mode,
      product_review_required_for: [...contract.governance.product_review_required_for],
      checkpoint_every_root_runs: contract.governance.checkpoint_every_root_runs
    }
  };
}

export function productReviewRequired(contract: ProductContract, taskKind: ProductTaskKind): boolean {
  return contract.governance.product_review_required_for.includes(taskKind);
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortCanonical(value)), "utf8").digest("hex");
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortCanonical(value[key])])
  );
}

function uniqueIssuePaths(issues: readonly { path: PropertyKey[] }[]): string[] {
  return [...new Set(issues.map(({ path }) => path.map(String).join(".")).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 20);
}

function mapRepoError(error: RepoReaderError): ProductContractDiagnosticCode {
  if (error.code === "SECRET_CANDIDATE_BLOCKED") return "PRODUCT_CONTRACT_SECRET_BLOCKED";
  if (error.code === "SIZE_LIMIT_EXCEEDED") return "PRODUCT_CONTRACT_TRUNCATED";
  if (error.code === "UNSUPPORTED_FILE_TYPE" || error.code === "BINARY_FILE_REJECTED") return "PRODUCT_CONTRACT_UNSUPPORTED";
  return "PRODUCT_CONTRACT_UNSAFE";
}

function canonicalDocumentFailure(): ProductContractLoadFailure {
  return new ProductContractLoadFailure({
    ...diagnostic("PRODUCT_CONTRACT_CANONICAL_DOC_INVALID"),
    fields: ["canonical_docs"]
  });
}

function diagnostic(code: ProductContractDiagnosticCode): Diagnostic {
  return { code, message: diagnosticMessage(code) };
}

function diagnosticMessage(code: ProductContractDiagnosticCode): string {
  switch (code) {
    case "PRODUCT_CONTRACT_MISSING":
      return "Repository product contract is not configured.";
    case "PRODUCT_CONTRACT_MALFORMED":
      return "Repository product contract does not match the required schema.";
    case "PRODUCT_CONTRACT_TRUNCATED":
      return "Repository product contract exceeds the supported size limit.";
    case "PRODUCT_CONTRACT_UNSAFE":
      return "Repository product contract or one of its paths is unsafe.";
    case "PRODUCT_CONTRACT_UNSUPPORTED":
      return "Repository product contract uses an unsupported format, version, or file type.";
    case "PRODUCT_CONTRACT_SECRET_BLOCKED":
      return "Repository product contract contains credential-like content or uses a sensitive path.";
    case "PRODUCT_CONTRACT_CANONICAL_DOC_INVALID":
      return "Repository product contract references an unavailable or unsafe canonical document.";
    case "PRODUCT_CONTRACT_SELECTION_INVALID":
      return "Requested product user or job identifiers are not present in the configured product contract.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
