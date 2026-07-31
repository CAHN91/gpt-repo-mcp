import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OperationLedgerInputSchema, OperationLedgerResultSchema, type OperationLedgerInput, type OperationLedgerResult } from "../contracts/operation-ledger.contract.js";
import { OperationLedgerEntrySchema, type OperationLedgerEntry } from "../contracts/operation-receipt.contract.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import { OPERATION_LEDGER_PATH } from "./operation-receipt-service.js";
import { validateRepoPath } from "./path-sandbox.js";

const DEFAULT_LIMIT = 20;

export class OperationLedgerService {
  constructor(private readonly root: string) {}

  async readAllForRepo(repoId: string): Promise<{ events: OperationLedgerEntry[]; warnings: string[] }> {
    const warnings = new Set<string>();
    const entries = await this.readEntries(warnings);
    return {
      events: entries.filter((entry) => entry.repo_id === repoId),
      warnings: [...warnings]
    };
  }

  async read(input: OperationLedgerInput): Promise<OperationLedgerResult> {
    const args = OperationLedgerInputSchema.parse(input);
    const warnings = new Set<string>();
    const entries = await this.readEntries(warnings);
    const repoEntries = entries.filter((entry) => entry.repo_id === args.repo_id);
    const afterFiltered = filterAfterOperation(repoEntries, args.after_operation_id);
    const newestFirst = [...afterFiltered].reverse();
    const start = args.cursor ? Number(args.cursor) : 0;
    const limit = args.limit ?? DEFAULT_LIMIT;
    const events = newestFirst.slice(start, start + limit);
    const nextCursor = start + limit < newestFirst.length ? String(start + limit) : undefined;

    return OperationLedgerResultSchema.parse({
      ok: true,
      repo_id: args.repo_id,
      events,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      warnings: [...warnings]
    });
  }

  private async readEntries(warnings: Set<string>): Promise<OperationLedgerEntry[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.root, OPERATION_LEDGER_PATH), "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      warnings.add("OPERATION_LEDGER_READ_FAILED");
      return [];
    }

    const entries: OperationLedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = OperationLedgerEntrySchema.parse(JSON.parse(line));
        if (!isSafeLedgerEntry(parsed)) {
          warnings.add("OPERATION_LEDGER_INVALID_LINES");
          continue;
        }
        entries.push(parsed);
      } catch {
        warnings.add("OPERATION_LEDGER_INVALID_LINES");
      }
    }
    return entries;
  }
}

function filterAfterOperation(entries: OperationLedgerEntry[], operationId: string | undefined): OperationLedgerEntry[] {
  if (!operationId) {
    return entries;
  }
  const index = entries.findIndex((entry) => entry.operation_id === operationId);
  return index >= 0 ? entries.slice(index + 1) : [];
}

function isSafeLedgerEntry(entry: OperationLedgerEntry): boolean {
  const paths = [
    ...entry.touched_paths,
    ...entry.changed_paths,
    ...entry.created_paths,
    ...entry.modified_paths,
    ...(entry.files ?? []).map((file) => file.path),
    ...(entry.rollback_hint?.paths ?? []).map((hint) => hint.path)
  ];
  return (
    paths.every(isSafeRepoPath)
    && redactSensitiveText(entry.summary) === entry.summary
    && (!entry.rollback_hint || redactSensitiveText(entry.rollback_hint.reason) === entry.rollback_hint.reason)
    && (entry.rollback_hint?.paths ?? []).every((hint) => redactSensitiveText(hint.reason) === hint.reason)
  );
}

function isSafeRepoPath(path: string): boolean {
  try {
    return validateRepoPath(path) === path && !path.startsWith("/");
  } catch {
    return false;
  }
}
