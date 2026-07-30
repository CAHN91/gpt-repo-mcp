import type { SemanticFinding, SemanticReviewInput, SemanticReviewResult, SemanticRiskCategory } from "../contracts/semantic-review.contract.js";
import { FailureEvidenceLoader } from "./failure-evidence-loader.js";
import { GitService } from "./git-service.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { detectSemanticRisks, type ReviewDiffFile } from "./semantic-risk-detectors.js";
import { SymbolContextService } from "./symbol-context-service.js";

const ALL_CATEGORIES: SemanticRiskCategory[] = ["public_contract", "api_schema", "migration", "authorization", "configuration", "async_error", "test_gap"];
const DEFAULT_MAX_FINDINGS = 30;
const SOURCE_PATH = /\.[cm]?[jt]sx?$/i;

export class SemanticReviewService {
  constructor(private readonly root: string, private readonly sandbox: PathSandbox) {}

  async review(input: SemanticReviewInput): Promise<SemanticReviewResult> {
    const scopedPaths = input.paths ? [...new Set(input.paths.map(validateRepoPath))].sort() : undefined;
    const categories = new Set(input.categories ?? ALL_CATEGORIES);
    const maxFindings = input.max_findings ?? DEFAULT_MAX_FINDINGS;
    const git = new GitService(this.root);
    const [status, unstaged, staged, validationEvidence] = await Promise.all([
      git.status(),
      git.diff(scopedPaths ? { paths: scopedPaths } : {}),
      git.diff(scopedPaths ? { staged: true, paths: scopedPaths } : { staged: true }),
      new FailureEvidenceLoader(this.root, this.sandbox).load({ repo_id: input.repo_id })
    ]);
    const files = mergeDiffFiles(staged.files, unstaged.files).filter((file) => !scopedPaths || scopedPaths.includes(file.path));
    const reviewedPaths = [...new Set(files.map((file) => file.path))].sort();
    const symbolPaths = reviewedPaths.filter((path) => SOURCE_PATH.test(path));
    const symbolContext = symbolPaths.length > 0
      ? await new SymbolContextService(this.root, this.sandbox).analyze({
        repo_id: input.repo_id,
        paths: symbolPaths,
        direction: "both",
        depth: 1,
        max_files: input.max_files ?? 300,
        max_symbols: 500,
        max_relations: 1_000
      })
      : undefined;

    let findings = detectSemanticRisks(files, categories);
    if (categories.has("test_gap") && symbolContext) findings.push(...testGapFindings(
      files,
      status.files.map((file) => file.path),
      new Set(status.files.filter((file) => Boolean(file.original_path)).map((file) => file.path)),
      symbolContext
    ));
    findings = enrichFindings(findings, symbolContext)
      .sort(compareFindings);
    const allFindingCount = findings.length;
    findings = findings.slice(0, maxFindings);
    const blockingIds = findings.filter((finding) => finding.blocks_ship).map((finding) => finding.id);
    const validationStatus = validationEvidence.validation.status ?? "missing";
    const warnings = [...validationEvidence.warnings];
    if (unstaged.truncated || staged.truncated) warnings.push("SEMANTIC_DIFF_TRUNCATED");
    if (symbolContext?.truncated) warnings.push("SEMANTIC_SYMBOL_CONTEXT_TRUNCATED");
    if (allFindingCount > findings.length) warnings.push("SEMANTIC_FINDING_LIMIT_REACHED");
    if (status.files.some((file) => file.index === "?" && (!scopedPaths || scopedPaths.includes(file.path)))) warnings.push("SEMANTIC_UNTRACKED_CONTENT_NOT_REVIEWED");
    if (findings.some((finding) => finding.confidence !== "high")) warnings.push("SEMANTIC_HEURISTIC_FINDINGS_PRESENT");
    const reviewRequired = blockingIds.length > 0 || validationStatus === "failed";

    return {
      ok: true,
      repo_id: input.repo_id,
      reviewed_paths: reviewedPaths,
      findings,
      summary: {
        total: findings.length,
        high: findings.filter((finding) => finding.priority === "high").length,
        medium: findings.filter((finding) => finding.priority === "medium").length,
        low: findings.filter((finding) => finding.priority === "low").length,
        blocking: blockingIds.length
      },
      ship_readiness: {
        status: reviewRequired ? "review_required" : "ready",
        blocking_finding_ids: blockingIds,
        validation_status: validationStatus
      },
      next_tool_payloads: {
        repo_git_review: { repo_id: input.repo_id, ...(scopedPaths ? { paths: scopedPaths } : {}) },
        ...(symbolPaths.length > 0 ? { repo_symbol_context: { repo_id: input.repo_id, paths: symbolPaths, direction: "both" as const, depth: 1 } } : {}),
        ...(validationStatus === "failed" ? { repo_failure_diagnose: { repo_id: input.repo_id } } : {})
      },
      truncated: unstaged.truncated || staged.truncated || Boolean(symbolContext?.truncated) || allFindingCount > findings.length,
      warnings: [...new Set(warnings)].sort()
    };
  }
}

