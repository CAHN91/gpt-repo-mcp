import { createHash } from "node:crypto";
import type { CodexTask } from "../contracts/codex-task.contract.js";
import { matchesGlob } from "./glob-service.js";

export const LEGACY_VERIFICATION_WARNING = "CODEX_LEGACY_VERIFICATION_COMMANDS_PRESENT";

export const DEFAULT_CODEX_FORBIDDEN_PATTERNS = [
  ".env*",
  ".git/**",
  "node_modules/**",
  "**/node_modules/**",
  "dist/**",
  "**/dist/**",
  "coverage/**",
  "**/coverage/**",
  "test-results/**",
  "**/test-results/**",
  ".chatgpt/**"
] as const;

export type NumberedAcceptanceCriterion = {
  id: string;
  criterion: string;
};

export type CodexBaseline = {
  head_sha: string;
  worktree_fingerprint: string;
  initial_changed_paths: string[];
  initial_path_states?: Array<{
    path: string;
    exists: boolean;
    kind: "file" | "symlink" | "missing" | "other";
    head_blob_sha256?: string;
    content_sha256: string;
  }>;
};

export function effectiveForbiddenPatterns(callerPatterns: readonly string[]): string[] {
  return [...new Set([...DEFAULT_CODEX_FORBIDDEN_PATTERNS, ...callerPatterns])];
}

export function renderForbiddenPolicySection(callerPatterns: readonly string[]): string {
  const effective = effectiveForbiddenPatterns(callerPatterns);
  return ["## Forbidden Paths", "", ...effective.map((value) => `- ${value}`), ""].join("\n");
}

export function numberedAcceptanceCriteria(input: CodexTask["acceptance_criteria"]): NumberedAcceptanceCriterion[] {
  const used = new Set<string>();
  return input.map((entry, index) => {
    const criterion = typeof entry === "string" ? entry : entry.criterion;
    let id = typeof entry === "string" ? `AC-${index + 1}` : (entry.id ?? `AC-${index + 1}`);
    if (used.has(id)) {
      let suffix = index + 1;
      while (used.has(`AC-${suffix}`)) suffix += 1;
      id = `AC-${suffix}`;
    }
    used.add(id);
    return { id, criterion };
  });
}

export function taskWarnings(input: Pick<CodexTask, "verification_commands">): string[] {
  return input.verification_commands.length > 0 ? [LEGACY_VERIFICATION_WARNING] : [];
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function baselineSha256(baseline: CodexBaseline): string {
  return sha256Text(JSON.stringify({
    head_sha: baseline.head_sha,
    worktree_fingerprint: baseline.worktree_fingerprint,
    initial_changed_paths: [...baseline.initial_changed_paths].sort((left, right) => left.localeCompare(right))
  }));
}

export function bindPromptToBaseline(prompt: string, baseline: CodexBaseline): string {
  return `${prompt.trimEnd()}\n\n<!-- CODEX_BASELINE_SHA256:${baselineSha256(baseline)} -->\n`;
}

export function matchesAnyPattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

export function isCodexRunArtifact(path: string, runId: string): boolean {
  return path === `.chatgpt/codex-runs/${runId}/PROMPT.md`
    || path === `.chatgpt/codex-runs/${runId}/run.json`
    || path === `.chatgpt/codex-runs/${runId}/RESULT.json`
    || path === `.chatgpt/codex-runs/${runId}/RESULT.md`;
}
