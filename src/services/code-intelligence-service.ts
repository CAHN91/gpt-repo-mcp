import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CodeIndexAction, CodeIndexResult } from "../contracts/code-index.contract.js";
import type { CodeIntelligenceProvider, SymbolContextInput } from "../contracts/symbol-context.contract.js";
import type { RepoConfig } from "./root-registry.js";
import { findCodebaseMemoryProject, type CodebaseMemoryClient, type CodebaseMemoryClientFactory } from "./codebase-memory-client.js";
import { CodebaseMemoryIndexService } from "./codebase-memory-index-service.js";

const MAX_GRAPH_DEFINITIONS = 50;
const MAX_TRACED_SYMBOLS = 8;
export class CodeIntelligenceService {
  private readonly indexService: CodebaseMemoryIndexService;

  constructor(
    private readonly clientFactory: CodebaseMemoryClientFactory,
    private readonly queryTimeoutMs: number,
    indexTimeoutMs: number
  ) {
    this.indexService = new CodebaseMemoryIndexService(clientFactory, queryTimeoutMs, indexTimeoutMs);
  }

  async enrich(repo: RepoConfig, input: SymbolContextInput): Promise<CodeIntelligenceProvider> {
    if (this.indexService.isRunning(repo.root)) {
      return fallback("indexing", true, "Codebase Memory indexing is in progress.");
    }

    let client: CodebaseMemoryClient | undefined;
    const deadline = Date.now() + this.queryTimeoutMs;
    try {
      client = await this.clientFactory(repo.root);
      const project = await findCodebaseMemoryProject(client, repo.root, remainingTimeout(deadline));
      if (!project) {
        return fallback(
          "index_required",
          true,
          "Ask the user whether to index this repository, then call repo_code_index with action=start only after approval."
        );
      }

      const definitions = await this.searchDefinitions(client, project, repo.root, input, deadline);
      const traces = await this.traceSymbols(client, project, input, deadline);
      return {
        name: "codebase_memory",
        status: "ready",
        index_available: true,
        graph: { definitions, callers: traces.callers, callees: traces.callees },
        warnings: []
      };
    } catch {
      return fallback("provider_unavailable", false, undefined, ["CODEBASE_MEMORY_UNAVAILABLE"]);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async index(repo: RepoConfig, action: CodeIndexAction): Promise<CodeIndexResult> {
    return this.indexService.index(repo, action);
  }

  private async searchDefinitions(
    client: CodebaseMemoryClient,
    project: string,
    repoRoot: string,
    input: SymbolContextInput,
    deadline: number
  ): Promise<Array<{ name: string; kind: string; path: string; line_start: number; line_end: number }>> {
    const calls: Array<Promise<Record<string, unknown>>> = [];
    if (input.symbols?.length) {
      calls.push(client.call("search_graph", {
        project,
        name_pattern: exactRegex(input.symbols),
        limit: Math.min(input.max_symbols ?? MAX_GRAPH_DEFINITIONS, MAX_GRAPH_DEFINITIONS),
        format: "json"
      }, remainingTimeout(deadline)));
    }
    if (input.paths?.length) {
      calls.push(client.call("search_graph", {
        project,
        file_pattern: exactRegex(input.paths),
        limit: Math.min(input.max_symbols ?? MAX_GRAPH_DEFINITIONS, MAX_GRAPH_DEFINITIONS),
        format: "json"
      }, remainingTimeout(deadline)));
    }
    const responses = await Promise.all(calls);
    const seen = new Set<string>();
    const output: Array<{ name: string; kind: string; path: string; line_start: number; line_end: number }> = [];
    for (const response of responses) {
      for (const entry of (Array.isArray(response.results) ? response.results : []).slice(0, MAX_GRAPH_DEFINITIONS * 2)) {
        if (!isRecord(entry) || typeof entry.name !== "string") continue;
        const path = safeRepoPath(repoRoot, entry.file_path);
        const lineStart = positiveInt(entry.start_line);
        const lineEnd = positiveInt(entry.end_line);
        if (!path || !lineStart || !lineEnd) continue;
        const key = `${entry.name}:${path}:${lineStart}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({ name: entry.name, kind: typeof entry.label === "string" ? entry.label : "symbol", path, line_start: lineStart, line_end: lineEnd });
      }
    }
    return output.slice(0, MAX_GRAPH_DEFINITIONS);
  }

  private async traceSymbols(client: CodebaseMemoryClient, project: string, input: SymbolContextInput, deadline: number): Promise<{
    callers: Array<{ name: string; hop: number }>;
    callees: Array<{ name: string; hop: number }>;
  }> {
    const callers: Array<{ name: string; hop: number }> = [];
    const callees: Array<{ name: string; hop: number }> = [];
    for (const symbol of (input.symbols ?? []).slice(0, MAX_TRACED_SYMBOLS)) {
      const response = await client.call("trace_path", {
        project,
        function_name: symbol,
        direction: input.direction ?? "both",
        depth: input.depth ?? 1,
        include_tests: true,
        format: "json"
      }, remainingTimeout(deadline));
      collectTrace(response.callers, callers);
      collectTrace(response.callees, callees);
    }
    return { callers: dedupeTrace(callers), callees: dedupeTrace(callees) };
  }
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Codebase Memory query deadline exceeded.");
  return remaining;
}

function fallback(
  status: CodeIntelligenceProvider["status"],
  indexAvailable: boolean,
  suggestedAction?: string,
  warnings: string[] = []
): CodeIntelligenceProvider {
  return { name: "codebase_memory", status, fallback_used: "native", index_available: indexAvailable, suggested_action: suggestedAction, warnings };
}

function exactRegex(values: string[]): string {
  return `^(?:${values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
}

function safeRepoPath(repoRoot: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const absolute = isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
  const repoRelative = relative(repoRoot, absolute);
  if (!repoRelative || repoRelative === ".." || repoRelative.startsWith(`..${sep}`) || isAbsolute(repoRelative)) return undefined;
  return repoRelative.split(sep).join("/");
}

function collectTrace(value: unknown, output: Array<{ name: string; hop: number }>): void {
  if (!Array.isArray(value)) return;
  for (const entry of value.slice(0, MAX_GRAPH_DEFINITIONS)) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.qualified_name === "string" ? entry.qualified_name : typeof entry.name === "string" ? entry.name : undefined;
    const hop = typeof entry.hop === "number" && Number.isInteger(entry.hop) && entry.hop >= 0 ? entry.hop : 0;
    if (name) output.push({ name: name.split(".").at(-1) ?? name, hop });
  }
}

function dedupeTrace(entries: Array<{ name: string; hop: number }>): Array<{ name: string; hop: number }> {
  return [...new Map(entries.map((entry) => [`${entry.name}:${entry.hop}`, entry])).values()].slice(0, MAX_GRAPH_DEFINITIONS);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
