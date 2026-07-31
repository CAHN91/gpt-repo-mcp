import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const CodeIndexActionSchema = z.enum(["start", "status"]);
export const CodeIndexStatusSchema = z.enum([
  "index_required",
  "queued",
  "running",
  "ready",
  "degraded",
  "failed",
  "provider_unavailable"
]);

export const CodeIndexInputSchema = RepoInputSchema.extend({
  action: CodeIndexActionSchema.describe(
    "Use start only after the user explicitly approves indexing; use status to monitor it."
  )
}).strict();

export const CodeIndexEventSchema = z.object({
  at: z.string(),
  status: CodeIndexStatusSchema,
  message: z.string()
});

export const CodeIndexResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  provider: z.literal("codebase_memory"),
  action: CodeIndexActionSchema,
  status: CodeIndexStatusSchema,
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  events: z.array(CodeIndexEventSchema),
  warnings: z.array(z.string())
});

export type CodeIndexInput = z.infer<typeof CodeIndexInputSchema>;
export type CodeIndexResult = z.infer<typeof CodeIndexResultSchema>;
export type CodeIndexStatus = z.infer<typeof CodeIndexStatusSchema>;
export type CodeIndexEvent = z.infer<typeof CodeIndexEventSchema>;
export type CodeIndexAction = z.infer<typeof CodeIndexActionSchema>;
