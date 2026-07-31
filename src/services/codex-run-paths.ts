import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";
import { formatUtcCodexRunTimestamp, slugifyLabel } from "./local-id.js";
import { validateRepoPath } from "./path-sandbox.js";

export const CODEX_RUN_DIR = ".chatgpt/codex-runs";

export function codexRunPaths(runId: string) {
  const parsedRunId = AgentRunnerRunIdSchema.safeParse(runId);
  if (!parsedRunId.success) {
    throw new Error("Invalid Codex run id.");
  }
  const normalized = validateRepoPath(`${CODEX_RUN_DIR}/${parsedRunId.data}`);
  if (!normalized.startsWith(`${CODEX_RUN_DIR}/`) || normalized.split("/").length !== 3) {
    throw new Error("Invalid Codex run id.");
  }
  return {
    runDir: normalized,
    promptPath: `${normalized}/PROMPT.md`,
    resultPath: `${normalized}/RESULT.md`,
    resultJsonPath: `${normalized}/RESULT.json`,
    manifestPath: `${normalized}/run.json`,
    reviewPath: `${normalized}/review.json`,
    reviewGatePath: `${normalized}/review-gate.json`
  };
}

export function createCodexRunId(title: string, date: Date): string {
  return `${formatUtcCodexRunTimestamp(date)}-${slugifyLabel(title, "codex-task", 80)}`;
}
