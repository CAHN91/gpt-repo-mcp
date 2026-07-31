import ignore from "ignore";
import type { FailureCandidate, FailureDiagnoseInput, FailureDiagnoseResult } from "../contracts/failure-diagnose.contract.js";
import { GitService } from "./git-service.js";
import { FailureEvidenceLoader } from "./failure-evidence-loader.js";
import { OperationsPolicy } from "./operations-policy.js";
import { PathSandbox, validateRepoPath } from "./path-sandbox.js";
import { SymbolContextService } from "./symbol-context-service.js";

const DEFAULT_MAX_DIAGNOSTICS = 100;
const DEFAULT_MAX_CANDIDATES = 20;
const SYMBOL_SOURCE_PATH = /\.[cm]?[jt]sx?$/i;

type CandidateState = {
  path: string;
  score: number;
  evidence: Set<string>;
  heuristics: Set<string>;
  symbols: Set<string>;
  affectedTests: Set<string>;
  recommendedChecks: Set<string>;
};

export class FailureDiagnoseService {
  constructor(
    private readonly root: string,
    private readonly sandbox: PathSandbox,
    private readonly operationsPolicy: OperationsPolicy
  ) {}

  async diagnose(input: FailureDiagnoseInput): Promise<FailureDiagnoseResult> {
    const scopePaths = input.scope_paths ? new Set(input.scope_paths.map(validateRepoPath)) : undefined;
    const maxDiagnostics = input.max_diagnostics ?? DEFAULT_MAX_DIAGNOSTICS;
    const maxCandidates = input.max_candidates ?? DEFAULT_MAX_CANDIDATES;
    const evidence = await new FailureEvidenceLoader(this.root, this.sandbox).load(input);
    const allDiagnostics = evidence.diagnostics.filter((diagnostic) => !scopePaths || !diagnostic.path || scopePaths.has(diagnostic.path));
    const diagnostics = allDiagnostics.slice(0, maxDiagnostics);
    const changes = await this.currentChanges();
    const changedPaths = changes.paths;
    const diagnosticPaths = [...new Set(diagnostics.map((diagnostic) => diagnostic.path).filter((path): path is string => Boolean(path)))].sort();
    const symbolPaths = diagnosticPaths.filter((path) => SYMBOL_SOURCE_PATH.test(path)).slice(0, 20);
    const symbolContext = symbolPaths.length > 0
      ? await new SymbolContextService(this.root, this.sandbox).analyze({ repo_id: input.repo_id, paths: symbolPaths, direction: "both", depth: 1, max_files: 200, max_symbols: 200, max_relations: 500 })
      : undefined;
    const states = new Map<string, CandidateState>();

    for (const diagnostic of diagnostics) {
      if (!diagnostic.path) continue;
      const candidate = stateFor(states, diagnostic.path);
      candidate.score += 50;
      candidate.evidence.add(`Diagnostic ${diagnostic.tool}${diagnostic.code ? ` ${diagnostic.code}` : ""}${diagnostic.line ? ` at line ${diagnostic.line}` : ""}.`);
      if (diagnostic.line && changes.lines.get(diagnostic.path)?.has(diagnostic.line)) {
        candidate.score += 20;
        candidate.evidence.add("Diagnostic location overlaps an added or changed line in the current diff.");
      }
      candidate.recommendedChecks.add(`Inspect ${diagnostic.path}${diagnostic.line ? ` around line ${diagnostic.line}` : ""}.`);
    }
    for (const path of changedPaths) {
      const candidate = states.get(path);
      if (candidate) {
        candidate.score += 25;
        candidate.evidence.add("Path is changed in the current worktree.");
      }
    }
    for (const path of evidence.touched_paths) {
      const candidate = states.get(path);
      if (candidate) {
        candidate.score += 10;
        candidate.evidence.add("Path is linked from the current work session or latest write receipt.");
      }
    }
    if (symbolContext) {
      for (const definition of symbolContext.definitions) {
        if (scopePaths && !scopePaths.has(definition.path)) continue;
        const candidate = stateFor(states, definition.path);
        candidate.symbols.add(definition.name);
        if (!diagnosticPaths.includes(definition.path)) {
          candidate.score += changedPaths.includes(definition.path) ? 35 : 20;
          candidate.heuristics.add("Symbol call/reference expansion connects this path to a diagnostic location.");
        } else {
          candidate.score += 10;
          candidate.evidence.add("Diagnostic path contains indexed symbol definitions.");
        }
        for (const test of symbolContext.affected_tests) candidate.affectedTests.add(test);
      }
      for (const dependent of symbolContext.reverse_dependents) {
        for (const path of dependent.paths) {
          if (scopePaths && !scopePaths.has(path)) continue;
          const candidate = stateFor(states, path);
          candidate.score += changedPaths.includes(path) ? 20 : 5;
          candidate.heuristics.add("Path references a symbol connected to the failure location.");
        }
      }
    }

    const candidates = [...states.values()]
      .map(toCandidate)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, maxCandidates);
    const allowedTests = this.allowedFocusedTests(candidates.flatMap((candidate) => candidate.affected_tests));
    const warnings = [...evidence.warnings];
    if (allDiagnostics.length === 0) warnings.push("FAILURE_NO_DIAGNOSTICS_PARSED");
    if (allDiagnostics.length > diagnostics.length) warnings.push("FAILURE_DIAGNOSTIC_LIMIT_REACHED");
    if (states.size > candidates.length) warnings.push("FAILURE_CANDIDATE_LIMIT_REACHED");
    if (symbolContext?.truncated) warnings.push("FAILURE_SYMBOL_CONTEXT_TRUNCATED");

