import type { SemanticFinding, SemanticRiskCategory } from "../contracts/semantic-review.contract.js";

export type ReviewDiffFile = { path: string; original_path?: string; status?: string; hunks: string[] };
type ChangedLine = { kind: "added" | "removed"; line: number; content: string };

export function detectSemanticRisks(files: ReviewDiffFile[], categories: Set<SemanticRiskCategory>): SemanticFinding[] {
  const findings: SemanticFinding[] = [];
  for (const file of files) {
    if (file.status === "renamed" && file.hunks.length === 0) continue;
    const lines = changedLines(file.hunks);
    if (categories.has("public_contract")) findings.push(...publicContractRisks(file, lines));
    if (categories.has("api_schema")) findings.push(...apiSchemaRisks(file, lines));
    if (categories.has("authorization")) findings.push(...authorizationRisks(file, lines));
    if (categories.has("configuration")) findings.push(...configurationRisks(file, lines, files));
    if (categories.has("async_error")) findings.push(...asyncErrorRisks(file, lines));
  }
  if (categories.has("migration")) findings.push(...migrationRisks(files));
  return dedupeFindings(findings);
}

function publicContractRisks(file: ReviewDiffFile, lines: ChangedLine[]): SemanticFinding[] {
  const removed = lines.filter((line) => line.kind === "removed").map((line) => ({ ...line, declaration: exportedDeclaration(line.content) })).filter((line): line is ChangedLine & { declaration: ExportedDeclaration } => Boolean(line.declaration));
  const added = lines.filter((line) => line.kind === "added").map((line) => exportedDeclaration(line.content)).filter((item): item is ExportedDeclaration => Boolean(item));
  return removed.filter((line) => {
    const replacement = added.find((item) => item.symbol === line.declaration.symbol && item.kind === line.declaration.kind);
    return !replacement || !(line.declaration.kind === "function" || line.declaration.kind === "class") || replacement.signature !== line.declaration.signature;
  }).map((line) => finding({
    category: "public_contract",
    priority: "high",
    confidence: "high",
    title: "Exported contract declaration was removed or replaced",
    path: file.path,
    line: line.line,
    evidence: ["The diff removes or changes an exported declaration signature.", `Exported symbol: ${line.declaration.symbol}.`],
    affectedSymbols: [line.declaration.symbol],
    recommendedCheck: "Inspect symbol dependents and verify every external consumer or compatibility layer was updated."
  }));
}

function apiSchemaRisks(file: ReviewDiffFile, lines: ChangedLine[]): SemanticFinding[] {
  if (!/(api|routes?|controllers?|schemas?|contracts?|dto)/i.test(file.path) && !lines.some((line) => /(z\.object|router\.|Request|Response|Schema)/.test(line.content))) return [];
  const structural = lines.find((line) => /(?:z\.object|interface\s+\w*(?:Request|Response)|type\s+\w*(?:Request|Response)|router\.|@(?:Get|Post|Put|Patch|Delete))/.test(line.content));
  if (!structural) return [];
  return [finding({
    category: "api_schema",
    priority: "medium",
    confidence: "medium",
    title: "API or schema contract changed",
    path: file.path,
    line: structural.line,
    evidence: ["The diff changes a route, DTO, request/response type, or schema declaration."],
    recommendedCheck: "Verify producers, consumers, contract tests, and backward-compatibility expectations for this contract."
  })];
}

