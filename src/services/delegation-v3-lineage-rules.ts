import { RepoReaderError } from "../runtime/errors.js";
import { hashCanonical } from "./product-contract-service.js";

type ProductReviewCorrection = {
  rationale: string;
  evidence: Array<{
    criterion_id: string;
    verdict: "passed" | "failed";
    evidence: string;
  }>;
};

export function assertPreservedStrings(
  rootValues: readonly string[],
  childValues: readonly string[],
  label: string
): void {
  const missing = rootValues.filter((value) => !childValues.includes(value));
  if (missing.length > 0) {
    throw lineageError(`Child ${label} cannot remove or weaken inherited values.`, { values: missing });
  }
}

export function assertPreservedCriteria(
  rootValues: readonly { id: string; criterion: string }[],
  childValues: readonly { id: string; criterion: string }[],
  label: string
): void {
  const missingOrChanged = rootValues.filter((rootValue) =>
    !childValues.some((childValue) => childValue.id === rootValue.id && childValue.criterion === rootValue.criterion)
  );
  if (missingOrChanged.length > 0) {
    throw lineageError(`Child ${label} cannot remove, rename, or weaken inherited criteria.`, {
      ids: missingOrChanged.map(({ id }) => id)
    });
  }
}

export function assertEqual(actual: string, expected: string, message: string): void {
  if (actual !== expected) throw lineageError(message);
}

export function assertCanonicalEqual(actual: unknown, expected: unknown, message: string): void {
  if (hashCanonical(actual) !== hashCanonical(expected)) throw lineageError(message);
}

export function patternCovers(parentPattern: string, childPattern: string): boolean {
  if (parentPattern === childPattern) return true;
  if (parentPattern.endsWith("/**")) {
    const prefix = parentPattern.slice(0, -3).replace(/\/$/, "");
    return childPattern === prefix || childPattern.startsWith(`${prefix}/`);
  }
  return false;
}

export function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function productCorrectionAssignment(correction: ProductReviewCorrection): string {
  const failedEntries = correction.evidence.filter(({ verdict }) => verdict === "failed");
  const failedEvidence = failedEntries
    .slice(0, 5)
    .map(({ criterion_id: criterionId, evidence }) => `${criterionId}: ${evidence.slice(0, 160)}`)
    .join("; ");
  const omitted = failedEntries.length > 5 ? `; +${failedEntries.length - 5} more failed PACs` : "";
  return [
    "Correct and complete the parent implementation within the inherited authorization while preserving every inherited product, outcome, safety, and acceptance contract.",
    ...(failedEvidence ? [`Failed PAC evidence: ${failedEvidence}${omitted}.`] : []),
    `Product review rationale: ${correction.rationale.slice(0, 500)}`
  ].join(" ").slice(0, 1_500);
}

export function childTitle(
  rootTitle: string,
  kind: "corrective" | "scope_amendment",
  childIndex: number
): string {
  const suffix = kind === "corrective" ? `corrective ${childIndex}` : `scope amendment ${childIndex}`;
  const available = Math.max(1, 160 - suffix.length - 3);
  return `${rootTitle.slice(0, available)} — ${suffix}`;
}

export function lineageError(
  message: string,
  diagnostics: Record<string, unknown> = {}
): RepoReaderError {
  return new RepoReaderError("RUNNER_POLICY_BLOCKED", message, { diagnostics });
}