    return {
      ok: true,
      repo_id: input.repo_id,
      validation: evidence.validation,
      diagnostics,
      candidates,
      correlations: { changed_paths: changedPaths, touched_paths: evidence.touched_paths, symbol_paths: symbolPaths },
      next_tool_payloads: {
        ...(diagnostics[0]?.path ? { repo_fetch_file: { repo_id: input.repo_id, path: diagnostics[0].path } } : {}),
        ...(symbolPaths.length > 0 ? { repo_symbol_context: { repo_id: input.repo_id, paths: symbolPaths, direction: "both" as const, depth: 1 } } : {}),
        ...(allowedTests.length > 0 ? { repo_validate: { repo_id: input.repo_id, profile: "test" as const, test_paths: allowedTests } } : {})
      },
      truncated: evidence.truncated || allDiagnostics.length > diagnostics.length || states.size > candidates.length || Boolean(symbolContext?.truncated),
      warnings: [...new Set(warnings)].sort()
    };
  }

  private async currentChanges(): Promise<{ paths: string[]; lines: Map<string, Set<number>> }> {
    try {
      const git = new GitService(this.root);
      const [status, unstaged, staged] = await Promise.all([git.status(), git.diff({}), git.diff({ staged: true })]);
      const lines = new Map<string, Set<number>>();
      for (const file of [...staged.files, ...unstaged.files]) {
        const bucket = lines.get(file.path) ?? new Set<number>();
        for (const hunk of file.hunks) for (const line of addedLines(hunk)) bucket.add(line);
        lines.set(file.path, bucket);
      }
      return { paths: status.files.map((file) => file.path).sort(), lines };
    } catch {
      return { paths: [], lines: new Map() };
    }
  }

  private allowedFocusedTests(paths: string[]): string[] {
    const globs = this.operationsPolicy.config.validation_test_path_globs;
    if (!this.operationsPolicy.config.enabled || !this.operationsPolicy.config.validation_enabled || globs.length === 0) return [];
    const matcher = ignore().add(globs);
    return [...new Set(paths)].filter((path) => matcher.ignores(path)).sort().slice(0, this.operationsPolicy.config.max_paths_per_operation);
  }
}

function stateFor(states: Map<string, CandidateState>, path: string): CandidateState {
  const existing = states.get(path);
  if (existing) return existing;
  const created: CandidateState = { path, score: 0, evidence: new Set(), heuristics: new Set(), symbols: new Set(), affectedTests: new Set(), recommendedChecks: new Set() };
  states.set(path, created);
  return created;
}

function toCandidate(state: CandidateState): FailureCandidate {
  const score = Math.min(100, state.score);
  return {
    path: state.path,
    score,
    confidence: score >= 70 && state.evidence.size >= 2 ? "high" : score >= 35 ? "medium" : "low",
    evidence: [...state.evidence].sort(),
    heuristics: [...state.heuristics].sort(),
    symbols: [...state.symbols].sort(),
    affected_tests: [...state.affectedTests].sort(),
    recommended_checks: [...state.recommendedChecks].sort()
  };
}

function addedLines(hunk: string): number[] {
  const lines = hunk.split("\n");
  const header = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(lines[0] ?? "");
  let current = Number.parseInt(header?.[1] ?? "1", 10);
  const added: number[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("+") && !line.startsWith("+++")) { added.push(current); current += 1; }
    else if (!line.startsWith("-") || line.startsWith("---")) current += 1;
  }
  return added;
}
