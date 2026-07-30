import { CodexParsedResultSchema, type CodexParsedResult } from "../contracts/codex-task.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import {
  parseCodexV2StructuredResult,
  parseLegacyCodexResult as parseLegacyV2Result
} from "../legacy/codex-v2/result.js";
import { parseDelegationResultV3WithWarnings } from "./delegation-v3-normalizer.js";

export function parseStructuredCodexResult(
  text: string,
  repoId: string,
  runId: string
): { result: CodexParsedResult; warnings: string[] } {
  const value = parseJson(text, "RESULT.json");
  if (isRecord(value) && value.schema_version === 3) {
    const { result: parsed, warnings } = parseDelegationResultV3WithWarnings(text, repoId, runId);
    const productAcceptance = parsed.product_acceptance_criteria.map((entry) => ({
      id: entry.id,
      status: entry.status,
      evidence: entry.evidence
    }));
    const technicalAcceptance = parsed.technical_acceptance_criteria.map((entry) => ({
      id: entry.id,
      status: entry.status,
      evidence: entry.evidence
    }));
    return {
      result: CodexParsedResultSchema.parse({
        status: parsed.status,
        summary: parsed.summary,
        changed_files: parsed.changed_files,
        commands_run: parsed.commands_run,
        tests: parsed.tests,
        acceptance_criteria: [...productAcceptance, ...technicalAcceptance].map((entry) => `${entry.id}: ${entry.status}`),
        acceptance_results: [...productAcceptance, ...technicalAcceptance],
        product_acceptance_results: productAcceptance,
        technical_acceptance_results: technicalAcceptance,
        connected_changes: parsed.connected_changes,
        scope_extension_required: parsed.scope_extension_required,
        blockers: parsed.blockers,
        followups: parsed.followups,
        source: "RESULT.json",
        raw_text: text
      }),
      warnings
    };
  }
  return parseCodexV2StructuredResult(value, repoId, runId, text);
}

export function parseLegacyCodexResult(text: string): CodexParsedResult {
  return parseLegacyV2Result(text);
}

export function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RepoReaderError("VALIDATION_ERROR", `Invalid JSON in ${path}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
