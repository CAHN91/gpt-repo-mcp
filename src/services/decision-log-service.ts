import { basename } from "node:path";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { readFilePrefix } from "./bounded-read.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";
import { RepoTreeService } from "./repo-tree-service.js";
import type { DecisionLogInput, DecisionSource } from "../contracts/decision.contract.js";

const DEFAULT_SOURCES: DecisionSource[] = ["docs", "readme", "agents", "package"];
const MAX_QUOTE_CHARS = 180;

type DecisionLogOptions = Omit<DecisionLogInput, "repo_id">;
type SourceHit = {
  path: string;
  source_type: DecisionSource;
  lines: string[];
};

export class DecisionLogService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(private readonly sandbox: PathSandbox) {}

  async decisionLog(options: DecisionLogOptions = {}) {
    const includeSources = new Set(options.include_sources ?? DEFAULT_SOURCES);
    const warnings: string[] = [];
    const sources = await this.collectSources(includeSources, warnings);
    const decisions = [];
    const conventions = [];

    for (const source of sources) {
      decisions.push(...extractDecisions(source));
      conventions.push(...extractConventions(source));
    }

    const gaps = [];
    if (decisions.length === 0) {
      gaps.push("No explicit architecture decisions found in selected sources.");
    }
    if (conventions.length === 0) {
      gaps.push("No explicit project conventions found in selected sources.");
    }
    if (!includeSources.has("docs") && !includeSources.has("readme")) {
      gaps.push("Docs/readme sources were not included, so project-level decisions may be incomplete.");
    }

    return {
      decisions: decisions.slice(0, DEFAULT_LIMITS.max_decision_log_sources),
      conventions: conventions.slice(0, DEFAULT_LIMITS.max_decision_log_sources),
      gaps,
      warnings
    };
  }

  private async collectSources(includeSources: Set<DecisionSource>, warnings: string[]): Promise<SourceHit[]> {
    const tree = await new RepoTreeService(this.sandbox).tree({
      include_files: true,
      max_depth: 4,
      page_size: DEFAULT_LIMITS.max_tree_entries,
      respect_default_excludes: true
    });
    if (tree.truncated) {
      warnings.push("TREE_TRUNCATED");
    }

    const candidates = tree.entries
      .filter((entry) => entry.type === "file")
      .map((entry) => ({ path: entry.path, source_type: classifySource(entry.path, includeSources) }))
      .filter((entry): entry is { path: string; source_type: DecisionSource } => Boolean(entry.source_type))
      .filter((entry) => !this.ignoreEngine.isSensitiveCandidate(entry.path));
    const sourcePaths = candidates.slice(0, DEFAULT_LIMITS.max_decision_log_sources);

    const sources = [];
    for (const sourcePath of sourcePaths) {
      const resolved = await this.sandbox.resolve(sourcePath.path);
      const readResult = await readFilePrefix(resolved.absolutePath, DEFAULT_LIMITS.max_decision_log_source_bytes);
      if (readResult.truncated) {
        warnings.push(`FILE_TRUNCATED:${sourcePath.path}`);
      }
      sources.push({
        path: sourcePath.path,
        source_type: sourcePath.source_type,
        lines: readResult.buffer.toString("utf8").split(/\r?\n/)
      });
    }

    if (candidates.length > sourcePaths.length) {
      warnings.push("SOURCE_LIMIT_REACHED");
    }
    return sources;
  }
}

function classifySource(path: string, includeSources: Set<DecisionSource>): DecisionSource | undefined {
  const lower = path.toLowerCase();
  const file = basename(lower);
  if (includeSources.has("readme") && file === "readme.md") {
    return "readme";
  }
  if (includeSources.has("agents") && file === "agents.md") {
    return "agents";
  }
  if (includeSources.has("package") && file === "package.json") {
    return "package";
  }
  if (includeSources.has("docs") && lower.startsWith("docs/") && /\.(md|mdx|txt)$/.test(lower)) {
    return "docs";
  }
  if (includeSources.has("comments") && /\.(ts|tsx|js|jsx|py|go|rs)$/.test(lower)) {
    return "comments";
  }
  return undefined;
}

function extractDecisions(source: SourceHit) {
  return source.lines.flatMap((line, index) => {
    const text = line.trim();
    if (!isDecisionLine(text, source.source_type)) {
      return [];
    }
    return [{
      title: decisionTitle(text),
      decision: cleanDecisionText(text),
      evidence: [{
        path: source.path,
        line: index + 1,
        quote: quote(text),
        source_type: source.source_type
      }],
      confidence: source.source_type === "comments" ? "low" as const : "medium" as const
    }];
  });
}

function extractConventions(source: SourceHit) {
  return source.lines.flatMap((line, index) => {
    const text = line.trim();
    if (!isConventionLine(text, source.source_type)) {
      return [];
    }
    return [{
      area: conventionArea(source.path, text),
      rule: cleanConventionText(text),
      evidence: [{ path: source.path, line: index + 1 }]
    }];
  });
}

function isDecisionLine(text: string, sourceType: DecisionSource): boolean {
  if (sourceType === "package") {
    return /"(type|scripts|dependencies|devDependencies)"\s*:/.test(text);
  }
  return /\b(decision|decided|architecture|architectural|policy|must|should|version 1|v1|read-only|read only)\b/i.test(text);
}

function isConventionLine(text: string, sourceType: DecisionSource): boolean {
  if (sourceType === "package") {
    return /"(build|test|lint|typecheck|dev)"\s*:/.test(text);
  }
  return /\b(convention|pattern|prefer|use |keep |do not|don't|must|should|avoid)\b/i.test(text);
}

function decisionTitle(text: string): string {
  const cleaned = cleanDecisionText(text);
  return cleaned.split(/[.:;]/)[0]?.slice(0, 80) || "Project decision";
}

function cleanDecisionText(text: string): string {
  return stripMarkdown(text).slice(0, 240);
}

function cleanConventionText(text: string): string {
  return stripMarkdown(text).slice(0, 240);
}

function conventionArea(path: string, text: string): string {
  if (path === "package.json") {
    return "scripts";
  }
  if (/security|secret|credential/i.test(text)) {
    return "security";
  }
  if (/test|lint|build|typecheck/i.test(text)) {
    return "validation";
  }
  return path.startsWith("docs/") ? "docs" : "project";
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^[-*]\s+/, "")
    .replace(/^#+\s+/, "")
    .replace(/^\/\/\s?/, "")
    .trim();
}

function quote(text: string): string {
  return stripMarkdown(text).slice(0, MAX_QUOTE_CHARS);
}
