import {
  AgentRunnerStatusSchema,
  type AgentRunnerMetadata,
  type AgentRunnerStatus
} from "../delegation/artifact-contracts.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";

const MAX_PUBLIC_CHANGED_PATHS = 100;
const MAX_PUBLIC_WARNINGS = 100;

export function sanitizeAgentRunStatus(status: AgentRunnerStatus, warnings: string[]): AgentRunnerStatus {
  const changedPaths = status.changed_paths.filter(isSafeRepoPath).slice(0, MAX_PUBLIC_CHANGED_PATHS);
  if (changedPaths.length !== status.changed_paths.length) warnings.push("AGENT_RUN_STATUS_PATHS_TRUNCATED");
  const validationArtifact = status.validation.artifact_path;
  const safeValidationArtifact = validationArtifact && isSafeRepoPath(validationArtifact) ? validationArtifact : null;
  if (validationArtifact && !safeValidationArtifact) warnings.push("AGENT_RUN_STATUS_ARTIFACT_OMITTED");
  const safeFields = {
    started_at: sanitizeScalar(status.started_at, 100),
    updated_at: sanitizeScalar(status.updated_at, 100)!,
    completed_at: sanitizeScalar(status.completed_at, 100),
    head_before: sanitizeScalar(status.head_before, 200),
    head_after: sanitizeScalar(status.head_after, 200),
    worktree_fingerprint_before: sanitizeScalar(status.worktree_fingerprint_before, 500),
    worktree_fingerprint_after: sanitizeScalar(status.worktree_fingerprint_after, 500),
    validation_profile: sanitizeScalar(status.validation.profile, 100),
    commit_sha: sanitizeScalar(status.commit.commit_sha, 200)
  };
  if (statusFieldsChanged(status, safeFields)) warnings.push("AGENT_RUN_STATUS_FIELDS_SANITIZED");
  return AgentRunnerStatusSchema.parse({
    ...status,
    started_at: safeFields.started_at,
    updated_at: safeFields.updated_at,
    completed_at: safeFields.completed_at,
    head_before: safeFields.head_before,
    head_after: safeFields.head_after,
    worktree_fingerprint_before: safeFields.worktree_fingerprint_before,
    worktree_fingerprint_after: safeFields.worktree_fingerprint_after,
    changed_paths: changedPaths,
    validation: { ...status.validation, profile: safeFields.validation_profile, artifact_path: safeValidationArtifact },
    commit: { ...status.commit, commit_sha: safeFields.commit_sha },
    warnings: status.warnings.slice(0, MAX_PUBLIC_WARNINGS).map((warning) => redactSensitiveText(warning).slice(0, 500))
  });
}

export function publicAgentRunnerMetadata(metadata: AgentRunnerMetadata, warnings: string[]): AgentRunnerMetadata {
  if (metadata.mode === "manual") {
    if (Object.keys(metadata).some((key) => key !== "mode")) warnings.push("AGENT_RUN_MANUAL_METADATA_IGNORED");
    return { mode: "manual" };
  }
  if (!metadata.requested_runner) warnings.push("AGENT_RUN_QUEUED_RUNNER_MISSING");
  return {
    mode: "queued",
    ...(metadata.requested_runner ? { requested_runner: metadata.requested_runner } : {}),
    ...(metadata.auto_start === undefined ? {} : { auto_start: metadata.auto_start }),
    ...(metadata.max_runtime_ms === undefined ? {} : { max_runtime_ms: metadata.max_runtime_ms }),
    ...(metadata.commit_after_green === undefined ? {} : { commit_after_green: metadata.commit_after_green })
  };
}

export function boundedAgentRunWarnings(warnings: readonly string[]): string[] {
  const unique = [...new Set(warnings)];
  return unique.length <= MAX_PUBLIC_WARNINGS
    ? unique
    : [...unique.slice(0, MAX_PUBLIC_WARNINGS - 1), "AGENT_RUN_WARNINGS_TRUNCATED"];
}

export function sanitizeAgentRunScalar(value: string | null | undefined, maxLength: number): string | null {
  return value === null || value === undefined ? null : redactSensitiveText(value).slice(0, maxLength);
}

function statusFieldsChanged(
  status: AgentRunnerStatus,
  safe: {
    started_at: string | null;
    updated_at: string;
    completed_at: string | null;
    head_before: string | null;
    head_after: string | null;
    worktree_fingerprint_before: string | null;
    worktree_fingerprint_after: string | null;
    validation_profile: string | null;
    commit_sha: string | null;
  }
): boolean {
  return safe.started_at !== status.started_at
    || safe.updated_at !== status.updated_at
    || safe.completed_at !== status.completed_at
    || safe.head_before !== status.head_before
    || safe.head_after !== status.head_after
    || safe.worktree_fingerprint_before !== status.worktree_fingerprint_before
    || safe.worktree_fingerprint_after !== status.worktree_fingerprint_after
    || safe.validation_profile !== status.validation.profile
    || safe.commit_sha !== status.commit.commit_sha;
}

function isSafeRepoPath(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.includes("\\")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function sanitizeScalar(value: string | null | undefined, maxLength: number): string | null {
  return sanitizeAgentRunScalar(value, maxLength);
}
