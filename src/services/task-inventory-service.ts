import { DEFAULT_LIMITS } from "../policies/limits.js";
import { FileClassifier } from "./file-classifier.js";
import { isExcludedByGlob, matchesGlob } from "./glob-service.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { PathSandbox } from "./path-sandbox.js";
import { RepoTreeService } from "./repo-tree-service.js";
import { readFilePrefix } from "./bounded-read.js";
import type { TaskInventoryInput, TaskKind } from "../contracts/task.contract.js";

const DEFAULT_LABELS: TaskKind[] = ["todo", "fixme", "hack", "checkbox", "roadmap"];

export type TaskInventoryOptions = Omit<TaskInventoryInput, "repo_id">;

export type TaskInventoryLimits = {
  maxSearchResults: number;
  maxTreeEntries: number;
  maxFiles: number;
  maxTreePages: number;
  maxFileBytes: number;
};

type TaskInventoryItem = {
  path: string;
  line: number;
  kind: TaskKind;
  text: string;
  surrounding_context?: string;
};

export class TaskInventoryService {
  private readonly ignoreEngine = new IgnoreEngine();
  private readonly classifier = new FileClassifier(this.ignoreEngine);
  private readonly limits: TaskInventoryLimits;

  constructor(
    private readonly sandbox: PathSandbox,
    limits: Partial<TaskInventoryLimits> = {}
  ) {
    this.limits = {
      maxSearchResults: limits.maxSearchResults ?? DEFAULT_LIMITS.max_search_results,
      maxTreeEntries: limits.maxTreeEntries ?? DEFAULT_LIMITS.max_tree_entries,
      maxFiles: limits.maxFiles ?? DEFAULT_LIMITS.max_task_inventory_files,
      maxTreePages: limits.maxTreePages ?? DEFAULT_LIMITS.max_task_inventory_tree_pages,
      maxFileBytes: limits.maxFileBytes ?? DEFAULT_LIMITS.max_task_inventory_file_bytes
    };
  }

  async inventory(options: TaskInventoryOptions = {}) {
    const maxResults = Math.min(options.max_results ?? this.limits.maxSearchResults, this.limits.maxSearchResults);
    const labels = new Set(options.labels ?? DEFAULT_LABELS);
    const start = parseCursor(options.cursor);
    const warnings: string[] = [];
    const treeService = new RepoTreeService(this.sandbox);
    const tasks: TaskInventoryItem[] = [];
    let scannedFileCount = 0;
    let scanComplete = true;
    let treeCursor: string | undefined;
    let treePages = 0;

    while (treePages < this.limits.maxTreePages && scannedFileCount < this.limits.maxFiles) {
      const tree = await treeService.tree({
        include_files: true,
        page_size: this.limits.maxTreeEntries,
        respect_default_excludes: true,
        exclude_prefixes: [".chatgpt"],
        cursor: treeCursor
      });
      treePages += 1;

      for (const entry of tree.entries) {
        if (entry.type !== "file") {
          continue;
        }
        if (!isIncluded(entry.path, options.include_globs) || isExcludedByGlob(entry.path, options.exclude_globs)) {
          continue;
        }
        if (this.ignoreEngine.isSensitiveCandidate(entry.path)) {
          continue;
        }
        if (entry.path.startsWith(".chatgpt/") || this.ignoreEngine.isInternalArtifact(entry.path)) {
          continue;
        }
        if (scannedFileCount >= this.limits.maxFiles) {
          scanComplete = false;
          addWarning(warnings, "SCAN_FILE_LIMIT_REACHED");
          break;
        }
        const resolved = await this.sandbox.resolve(entry.path);
        const classification = await this.classifier.classify(entry.path, resolved.absolutePath);
        if (classification.is_binary) {
          continue;
        }
        scannedFileCount += 1;
        const readResult = await readFilePrefix(resolved.absolutePath, this.limits.maxFileBytes);
        if (readResult.truncated) {
          addWarning(warnings, `FILE_TRUNCATED:${entry.path}`);
        }
        const text = readResult.buffer.toString("utf8");
        const lines = text.split(/\r?\n/);
        lines.forEach((lineText, index) => {
          const kind = classifyTask(lineText, labels);
          if (!kind) {
            return;
          }
          tasks.push({
            path: entry.path,
            line: index + 1,
            kind,
            text: cleanTaskText(lineText),
            surrounding_context: contextFor(lines, index)
          });
        });
      }

      if (!tree.truncated) {
        treeCursor = undefined;
        break;
      }
      treeCursor = tree.next_cursor;
      if (!treeCursor) {
        scanComplete = false;
        addWarning(warnings, "TREE_CURSOR_MISSING");
        break;
      }
    }

    if (treeCursor) {
      scanComplete = false;
      if (scannedFileCount >= this.limits.maxFiles) {
        addWarning(warnings, "SCAN_FILE_LIMIT_REACHED");
      } else if (treePages >= this.limits.maxTreePages) {
        addWarning(warnings, "SCAN_TREE_PAGE_LIMIT_REACHED");
      } else {
        addWarning(warnings, "TREE_SCAN_INCOMPLETE");
      }
    }

    tasks.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || kindOrder(a.kind) - kindOrder(b.kind));
    const returned = tasks.slice(start, start + maxResults);
    const nextIndex = start + returned.length;
    const truncated = nextIndex < tasks.length;

    return {
      tasks: returned,
      matched_count: tasks.length,
      returned_count: returned.length,
      scanned_file_count: scannedFileCount,
      scan_complete: scanComplete,
      truncated,
      next_cursor: truncated ? String(nextIndex) : undefined,
      warnings
    };
  }
}

function classifyTask(line: string, labels: Set<TaskKind>): TaskKind | undefined {
  if (labels.has("checkbox") && /^\s*[-*]\s+\[[ xX]\]\s+\S/.test(line)) {
    return "checkbox";
  }
  if (labels.has("fixme") && /\bFIXME\b:?/i.test(line)) {
    return "fixme";
  }
  if (labels.has("hack") && /\bHACK\b:?/i.test(line)) {
    return "hack";
  }
  if (labels.has("todo") && /\bTODO\b:?/i.test(line)) {
    return "todo";
  }
  if (labels.has("roadmap") && /\b(ROADMAP|NEXT STEPS?|FOLLOW[- ]?UP)\b:?/i.test(line)) {
    return "roadmap";
  }
  return undefined;
}

function cleanTaskText(line: string): string {
  return line.trim().replace(/^[-*]\s+\[[ xX]\]\s*/, "").trim();
}

function contextFor(lines: string[], index: number): string | undefined {
  const before = lines[index - 1]?.trim();
  const after = lines[index + 1]?.trim();
  const context = [before, after].filter(Boolean).join(" ");
  return context || undefined;
}

function isIncluded(path: string, includeGlobs: string[] = []): boolean {
  if (includeGlobs.length === 0) {
    return true;
  }
  return includeGlobs.some((glob) => matchesGlob(path, glob));
}

function parseCursor(cursor?: string): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function kindOrder(kind: TaskKind): number {
  return DEFAULT_LABELS.indexOf(kind);
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}
