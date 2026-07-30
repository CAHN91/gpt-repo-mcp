import { z } from "zod";
import {
  CodexRepoPathSchema,
  CodexRepoPatternSchema,
  CodexTaskRunnerSchema,
  CodexValidationRequestSchema
} from "../../contracts/codex-task.contract.js";

const AcceptanceCriterionSchema = z.object({
  id: z.string().regex(/^AC-[1-9][0-9]*$/),
  criterion: z.string().min(1).max(500)
}).strict();

const BaselineSchema = z.object({
  head_sha: z.string().min(1),
  worktree_fingerprint: z.string().min(1),
  initial_changed_paths: z.array(CodexRepoPathSchema).max(10_000)
}).strict();

export const CodexCorrectiveLineageSchema = z.object({
  kind: z.literal("corrective"),
  parent_run_id: z.string().min(1),
  root_run_id: z.string().min(1),
  child_index: z.number().int().min(1).max(2),
  max_children: z.literal(2)
}).strict();

export const CodexRunManifestV2Schema = z.object({
  schema_version: z.literal(2),
  repo_id: z.string().min(1),
  run_id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  context_summary: z.string().optional(),
  prompt_path: CodexRepoPatternSchema,
  result_path: CodexRepoPatternSchema,
  result_json_path: CodexRepoPatternSchema,
  manifest_path: CodexRepoPatternSchema,
  inspect_first: z.array(CodexRepoPatternSchema),
  allowed_paths: z.array(CodexRepoPatternSchema),
  caller_forbidden_paths: z.array(CodexRepoPatternSchema),
  effective_forbidden_paths: z.array(CodexRepoPatternSchema),
  implementation_scope: z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string())
  }).strict().optional(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema),
  lineage: CodexCorrectiveLineageSchema.optional(),
  validation: CodexValidationRequestSchema.optional(),
  runner: CodexTaskRunnerSchema.optional(),
  verification_commands: z.array(z.string()),
  baseline: BaselineSchema,
  baseline_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_byte_count: z.number().int().nonnegative(),
  created_at: z.string().nullable()
}).strict();

export type CodexRunManifestV2 = z.infer<typeof CodexRunManifestV2Schema>;
