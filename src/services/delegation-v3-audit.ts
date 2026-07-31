import type {
  DelegationAuditV3Schema,
  DelegationProductBindingV3,
  DelegationTaskV3
} from "../contracts/delegation-v3.contract.js";
import type { z } from "zod";

export type DelegationAuditV3 = z.infer<typeof DelegationAuditV3Schema>;

const HIGH_STARTING_POINT_COUNT = 12;
const HIGH_AUTHORIZATION_PATTERN_COUNT = 30;
const HIGH_ACCEPTANCE_CRITERION_COUNT = 20;

const CLOSED_WORLD_PATTERNS = [
  /\bonly (?:change|edit|touch|modify|use)\b/i,
  /\bexactly (?:these|the following) files\b/i,
  /\bdo not inspect beyond\b/i,
  /\bimplement (?:only|exactly)\b/i,
  /\bchange no other files\b/i
];

const IMPLEMENTATION_PRESCRIPTION_PATTERNS = [
  /\b(?:add|create|rename|replace|call|invoke) (?:the )?(?:class|method|function|component|hook|table|column|endpoint|route)\b/i,
  /\b(?:method|class|function|component|hook) named\b/i,
  /\bin (?:the )?file\b/i,
  /\bchange (?:line|lines) \d+/i
];

const PROSE_PATH_PATTERN = /\b(?:apps?|packages?|src|lib|server|client|frontend|backend|api|db|database|migrations?|tests?|docs|scripts|config)\/[A-Za-z0-9_./*{}-]+/g;
const INLINE_SYMBOL_PATTERN = /`[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\(\))?`/g;
const NUMBERED_STEP_PATTERN = /^\s*\d{1,2}[.)]\s+\S+/gm;
const CODE_FENCE_MARKER_PATTERN = /```/g;

export function auditDelegationTaskV3(
  task: DelegationTaskV3,
  productBinding: DelegationProductBindingV3,
  mode: "advisory" | "enforce"
): DelegationAuditV3 {
  const zones = taskTextZones(task);
  const signals: string[] = [];
  const warnings: string[] = [];
  const productTask = task.task_kind === "product_slice" || task.task_kind === "product_correction";
  const productGrounding = productTask
    ? productBinding.kind === "selected" ? "complete" : "missing"
    : "not_required";

  const closedWorldHits = countPatternGroups(zones.auditedDetailText, CLOSED_WORLD_PATTERNS);
  if (closedWorldHits > 0) {
    signals.push(`closed-world wording detected in ${closedWorldHits} pattern group(s)`);
  }

  const prescriptionHits = countPatternGroups(zones.auditedDetailText, IMPLEMENTATION_PRESCRIPTION_PATTERNS);
  if (prescriptionHits > 0) {
    signals.push(`implementation-prescription wording detected in ${prescriptionHits} pattern group(s)`);
  }

  const prosePathCount = countMatches(zones.auditedDetailText, PROSE_PATH_PATTERN);
  if (prosePathCount >= 4) {
    signals.push(`high exact-path density outside structured path fields: ${prosePathCount} reference(s)`);
  }

  const inlineSymbolCount = countMatches(zones.auditedDetailText, INLINE_SYMBOL_PATTERN);
  if (inlineSymbolCount >= 4) {
    signals.push(`high internal-symbol density outside hard security contracts: ${inlineSymbolCount} reference(s)`);
  }

  const numberedStepCount = countMatches(zones.narrativeText, NUMBERED_STEP_PATTERN);
  if (numberedStepCount >= 4) {
    signals.push(`numbered implementation sequence detected: ${numberedStepCount} step(s)`);
  }

  const codeFenceCount = Math.ceil(countMatches(zones.allText, CODE_FENCE_MARKER_PATTERN) / 2);
  if (codeFenceCount > 0) {
    signals.push(`task input contains ${codeFenceCount} code fence(s)`);
  }

  if (task.starting_points.length > HIGH_STARTING_POINT_COUNT) {
    signals.push(`high starting-point count: ${task.starting_points.length}`);
  }
  if (task.authorization_scope.length > HIGH_AUTHORIZATION_PATTERN_COUNT) {
    signals.push(`high authorization-pattern count: ${task.authorization_scope.length}`);
  }

  const criterionCount = task.technical_acceptance_criteria.length
    + ("product_alignment" in task ? task.product_alignment.product_acceptance_criteria.length : 0);
  if (criterionCount > HIGH_ACCEPTANCE_CRITERION_COUNT) {
    signals.push(`high acceptance-criterion count: ${criterionCount}`);
  }

  if (task.task_kind === "security_or_migration") {
    const acceptedPrecision = countSecurityContractPrecision(zones.justifiedSecurityContractText);
    if (acceptedPrecision > 0) {
      signals.push(`security/migration precision confined to declared contracts: ${acceptedPrecision} signal(s) accepted`);
    }
  }

  const closedWorldScore = (closedWorldHits * 2)
    + (task.starting_points.length > HIGH_STARTING_POINT_COUNT ? 1 : 0)
    + (task.authorization_scope.length > HIGH_AUTHORIZATION_PATTERN_COUNT ? 1 : 0);
  const overspecificationScore = densityScore(prescriptionHits, 2, 5)
    + densityScore(prosePathCount, 4, 9)
    + densityScore(inlineSymbolCount, 4, 9)
    + densityScore(numberedStepCount, 4, 9)
    + (codeFenceCount > 0 ? 2 : 0)
    + (task.starting_points.length > HIGH_STARTING_POINT_COUNT ? 1 : 0)
    + (task.authorization_scope.length > HIGH_AUTHORIZATION_PATTERN_COUNT ? 1 : 0)
    + (criterionCount > HIGH_ACCEPTANCE_CRITERION_COUNT ? 1 : 0);

  const closedWorldRisk = riskLevel(closedWorldScore);
  const overspecificationRisk = riskLevel(overspecificationScore);
  if (closedWorldRisk !== "low") warnings.push("DELEGATION_CLOSED_WORLD_RISK");
  if (overspecificationRisk !== "low") warnings.push("DELEGATION_OVERSPECIFICATION_RISK");
  if (productGrounding !== "complete" && productTask) warnings.push("DELEGATION_PRODUCT_GROUNDING_MISSING");

  const objectivelyBlocked = productTask && productGrounding !== "complete";
  return {
    verdict: objectivelyBlocked && mode === "enforce"
      ? "blocked"
      : warnings.length > 0 ? "passed_with_warnings" : "passed",
    mode,
    product_grounding: productGrounding,
    closed_world_risk: closedWorldRisk,
    overspecification_risk: overspecificationRisk,
    signals: unique(signals),
    warnings: unique(warnings)
  };
}

type TaskTextZones = {
  narrativeText: string;
  auditedDetailText: string;
  justifiedSecurityContractText: string;
  allText: string;
};

function taskTextZones(task: DelegationTaskV3): TaskTextZones {
  const outcomeText = [
    task.assignment,
    task.outcome.beneficiary,
    task.outcome.current_problem,
    task.outcome.desired_outcome,
    task.outcome.why_now,
    task.relevant_context ?? ""
  ];
  const kindNarrative = "product_alignment" in task
    ? [task.product_alignment.user_problem, task.product_alignment.product_goal]
    : "technical_context" in task
      ? [task.technical_context.enabling_value]
      : [];
  const criteriaText = [
    ...task.technical_acceptance_criteria.map(({ criterion }) => criterion),
    ...( "product_alignment" in task
      ? task.product_alignment.product_acceptance_criteria.map(({ criterion }) => criterion)
      : [])
  ];
  const boundaryText = [
    ...task.hard_constraints,
    ...task.must_preserve,
    ...task.explicit_exclusions,
    ...( "product_alignment" in task ? task.product_alignment.additional_must_not_become : [])
  ];
  const securityContractText = task.task_kind === "security_or_migration"
    ? [task.security_context.protected_contract, task.security_context.failure_risk, ...boundaryText]
    : [];
  const narrativeText = [...outcomeText, ...kindNarrative].join("\n");
  const auditedDetailText = task.task_kind === "security_or_migration"
    ? [...outcomeText, ...criteriaText].join("\n")
    : [...outcomeText, ...kindNarrative, ...criteriaText, ...boundaryText].join("\n");
  const securityIdentityText = task.task_kind === "security_or_migration"
    ? [task.security_context.protected_contract, task.security_context.failure_risk]
    : [];
  return {
    narrativeText,
    auditedDetailText,
    justifiedSecurityContractText: securityContractText.join("\n"),
    allText: [...outcomeText, ...kindNarrative, ...criteriaText, ...boundaryText, ...securityIdentityText].join("\n")
  };
}

function countSecurityContractPrecision(text: string): number {
  if (!text) return 0;
  return countPatternGroups(text, [...CLOSED_WORLD_PATTERNS, ...IMPLEMENTATION_PRESCRIPTION_PATTERNS])
    + countMatches(text, PROSE_PATH_PATTERN)
    + countMatches(text, INLINE_SYMBOL_PATTERN);
}

function countPatternGroups(text: string, patterns: readonly RegExp[]): number {
  return patterns.filter((pattern) => pattern.test(text)).length;
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}

function densityScore(count: number, mediumThreshold: number, highThreshold: number): number {
  return count >= highThreshold ? 2 : count >= mediumThreshold ? 1 : 0;
}

function riskLevel(score: number): "low" | "medium" | "high" {
  return score >= 4 ? "high" : score >= 1 ? "medium" : "low";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