function testGapFindings(
  files: ReviewDiffFile[],
  changedPaths: string[],
  renamedPaths: Set<string>,
  symbolContext: Awaited<ReturnType<SymbolContextService["analyze"]>>
): SemanticFinding[] {
  const changedTests = new Set(changedPaths.filter(isTestPath));
  const findings: SemanticFinding[] = [];
  for (const file of files) {
    if (!SOURCE_PATH.test(file.path) || isTestPath(file.path) || renamedPaths.has(file.path) || file.hunks.length === 0 || !hasBehaviorChange(file.hunks)) continue;
    const symbols = symbolContext.definitions.filter((definition) => definition.path === file.path).map((definition) => definition.name);
    const relatedTests = symbolContext.affected_tests.filter((test) => !changedTests.has(test));
    if (symbolContext.affected_tests.some((test) => changedTests.has(test))) continue;
    const confidence = relatedTests.length > 0 ? "medium" : "low";
    findings.push({
      id: `test_gap:${file.path}:1`,
      category: "test_gap",
      priority: "medium",
      confidence,
      title: "Behavior-bearing source changed without a related test change",
      path: file.path,
      evidence: ["The diff changes non-comment source lines.", "No symbol-affine test path is changed in the current worktree."],
      affected_symbols: symbols,
      related_paths: relatedTests,
      recommended_check: relatedTests.length > 0 ? `Review or run the nearest affected tests: ${relatedTests.slice(0, 5).join(", ")}.` : "Add or identify a focused regression test for the changed behavior.",
      blocks_ship: false
    });
  }
  return findings;
}

function enrichFindings(
  findings: SemanticFinding[],
  symbolContext: Awaited<ReturnType<SymbolContextService["analyze"]>> | undefined
): SemanticFinding[] {
  if (!symbolContext) return findings;
  const definitionsByPath = new Map<string, typeof symbolContext.definitions>();
  for (const definition of symbolContext.definitions) {
    const bucket = definitionsByPath.get(definition.path) ?? [];
    bucket.push(definition);
    definitionsByPath.set(definition.path, bucket);
  }
  return findings.map((finding) => {
    const definitions = definitionsByPath.get(finding.path) ?? [];
    const ids = new Set(definitions.map((definition) => definition.id));
    const dependentPaths = symbolContext.reverse_dependents.filter((entry) => ids.has(entry.symbol_id)).flatMap((entry) => entry.paths);
    return {
      ...finding,
      affected_symbols: [...new Set([...finding.affected_symbols, ...definitions.map((definition) => definition.name)])].sort(),
      related_paths: [...new Set([...finding.related_paths, ...dependentPaths])].sort()
    };
  });
}

function mergeDiffFiles(staged: ReviewDiffFile[], unstaged: ReviewDiffFile[]): ReviewDiffFile[] {
  const byPath = new Map<string, ReviewDiffFile>();
  for (const file of [...staged, ...unstaged]) {
    const existing = byPath.get(file.path);
    byPath.set(file.path, existing ? { ...existing, hunks: [...existing.hunks, ...file.hunks], status: file.status ?? existing.status } : { ...file });
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function hasBehaviorChange(hunks: string[]): boolean {
  return hunks.some((hunk) => hunk.split("\n").some((line) => /^[+-](?![+-])/.test(line) && !/^\s*(?:\/\/|\/\*|\*|#|$)/.test(line.slice(1))));
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function compareFindings(left: SemanticFinding, right: SemanticFinding): number {
  const priority = { high: 0, medium: 1, low: 2 };
  const confidence = { high: 0, medium: 1, low: 2 };
  return priority[left.priority] - priority[right.priority]
    || confidence[left.confidence] - confidence[right.confidence]
    || left.path.localeCompare(right.path)
    || (left.line ?? 0) - (right.line ?? 0);
}
