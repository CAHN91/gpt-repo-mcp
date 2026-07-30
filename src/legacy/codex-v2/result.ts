import { CodexParsedResultSchema, CodexStructuredResultSchema, type CodexParsedResult } from "../../contracts/codex-task.contract.js";
import { RepoReaderError } from "../../runtime/errors.js";
import { normalizeCodexResultForReview } from "../../services/codex-result-review-normalizer.js";

export function parseCodexV2StructuredResult(value: unknown, repoId: string, runId: string, rawText: string): {
  result: CodexParsedResult;
  warnings: string[];
} {
  const normalized = normalizeCodexResultForReview(value);
  const parsed = CodexStructuredResultSchema.parse(normalized.value);
  if (parsed.repo_id !== repoId || parsed.run_id !== runId) {
    throw new RepoReaderError("VALIDATION_ERROR", "RESULT.json repo_id or run_id does not match the review request.");
  }
  return {
    result: CodexParsedResultSchema.parse({
      status: parsed.status,
      summary: parsed.summary,
      changed_files: parsed.changed_files,
      commands_run: parsed.commands_run,
      tests: parsed.tests,
      acceptance_criteria: parsed.acceptance_criteria.map((entry) => `${entry.id}: ${entry.status}`),
      acceptance_results: parsed.acceptance_criteria,
      blockers: parsed.blockers,
      followups: parsed.followups,
      source: "RESULT.json",
      raw_text: rawText
    }),
    warnings: normalized.warnings
  };
}

export function parseLegacyCodexResult(text: string): CodexParsedResult {
  return CodexParsedResultSchema.parse({
    status: parseStatus(fieldText(text, "status")),
    summary: fieldText(text, "summary"),
    changed_files: fieldList(text, "changed_files"),
    commands_run: fieldList(text, "commands_run"),
    tests: fieldList(text, "tests"),
    acceptance_criteria: fieldList(text, "acceptance_criteria"),
    blockers: fieldList(text, "blockers"),
    followups: fieldList(text, "followups"),
    source: "RESULT.md",
    raw_text: text
  });
}

function parseStatus(value: string): CodexParsedResult["status"] {
  const normalized = value.trim().toLowerCase();
  return normalized === "completed" || normalized === "blocked" ? normalized : "unknown";
}

function fieldText(text: string, field: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.toLowerCase().startsWith(`${field}:`));
  const inline = line ? line.slice(field.length + 1).trim() : "";
  return inline || fieldBlock(text, field).join("\n");
}

function fieldList(text: string, field: string): string[] {
  const inline = fieldText(text, field);
  const block = fieldBlock(text, field);
  return block.length === 0 ? (inline ? [inline] : []) : block.map((value) => value.startsWith("- ") ? value.slice(2).trim() : value);
}

function fieldBlock(text: string, field: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((entry) => entry.toLowerCase().trim() === `${field}:`);
  if (start < 0) return [];
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z_]+:/i.test(line.trim())) break;
    const trimmed = line.trim();
    if (trimmed.length > 0) values.push(trimmed);
  }
  return values;
}
