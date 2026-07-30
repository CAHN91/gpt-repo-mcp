import { z } from "zod";
import { AgentRunnerRunIdSchema, AgentTurnAnswerSchema } from "../delegation/artifact-contracts.js";
import { RepoInputSchema } from "./repo.contract.js";
import { AgentRunsResultSchema } from "./agent-runs.contract.js";

export const AgentReplyInputSchema = RepoInputSchema.extend({
  run_id: AgentRunnerRunIdSchema,
  turn_index: z.number().int().min(1).max(32),
  expected_question_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  answers: z.array(AgentTurnAnswerSchema).min(1).max(3)
}).strict().superRefine((value, context) => {
  const ids = value.answers.map((answer) => answer.question_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["answers"], message: "Each question_id may be answered only once." });
  }
});

export const AgentReplyResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string(),
  run_id: AgentRunnerRunIdSchema,
  turn_index: z.number().int().min(1).max(32),
  written_path: z.string(),
  agent_run: AgentRunsResultSchema,
  next_tool_payloads: z.object({
    repo_agent_runs: z.object({ repo_id: z.string(), run_id: AgentRunnerRunIdSchema }).strict()
  }).strict(),
  warnings: z.array(z.string())
}).strict();

export type AgentReplyInput = z.infer<typeof AgentReplyInputSchema>;
export type AgentReplyResult = z.infer<typeof AgentReplyResultSchema>;
