import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LastWriteResultSchema,
  OperationLedgerEntrySchema,
  OperationReceiptSchema,
  type LastWriteResult,
  type OperationLedgerEntry,
  type OperationReceipt,
  type OperationReceiptRef
} from "../contracts/operation-receipt.contract.js";
import { atomicWriteJson, isNotFoundError } from "../runtime/fs-helpers.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import { validateRepoPath } from "./path-sandbox.js";

export const LAST_WRITE_RECEIPT_PATH = ".chatgpt/operations/last-write.json";
export const OPERATION_LEDGER_PATH = ".chatgpt/operations/ledger.jsonl";

type WriteLastWriteInput = Omit<OperationReceipt, "schema_version" | "operation_id" | "timestamp"> & {
  ledger_event_type?: OperationLedgerEntry["event_type"];
  rollback_hint_before_ledger?: OperationReceipt["rollback_hint"];
};

export class OperationReceiptService {
  constructor(private readonly root: string) {}

  async writeLastWrite(input: WriteLastWriteInput): Promise<{
    ok: boolean;
    operation_receipt?: OperationReceiptRef;
    warnings: string[];
  }> {
    try {
      const {
        ledger_event_type: ledgerEventType,
        rollback_hint_before_ledger: rollbackHintBeforeLedger,
        ...receiptInput
      } = input;
      const receipt: OperationReceipt = {
        schema_version: 1,
        operation_id: createOperationId(),
        timestamp: new Date().toISOString(),
        ...sanitizeWriteInput(receiptInput)
      };
      const parsed = OperationReceiptSchema.parse(receipt);
      const pendingReceipt = rollbackHintBeforeLedger
        ? OperationReceiptSchema.parse({
            ...parsed,
            rollback_hint: sanitizeWriteInput({
              ...receiptInput,
              rollback_hint: rollbackHintBeforeLedger
            }).rollback_hint
          })
        : parsed;
      const absolutePath = join(this.root, LAST_WRITE_RECEIPT_PATH);
      await atomicWriteJson(absolutePath, pendingReceipt);
      const ledgerResult = await this.appendLedgerEntry(parsed, ledgerEventType);
      if (ledgerResult.ok && rollbackHintBeforeLedger) {
        await atomicWriteJson(absolutePath, parsed);
      }
      return {
        ok: true,
        operation_receipt: {
          operation_id: parsed.operation_id,
          path: LAST_WRITE_RECEIPT_PATH,
          ...(ledgerResult.ok ? { ledger_path: OPERATION_LEDGER_PATH } : {})
        },
        warnings: ledgerResult.ok ? [] : ledgerResult.warnings
      };
    } catch {
      return { ok: false, warnings: ["OPERATION_RECEIPT_WRITE_FAILED"] };
    }
  }

  async readLastWrite(repoId: string): Promise<LastWriteResult> {
    try {
      const raw = await readFile(join(this.root, LAST_WRITE_RECEIPT_PATH), "utf8");
      const parsed = OperationReceiptSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.repo_id !== repoId || !isSafeReceipt(parsed.data)) {
        return missing("INVALID_LAST_WRITE_RECEIPT");
      }
      return LastWriteResultSchema.parse({
        ok: true,
        found: true,
        receipt: parsed.data,
        next_tool_payloads: {
          repo_git_review: { repo_id: repoId }
        },
        warnings: []
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return missing("NO_LAST_WRITE_RECEIPT");
      }
      return missing("INVALID_LAST_WRITE_RECEIPT");
    }
  }

  private async appendLedgerEntry(receipt: OperationReceipt, eventType: OperationLedgerEntry["event_type"] = "write_applied"): Promise<{ ok: boolean; warnings: string[] }> {
    try {
      const entry: OperationLedgerEntry = OperationLedgerEntrySchema.parse({
        ...receipt,
        ledger_schema_version: 1,
        ledger_entry_id: createLedgerEntryId(),
        event_type: eventType,
        validation_ids: receipt.validation_ids ?? [],
        ledger_path: OPERATION_LEDGER_PATH
      });
      const absolutePath = join(this.root, OPERATION_LEDGER_PATH);
      await mkdir(dirname(absolutePath), { recursive: true });
      await appendFile(absolutePath, `${JSON.stringify(entry)}\n`, "utf8");
      return { ok: true, warnings: [] };
    } catch {
      return { ok: false, warnings: ["OPERATION_LEDGER_APPEND_FAILED"] };
    }
  }
}

function sanitizeWriteInput(input: WriteLastWriteInput): WriteLastWriteInput {
  assertSafeText(input.summary);
  return {
    ...input,
    touched_paths: uniqueSafePaths(input.touched_paths),
    changed_paths: uniqueSafePaths(input.changed_paths),
    created_paths: uniqueSafePaths(input.created_paths),
    modified_paths: uniqueSafePaths(input.modified_paths),
    ...(input.files
      ? {
          files: input.files.map((file) => ({
            ...file,
            path: validateRepoPath(file.path)
          }))
        }
      : {}),
    ...(input.rollback_hint
      ? {
          rollback_hint: {
            ...input.rollback_hint,
            reason: safeText(input.rollback_hint.reason),
            paths: input.rollback_hint.paths.map((pathHint) => ({
              ...pathHint,
              path: validateRepoPath(pathHint.path),
              reason: safeText(pathHint.reason)
            }))
          }
        }
      : {})
  };
}

function isSafeReceipt(receipt: OperationReceipt): boolean {
  const paths = [
    ...receipt.touched_paths,
    ...receipt.changed_paths,
    ...receipt.created_paths,
    ...receipt.modified_paths
  ];
  return (
    paths.every(isSafeRepoPath)
    && redactSensitiveText(receipt.summary) === receipt.summary
  );
}

function uniqueSafePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => validateRepoPath(path)))];
}

function safeText(value: string): string {
  assertSafeText(value);
  return value;
}

function assertSafeText(value: string): void {
  if (redactSensitiveText(value) !== value) {
    throw new Error("Unsafe receipt text.");
  }
}

function isSafeRepoPath(path: string): boolean {
  try {
    return validateRepoPath(path) === path && !path.startsWith("/");
  } catch {
    return false;
  }
}

function missing(warning: "NO_LAST_WRITE_RECEIPT" | "INVALID_LAST_WRITE_RECEIPT"): LastWriteResult {
  return {
    ok: true,
    found: false,
    next_tool_payloads: {},
    warnings: [warning]
  };
}

function createOperationId(): string {
  return `write-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function createLedgerEntryId(): string {
  return `ledger-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}