function authorizationRisks(file: ReviewDiffFile, lines: ChangedLine[]): SemanticFinding[] {
  if (!/(auth|permission|policy|roles?|token|session)/i.test(file.path) && !lines.some((line) => /(authorize|permission|role|token|session|isAdmin)/i.test(line.content))) return [];
  const control = lines.find((line) => /(?:if\s*\(|authorize|permission|role|token|session|allow|deny)/i.test(line.content));
  if (!control) return [];
  return [finding({
    category: "authorization",
    priority: "high",
    confidence: "medium",
    title: "Authorization-sensitive control flow changed",
    path: file.path,
    line: control.line,
    evidence: ["The diff changes authorization-, role-, token-, or session-related control flow."],
    recommendedCheck: "Run positive and negative authorization tests, including least-privilege and unauthenticated cases."
  })];
}

function configurationRisks(file: ReviewDiffFile, lines: ChangedLine[], files: ReviewDiffFile[]): SemanticFinding[] {
  const addedEnv = lines.filter((line) => line.kind === "added").map((line) => ({ ...line, key: envKey(line.content) })).filter((line): line is ChangedLine & { key: string } => Boolean(line.key));
  if (addedEnv.length === 0) return [];
  const documentationChanged = files.some((changed) => /(^|\/)(README|docs|\.env\.example|config)/i.test(changed.path));
  if (documentationChanged) return [];
  return addedEnv.map((line) => finding({
    category: "configuration",
    priority: "medium",
    confidence: "high",
    title: "New environment contract lacks a changed configuration example",
    path: file.path,
    line: line.line,
    evidence: [`New environment key referenced: ${line.key}.`, "No README, docs, config, or .env.example path is changed in the same diff."],
    affectedSymbols: [line.key],
    recommendedCheck: "Document the variable, validation/default behavior, and deployment provisioning before ship."
  }));
}

function asyncErrorRisks(file: ReviewDiffFile, lines: ChangedLine[]): SemanticFinding[] {
  const swallowed = lines.find((line) => line.kind === "added" && /catch\s*(?:\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(?.*?\)?\s*=>\s*\{?\s*\}?\s*\)/.test(line.content));
  if (!swallowed) return [];
  return [finding({
    category: "async_error",
    priority: "high",
    confidence: "high",
    title: "New error path silently swallows a failure",
    path: file.path,
    line: swallowed.line,
    evidence: ["The added code contains an empty catch handler or no-op promise rejection handler."],
    recommendedCheck: "Handle, propagate, or deliberately record the failure and add a regression test for the rejected path."
  })];
}

function migrationRisks(files: ReviewDiffFile[]): SemanticFinding[] {
  const migrationChanged = files.some((file) => /(^|\/)(migrations?|alembic|prisma\/migrations)(\/|$)/i.test(file.path));
  if (migrationChanged) return [];
  const schema = files.find((file) => /(schema|models?|entities|database)\.[cm]?[jt]s$|prisma\/schema\.prisma$/i.test(file.path) && file.hunks.length > 0);
  if (!schema) return [];
  return [finding({
    category: "migration",
    priority: "high",
    confidence: "medium",
    title: "Persistence schema changed without a migration path",
    path: schema.path,
    evidence: ["A persistence schema/model path changed.", "No migration path is changed in the same diff."],
    recommendedCheck: "Confirm whether a migration is required and verify both upgrade and rollback behavior."
  })];
}

function changedLines(hunks: string[]): ChangedLine[] {
  const result: ChangedLine[] = [];
  for (const hunk of hunks) {
    const lines = hunk.split("\n");
    const header = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(lines[0] ?? "");
    let oldLine = Number.parseInt(header?.[1] ?? "1", 10);
    let newLine = Number.parseInt(header?.[2] ?? "1", 10);
    for (const line of lines.slice(1)) {
      if (line.startsWith("+") && !line.startsWith("+++")) { result.push({ kind: "added", line: newLine, content: line.slice(1) }); newLine += 1; }
      else if (line.startsWith("-") && !line.startsWith("---")) { result.push({ kind: "removed", line: oldLine, content: line.slice(1) }); oldLine += 1; }
      else { oldLine += 1; newLine += 1; }
    }
  }
  return result;
}

type ExportedDeclaration = { symbol: string; kind: string; signature: string };

function exportedDeclaration(content: string): ExportedDeclaration | undefined {
  const match = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:declare\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(content);
  if (!match?.[1] || !match[2]) return undefined;
  return { symbol: match[2], kind: match[1], signature: content.split("{")[0]!.replace(/\s+/g, " ").trim() };
}

function envKey(content: string): string | undefined {
  return /(?:process\.env\.|import\.meta\.env\.)([A-Z][A-Z0-9_]*)/.exec(content)?.[1]
    ?? /(?:env\[|getenv\()["']([A-Z][A-Z0-9_]*)["']/.exec(content)?.[1];
}

function finding(input: {
  category: SemanticRiskCategory;
  priority: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  title: string;
  path: string;
  line?: number;
  evidence: string[];
  affectedSymbols?: string[];
  relatedPaths?: string[];
  recommendedCheck: string;
}): SemanticFinding {
  const id = `${input.category}:${input.path}:${input.line ?? 1}`;
  return {
    id,
    category: input.category,
    priority: input.priority,
    confidence: input.confidence,
    title: input.title,
    path: input.path,
    ...(input.line ? { line: input.line } : {}),
    evidence: input.evidence,
    affected_symbols: input.affectedSymbols ?? [],
    related_paths: input.relatedPaths ?? [],
    recommended_check: input.recommendedCheck,
    blocks_ship: input.priority === "high" && input.confidence === "high"
  };
}

function dedupeFindings(findings: SemanticFinding[]): SemanticFinding[] {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}
