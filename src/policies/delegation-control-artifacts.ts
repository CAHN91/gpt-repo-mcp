import { posix } from "node:path";

const AGENT_RUN_PREFIX = ".chatgpt/codex-runs/";

const INTERNAL_RUN_FILES = new Set([
  "runner.session.json",
  "runner.attempt.json",
  "runner.lock.json",
  "runner.lock.json.replace",
  "review.json",
  "review-gate.json"
]);

const INTERNAL_REPLY_PATTERN = /^interactions\/turn-[0-9]{4}\.reply\.json$/;

export function delegationControlArtifactGitExcludes(): string[] {
  return [
    ...[...INTERNAL_RUN_FILES].flatMap((file) => [
      `:(exclude,glob)${AGENT_RUN_PREFIX}*/${file}`,
      `:(exclude,glob)${AGENT_RUN_PREFIX}*/${file}.tmp-*`
    ]),
    `:(exclude,glob)${AGENT_RUN_PREFIX}*/interactions/turn-*.reply.json`
  ];
}

export function isDelegationControlArtifact(repoPath: string): boolean {
  const portablePath = repoPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = posix.normalize(portablePath).replace(/^\.\//, "").toLowerCase();
  if (!normalized.startsWith(AGENT_RUN_PREFIX)) return false;

  const relativeToRun = normalized.slice(AGENT_RUN_PREFIX.length).split("/").slice(1).join("/");
  return [...INTERNAL_RUN_FILES].some(
    (file) => relativeToRun === file || relativeToRun.startsWith(`${file}.tmp-`)
  ) || INTERNAL_REPLY_PATTERN.test(relativeToRun);
}
