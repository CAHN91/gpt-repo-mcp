const COMPLETED_STATUS_ALIASES = new Set(["complete", "completed", "done", "passed", "success", "succeeded"]);
const BLOCKED_STATUS_ALIASES = new Set(["blocked", "error", "failed", "failure", "incomplete", "partial"]);
const PASSED_ACCEPTANCE_ALIASES = new Set(["complete", "completed", "met", "pass", "passed", "satisfied", "success", "verified"]);
const FAILED_ACCEPTANCE_ALIASES = new Set(["fail", "failed", "not_met", "unsatisfied"]);
const UNVERIFIED_ACCEPTANCE_ALIASES = new Set(["not_run", "pending", "skipped", "unknown", "unverified"]);

export type CodexResultReviewNormalization = {
  value: unknown;
  warnings: string[];
};

export function normalizeCodexResultForReview(value: unknown): CodexResultReviewNormalization {
  if (!isRecord(value)) return { value, warnings: [] };

  const normalized: Record<string, unknown> = { ...value };
  const warnings: string[] = [];
  const status = normalizeStatus(normalized.status);
  if (status !== undefined && status !== normalized.status) {
    normalized.status = status;
    warnings.push("CODEX_RESULT_STATUS_NORMALIZED");
  }

  if (Array.isArray(normalized.acceptance_criteria)) {
    let changed = false;
    normalized.acceptance_criteria = normalized.acceptance_criteria.map((entry) => {
      if (!isRecord(entry)) return entry;
      const entryStatus = normalizeAcceptanceStatus(entry.status);
      if (entryStatus === undefined || entryStatus === entry.status) return entry;
      changed = true;
      return { ...entry, status: entryStatus };
    });
    if (changed) warnings.push("CODEX_RESULT_ACCEPTANCE_STATUS_NORMALIZED");
  }

  const defaulted = ["blockers", "followups"].filter((field) => !Object.hasOwn(normalized, field));
  for (const field of defaulted) normalized[field] = [];
  if (defaulted.length > 0) warnings.push("CODEX_RESULT_EMPTY_LISTS_DEFAULTED");

  return { value: normalized, warnings };
}

function normalizeStatus(value: unknown): "completed" | "blocked" | undefined {
  if (typeof value !== "string") return undefined;
  const status = value.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (COMPLETED_STATUS_ALIASES.has(status)) return "completed";
  if (BLOCKED_STATUS_ALIASES.has(status)) return "blocked";
  return undefined;
}

function normalizeAcceptanceStatus(value: unknown): "passed" | "failed" | "unverified" | undefined {
  if (typeof value !== "string") return undefined;
  const status = value.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (PASSED_ACCEPTANCE_ALIASES.has(status)) return "passed";
  if (FAILED_ACCEPTANCE_ALIASES.has(status)) return "failed";
  if (UNVERIFIED_ACCEPTANCE_ALIASES.has(status)) return "unverified";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
