import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";
import { ValidationProfileSchema, ValidationCommandStatusSchema } from "./validation.contract.js";

const NonEmptyStringSchema = z.string().min(1);
const WorkSessionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,120}$/);
const RepoRelativePathSchema = z.string().refine(isRepoRelativePathLiteral, {
  message: "Expected a safe repo-relative POSIX path."
});

export const WorkSessionStatusSchema = z.enum(["active", "blocked", "completed"]);

export const PendingPatchsetRefSchema = z.object({
  patchset_id: NonEmptyStringSchema.describe("Patchset id linked to this work session."),
  status: z.enum(["prepared", "applied", "reviewed", "rolled_back"]).optional().describe("Known patchset status when recorded.")
});

export const WorkSessionValidationResultSchema = z.object({
  validation_id: z.string().optional().describe("Optional future validation result id."),
  profile: ValidationProfileSchema.optional().describe("Validation profile that was run or planned."),
  status: ValidationCommandStatusSchema.describe("Observed validation status."),
  note: z.string().optional().describe("Short content-free validation note without command output.")
});

export const WorkSessionSchema = z.object({
  schema_version: z.literal(1).describe("Work-session schema version."),
  work_session_id: WorkSessionIdSchema.describe("Stable local work-session id."),
  repo_id: z.string().describe("Repository id this session belongs to."),
  title: NonEmptyStringSchema.describe("Short human-readable work-session title."),
  objective: NonEmptyStringSchema.describe("Current implementation objective for this session."),
  status: WorkSessionStatusSchema.describe("Current work-session status."),
  created_at: z.string().datetime().describe("UTC timestamp when the work session was created."),
  updated_at: z.string().datetime().describe("UTC timestamp when the work session was last updated."),
  constraints: z.array(NonEmptyStringSchema).default([]).describe("Constraints or boundaries to preserve while working."),
  files_inspected: z.array(RepoRelativePathSchema).default([]).describe("Repo-relative files already inspected for this work session."),
  decisions: z.array(NonEmptyStringSchema).default([]).describe("Content-free decisions made during this work session."),
  assumptions: z.array(NonEmptyStringSchema).default([]).describe("Content-free assumptions currently guiding the work session."),
  touched_files: z.array(RepoRelativePathSchema).default([]).describe("Repo-relative files touched or expected to be touched by this work session."),
  pending_patchsets: z.array(PendingPatchsetRefSchema).default([]).describe("Patchsets linked to this work session."),
  validation_results: z.array(WorkSessionValidationResultSchema).default([]).describe("Content-free validation results or references linked to this work session."),
  unresolved_risks: z.array(NonEmptyStringSchema).default([]).describe("Known unresolved risks for this work session."),
  next_action: NonEmptyStringSchema.describe("Next concrete action ChatGPT should take for this work session."),
  warnings: z.array(z.string()).default([]).describe("Stable warning codes recorded on this work session.")
});

export const StartWorkSessionInputSchema = RepoInputSchema.extend({
  work_session_id: WorkSessionIdSchema.optional().describe("Optional caller-supplied work-session id. Omit to generate one from timestamp and title."),
  title: NonEmptyStringSchema.describe("Short human-readable work-session title."),
  objective: NonEmptyStringSchema.describe("Current implementation objective for this session."),
  constraints: z.array(NonEmptyStringSchema).optional().describe("Initial constraints or boundaries to preserve."),
  files_inspected: z.array(NonEmptyStringSchema).optional().describe("Initial repo-relative files already inspected."),
  touched_files: z.array(NonEmptyStringSchema).optional().describe("Initial repo-relative files touched or expected to be touched."),
  next_action: NonEmptyStringSchema.describe("Next concrete action ChatGPT should take."),
  dry_run: z.boolean().optional().describe("Validate and render session state without writing files.")
});

