import { ZodError } from "zod";

export type RepoReaderErrorCode =
  | "UNKNOWN_REPO"
  | "ABSOLUTE_PATH_REJECTED"
  | "PATH_TRAVERSAL_REJECTED"
  | "SYMLINK_ESCAPE_REJECTED"
  | "UNSUPPORTED_FILE_TYPE"
  | "BINARY_FILE_REJECTED"
  | "SECRET_CANDIDATE_BLOCKED"
  | "INTERNAL_ARTIFACT_BLOCKED"
  | "DEFAULT_EXCLUDE_BLOCKED"
  | "SIZE_LIMIT_EXCEEDED"
  | "WRITE_DISABLED"
  | "WRITE_DENIED_GLOB"
  | "WRITE_NOT_ALLOWED_GLOB"
  | "WRITE_EXPECTED_SHA_REQUIRED"
  | "WRITE_STALE_EXPECTED_SHA"
  | "WRITE_PARENT_MISSING"
  | "WRITE_TARGET_EXISTS"
  | "WRITE_TARGET_MISSING"
  | "WRITE_CONTENT_REQUIRED"
  | "WRITE_FIND_REQUIRED"
  | "WRITE_FIND_NOT_FOUND"
  | "WRITE_FIND_NOT_UNIQUE"
  | "OPERATIONS_DISABLED"
  | "GIT_STAGE_DISABLED"
  | "GIT_COMMIT_DISABLED"
  | "GIT_HEAD_MISMATCH"
  | "GIT_OPERATION_PATHS_REQUIRED"
  | "GIT_OPERATION_TOO_MANY_PATHS"
  | "GIT_OPERATION_UNSAFE_PATHSPEC"
  | "GIT_STAGED_PATHS_MISMATCH"
  | "GIT_NOTHING_STAGED"
  | "GIT_COMMIT_MESSAGE_INVALID"
  | "CLEANUP_DISABLED"
  | "CLEANUP_PATHS_REQUIRED"
  | "CLEANUP_UNSAFE_PATH"
  | "CLEANUP_TRACKED_PATH"
  | "CLEANUP_NOT_ALLOWED_GLOB"
  | "PATCHSET_NOT_APPLIED"
  | "PATCHSET_ALREADY_COMMITTED"
  | "PATCHSET_ALREADY_ROLLED_BACK"
  | "PATCHSET_HUNK_VALIDATION_FAILED"
  | "PATCHSET_ROLLBACK_DRIFT"
  | "PATCHSET_ROLLBACK_STAGED_PATHS"
  | "PATCHSET_ROLLBACK_UNSUPPORTED_TARGET"
  | "VALIDATION_DISABLED"
  | "VALIDATION_PROFILE_UNAVAILABLE"
  | "VALIDATION_NODE_RUNTIME_UNAVAILABLE"
  | "VALIDATION_TEST_PATHS_REQUIRE_TEST_PROFILE"
  | "VALIDATION_TEST_PATHS_DISABLED"
  | "VALIDATION_TEST_PATHS_REQUIRED"
  | "VALIDATION_TOO_MANY_TEST_PATHS"
  | "VALIDATION_TEST_PATH_NOT_ALLOWED"
  | "VALIDATION_ARTIFACT_WRITE_FAILED"
  | "PRODUCT_CONTRACT_MISSING"
  | "PRODUCT_CONTRACT_MALFORMED"
  | "PRODUCT_CONTRACT_TRUNCATED"
  | "PRODUCT_CONTRACT_UNSAFE"
  | "PRODUCT_CONTRACT_UNSUPPORTED"
  | "PRODUCT_CONTRACT_SECRET_BLOCKED"
  | "PRODUCT_CONTRACT_CANONICAL_DOC_INVALID"
  | "PRODUCT_CONTRACT_SELECTION_INVALID"
  | "DELEGATION_REVIEW_GATE_BLOCKED"
  | "DELEGATION_REVIEW_GATE_INVALID"
  | "CODEX_REVIEW_NOT_ELIGIBLE"
  | "CODEX_REVIEW_STATE_MISMATCH"
  | "CODEX_REVIEW_EVIDENCE_INVALID"
  | "RUNNER_LOCK_ACTIVE"
  | "RUNNER_LOCK_LOST"
  | "RUNNER_RUN_ID_INVALID"
  | "RUNNER_INTERACTION_INVALID"
  | "RUNNER_REPLY_STALE"
  | "RUNNER_REPLY_ALREADY_EXISTS"
  | "RUNNER_POLICY_BLOCKED"
  | "RUNNER_MAX_TURNS"
  | "RUNNER_SDK_UNAVAILABLE"
  | "RUNNER_PROVIDER_UNAVAILABLE"
  | "RUNNER_PROVIDER_FAILED"
  | "RUNNER_PROVIDER_OUTPUT_INVALID"
  | "AGENT_RUN_ARTIFACT_INVALID"
  | "DISCARD_PATH_NOT_ALLOWED"
  | "DISCARD_TRACKED_PATH_REJECTED"
  | "DISCARD_UNSUPPORTED_FILE_TYPE"
  | "WORK_SESSION_REPO_MISMATCH"
  | "VALIDATION_ERROR"
  | "GIT_ERROR"
  | "INTERNAL_ERROR";

export class RepoReaderError extends Error {
  readonly code: RepoReaderErrorCode;
  readonly retryable: boolean;
  readonly diagnostics: Record<string, unknown>;

  constructor(
    code: RepoReaderErrorCode,
    message: string,
    options: { retryable?: boolean; diagnostics?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = "RepoReaderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.diagnostics = options.diagnostics ?? {};
  }
}

export function toRepoReaderError(error: unknown): RepoReaderError {
  if (error instanceof RepoReaderError) {
    return error;
  }
  if (error instanceof ZodError) {
    const message = error.issues.length === 1
      ? error.issues[0]!.message
      : error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join("; ");
    return new RepoReaderError("VALIDATION_ERROR", message);
  }
  if (error instanceof Error) {
    return new RepoReaderError("INTERNAL_ERROR", error.message);
  }
  return new RepoReaderError("INTERNAL_ERROR", "Unexpected internal error");
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "input";
  }
  return `input.${path.map((segment) => String(segment)).join(".")}`;
}
