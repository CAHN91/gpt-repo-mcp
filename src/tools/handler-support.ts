import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GitService } from "../services/git-service.js";
import { RepoReaderError, toRepoReaderError } from "../runtime/errors.js";
import { createErrorEnvelope } from "../runtime/result-envelope.js";
import { audit } from "../runtime/telemetry.js";
import type { RuntimeContext } from "../runtime/context.js";
import { toolContracts, type ToolName } from "./contracts.js";

export type ToolHandler = (input: unknown, context: RuntimeContext) => Promise<CallToolResult>;

export async function safeTool<TInput extends Record<string, unknown>>(
  tool: ToolName,
  input: unknown,
  run: (args: TInput) => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    const args = toolContracts[tool].input.parse(input) as TInput;
    return await run(args);
  } catch (error) {
    const normalized = legacyDelegationMigrationError(tool, input) ?? toRepoReaderError(error);
    audit({
      tool,
      repo_id: typeof input === "object" && input && "repo_id" in input ? String(input.repo_id) : undefined,
      warnings: [normalized.code]
    });
    return createErrorEnvelope(normalized);
  }
}

export async function readHeadSha(root: string): Promise<string | undefined> {
  try {
    return (await new GitService(root).status()).head_sha;
  } catch {
    return undefined;
  }
}

export function assertExpectedHead(expectedHeadSha: string | undefined, actualHeadSha: string | undefined): void {
  if (!expectedHeadSha || expectedHeadSha === actualHeadSha) return;
  throw new RepoReaderError("GIT_HEAD_MISMATCH", "Current HEAD does not match expected_head_sha.", {
    diagnostics: {
      expected_head_sha: expectedHeadSha,
      ...(actualHeadSha ? { head_sha: actualHeadSha } : {})
    }
  });
}

function legacyDelegationMigrationError(tool: ToolName, input: unknown): RepoReaderError | undefined {
  if (tool !== "repo_prepare_codex_task" && tool !== "repo_write_codex_task") return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const legacyFields = [
    "objective",
    "context_summary",
    "inspect_first",
    "allowed_paths",
    "implementation_scope",
    "acceptance_criteria",
    "verification_commands",
    "parent_run_id",
    "include_prompt"
  ].filter((field) => Object.hasOwn(input, field));
  if (legacyFields.length === 0) return undefined;
  return new RepoReaderError(
    "VALIDATION_ERROR",
    "Codex Task v2 creation fields are no longer accepted. Use task_kind, assignment, outcome, kind-specific product/technical/security context, starting_points, authorization_scope, explicit exclusions, PACs, and TACs. Historical v1/v2 runs remain reviewable.",
    { diagnostics: { recovery_hint: `Remove legacy fields: ${legacyFields.join(", ")}` } }
  );
}