export const UpdateWorkSessionInputSchema = RepoInputSchema.extend({
  work_session_id: WorkSessionIdSchema.describe("Work-session id to update."),
  status: WorkSessionStatusSchema.optional().describe("Optional replacement work-session status."),
  next_action: NonEmptyStringSchema.optional().describe("Optional replacement next concrete action."),
  append_files_inspected: z.array(NonEmptyStringSchema).optional().describe("Repo-relative inspected files to append."),
  append_touched_files: z.array(NonEmptyStringSchema).optional().describe("Repo-relative touched files to append."),
  append_decisions: z.array(NonEmptyStringSchema).optional().describe("Content-free decisions to append."),
  append_assumptions: z.array(NonEmptyStringSchema).optional().describe("Content-free assumptions to append."),
  append_pending_patchsets: z.array(PendingPatchsetRefSchema).optional().describe("Patchset references to append."),
  append_validation_results: z.array(WorkSessionValidationResultSchema).optional().describe("Content-free validation result references to append."),
  append_unresolved_risks: z.array(NonEmptyStringSchema).optional().describe("Unresolved risks to append."),
  dry_run: z.boolean().optional().describe("Validate and render updated state without writing files.")
});

export const CurrentWorkSessionInputSchema = RepoInputSchema.extend({
  work_session_id: WorkSessionIdSchema.optional().describe("Optional explicit work-session id for historical inspection instead of current-pointer continuity lookup.")
});

export const WorkSessionLookupSourceSchema = z.enum(["current_pointer", "explicit_id"]);
export const WorkSessionContinuityStateSchema = z.enum(["active", "blocked", "completed_history"]);

export const WorkSessionMutationResultSchema = z.object({
  ok: z.literal(true).describe("True when work-session state was written or dry-run validation succeeded."),
  dry_run: z.boolean().describe("Whether the request only validated and rendered without writing files."),
  work_session_id: WorkSessionIdSchema.describe("Work-session id created or updated."),
  session_path: z.string().describe("Repo-relative session JSON path under .chatgpt/work-sessions."),
  current_path: z.literal(".chatgpt/work-sessions/current.json").describe("Repo-relative current work-session pointer path."),
  session: WorkSessionSchema.describe("Full content-free work-session state."),
  warnings: z.array(z.string()).describe("Stable non-fatal warnings from work-session handling."),
  next_tool_payloads: z.object({
    repo_current_work_session: CurrentWorkSessionInputSchema.describe("Suggested read-only payload to inspect this work session.")
  }).describe("Read-only next tool payloads for this work session.")
});

export const StartWorkSessionResultSchema = WorkSessionMutationResultSchema;
export const UpdateWorkSessionResultSchema = WorkSessionMutationResultSchema;

export const CurrentWorkSessionResultSchema = z.object({
  ok: z.literal(true).describe("True when current work-session lookup completed."),
  repo_id: z.string().describe("Repository id used for work-session lookup."),
  lookup_source: WorkSessionLookupSourceSchema.describe("Whether the lookup used the current pointer for continuity or an explicit id for historical inspection."),
  found: z.boolean().describe("Whether a valid work session was found."),
  continuity_state: WorkSessionContinuityStateSchema.optional().describe("Deterministic continuity meaning when found: active work, blocked ongoing work, or completed history."),
  work_session_id: WorkSessionIdSchema.optional().describe("Work-session id that was read when found."),
  session_path: z.string().optional().describe("Repo-relative session JSON path when found."),
  current_path: z.literal(".chatgpt/work-sessions/current.json").optional().describe("Repo-relative current pointer path when used."),
  session: WorkSessionSchema.optional().describe("Full content-free work-session state for active or blocked current continuity and explicit-id history; omitted for completed current-pointer continuity."),
  warnings: z.array(z.string()).describe("Stable non-fatal warnings from work-session lookup.")
});

export type WorkSession = z.infer<typeof WorkSessionSchema>;
export type StartWorkSessionInput = z.infer<typeof StartWorkSessionInputSchema>;
export type UpdateWorkSessionInput = z.infer<typeof UpdateWorkSessionInputSchema>;
export type CurrentWorkSessionInput = z.infer<typeof CurrentWorkSessionInputSchema>;
export type StartWorkSessionResult = z.infer<typeof StartWorkSessionResultSchema>;
export type UpdateWorkSessionResult = z.infer<typeof UpdateWorkSessionResultSchema>;
export type CurrentWorkSessionResult = z.infer<typeof CurrentWorkSessionResultSchema>;

function isRepoRelativePathLiteral(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
