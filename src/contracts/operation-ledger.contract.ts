import { z } from "zod";
import { OperationLedgerEntrySchema } from "./operation-receipt.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

export const OperationLedgerInputSchema = RepoInputSchema.extend({
  limit: z.number().int().positive().max(100).optional().describe("Maximum number of ledger events to return. Defaults to 20."),
  cursor: z.string().regex(/^\d+$/).optional().describe("Pagination cursor returned by a previous repo_operation_ledger call."),
  after_operation_id: z.string().optional().describe("Return events newer than this operation id, if it exists in the ledger.")
});

export const OperationLedgerResultSchema = z.object({
  ok: z.literal(true).describe("True when the read-only ledger lookup completed."),
  repo_id: z.string().describe("Repository id used for ledger filtering."),
  events: z.array(OperationLedgerEntrySchema).describe("Safe content-free ledger events for the repository, newest first."),
  next_cursor: z.string().optional().describe("Cursor for the next page when more events are available."),
  warnings: z.array(z.string()).describe("Stable non-fatal warnings from ledger lookup.")
});

export type OperationLedgerInput = z.infer<typeof OperationLedgerInputSchema>;
export type OperationLedgerResult = z.infer<typeof OperationLedgerResultSchema>;
