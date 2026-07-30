import { z } from "zod";
import { FileSummarySchema } from "./file.contract.js";

export const RepoTreeResultSchema = z.object({
  entries: z.array(FileSummarySchema),
  excluded_summary: z.record(z.string(), z.number().int().nonnegative()),
  truncated: z.boolean(),
  next_cursor: z.string().optional().describe("Opaque cursor for the next tree page.")
});
