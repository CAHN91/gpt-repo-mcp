# Error Codes

This inventory documents the existing v1 error codes returned through the shared error envelope. It is not a new output contract.

All tool errors return:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Sanitized message",
    "retryable": false,
    "diagnostics": {
      "rolled_back_paths": ["docs/example.md"],
      "failed_path": "src/example.ts",
      "recovery_hint": "Run repo_git_review and use its repo_write_recover payload for paths whose rollback failed."
    }
  }
}
```

`error.diagnostics` is optional. Some write and git-operation errors include safe machine-readable diagnostics such as repo-relative applied or rolled-back paths, HEAD SHAs, or recovery hints. Diagnostics never include file contents, snippets, raw diffs, secret values, absolute paths, environment values, raw command output, or stack traces.

## Inventory

| Code | Meaning |
| --- | --- |
| `UNKNOWN_REPO` | The requested `repo_id` is not registered as an approved repository root. |
| `ABSOLUTE_PATH_REJECTED` | A repo-relative path field received an absolute path. |
| `PATH_TRAVERSAL_REJECTED` | A path attempted to traverse outside the approved repository root. |
| `SYMLINK_ESCAPE_REJECTED` | A symlink resolved outside the approved repository root. |
| `UNSUPPORTED_FILE_TYPE` | The resolved path is not a supported regular file. |
| `BINARY_FILE_REJECTED` | A file read was blocked because the target appears to be binary. |
| `SECRET_CANDIDATE_BLOCKED` | A file read was blocked because the path looks secret-sensitive, or a public environment template contains a secret-looking value. |
| `DEFAULT_EXCLUDE_BLOCKED` | A file read was blocked by default exclude policy. |
| `SIZE_LIMIT_EXCEEDED` | A file read exceeded the requested or configured byte limit. |
| `WRITE_DISABLED` | A write was requested for a repo that has not enabled `writes.enabled`. |
| `WRITE_DENIED_GLOB` | A write target matched a configured denied glob or secret-sensitive path. |
| `WRITE_NOT_ALLOWED_GLOB` | A write target did not match the repo's configured allowed write globs. |
| `WRITE_EXPECTED_SHA_REQUIRED` | Legacy code for old pre-OSS write schema; current write tools do not require user-supplied expected SHA. |
| `WRITE_STALE_EXPECTED_SHA` | Supplied `expected_old_sha256` did not match the current file SHA-256. |
| `WRITE_PARENT_MISSING` | The target parent directory does not exist and `create_dirs` was not enabled. |
| `WRITE_TARGET_EXISTS` | Supplied `expected_missing` required a missing target, but the path already exists. |
| `WRITE_TARGET_MISSING` | An edit action was requested for a path that does not exist. |
| `WRITE_CONTENT_REQUIRED` | `content` or `replace` was required for the requested write action. |
| `WRITE_FIND_REQUIRED` | `find` was required for the requested exact-match edit action. |
| `WRITE_FIND_NOT_FOUND` | The requested `find` text was not present in the target file. |
| `WRITE_FIND_NOT_UNIQUE` | The requested `find` text appeared more than once in the target file. |
| `OPERATIONS_DISABLED` | A git or cleanup operation was requested without `operations.enabled`. |
| `GIT_STAGE_DISABLED` | Git stage or unstage was requested without stage operations enabled. |
| `GIT_COMMIT_DISABLED` | Git commit was requested without commit operations enabled. |
| `GIT_HEAD_MISMATCH` | Current HEAD did not match the supplied `expected_head_sha`. |
| `GIT_OPERATION_PATHS_REQUIRED` | A git operation requiring explicit paths received an empty path list. |
| `GIT_OPERATION_TOO_MANY_PATHS` | A git operation exceeded `operations.max_paths_per_operation`. |
| `GIT_OPERATION_UNSAFE_PATHSPEC` | A git pathspec was broad, shell-like, Git-internal, or otherwise unsafe. Absolute paths, traversal, `.env`, and hard-risk secret paths are also rejected by path and secret policy. |
| `GIT_STAGED_PATHS_MISMATCH` | Actual staged paths did not exactly match `expected_staged_paths`. |
| `GIT_NOTHING_STAGED` | Commit was requested when there were no staged changes. |
| `GIT_COMMIT_MESSAGE_INVALID` | Commit message was empty or looked like command syntax rather than a local commit message. |
| `CLEANUP_DISABLED` | Cleanup was requested without both `operations.enabled` and `operations.cleanup_enabled`. |
| `CLEANUP_PATHS_REQUIRED` | Cleanup received an empty path list. |
| `CLEANUP_UNSAFE_PATH` | Cleanup target was absolute, traversal, broad, `.git`, `.env`, secret-looking, a symlink escape, or an unsupported file type. |
| `CLEANUP_NOT_ALLOWED_GLOB` | Cleanup target did not match `operations.cleanup_allowed_globs`. |
| `VALIDATION_ERROR` | Tool input failed validation, such as invalid regex syntax or missing required read targets. |
| `VALIDATION_DISABLED` | Repository validation is disabled because operations validation has not been explicitly enabled. |
| `VALIDATION_PROFILE_UNAVAILABLE` | Requested validation profile could not be resolved from an npm script or supported safe project runner. |
| `VALIDATION_NODE_RUNTIME_UNAVAILABLE` | Repository requests an exact Node.js version, but no matching safe installed runtime exists under a supported manager root. |
| `RUNNER_LOCK_ACTIVE` | A delegation run lock is already held by an active worker or fresh replacement guard. The error is retryable and may include safe lock metadata such as `run_id`, `owner_id`, and `updated_at`. |
| `RUNNER_RUN_ID_INVALID` | A runner run id or runner manifest was invalid, mismatched its directory, or referenced non-canonical run artifact paths. |
| `WORK_SESSION_REPO_MISMATCH` | Requested work-session state belongs to a different repository id. |
| `GIT_ERROR` | A git operation failed. |
| `INTERNAL_ERROR` | An unexpected failure was sanitized before returning to the caller. |

## Non-Envelope Skip Reasons

Some successful tools also return stable warning or skip reason strings inside their existing success output shapes. For example, `repo_read_many.skipped[].reason` may contain file policy codes such as `SECRET_CANDIDATE_BLOCKED`, `BINARY_FILE_REJECTED`, or the read-many limit reason `MAX_TOTAL_BYTES_EXCEEDED`.
