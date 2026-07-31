import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";
import { DelegationRunStore } from "../delegation/run-store.js";
import { RepoReaderError } from "../runtime/errors.js";
import { readSafeRunArtifact } from "../delegation/safe-artifact.js";
import { parseCodexRunManifest, type CodexRunManifest, type CodexRunManifestV2 } from "./codex-run-manifest.js";
import type { PathSandbox } from "./path-sandbox.js";
import { parseLegacyCodexResult, parseStructuredCodexResult } from "./codex-result-parser.js";
import type {
  DelegationResultV3,
  DelegationTaskV3ToolOutput
} from "../contracts/delegation-v3.contract.js";
import {
  DelegationV3LineageService,
  type DelegationV3ProductReviewCorrection
} from "./delegation-v3-lineage-service.js";

export const MAX_CORRECTIVE_CHILDREN = 2 as const;
const MAX_CORRECTIVE_SCAN_ENTRIES = 1_000 as const;
const MAX_RESULT_BYTES = 128_000 as const;
const TERMINAL_RUNNER_STATUSES = new Set([
  "completed", "failed", "blocked_policy", "blocked_verification", "timed_out", "canceled", "committed"
]);
const lineageLocks = new Map<string, Promise<void>>();

export type ReviewLoopMetadata = {
  status: "not_applicable" | "eligible" | "limit_reached" | "blocked";
  parent_run_id: string | null;
  root_run_id: string | null;
  children_created: number;
  max_children: 2;
  next_child_index: number | null;
  allowed_paths: string[];
  instructions: string[];
  next_parent_run_id?: string | null;
  next_child_kind?: "corrective" | "scope_amendment" | null;
  authorization_scope?: string[];
  scope_extension_required?: Array<{ path_or_area: string; reason: string; required_outcome: string }>;
};

export type ReviewLoopContextResult = {
  metadata: ReviewLoopMetadata;
  next_task_payload?: DelegationTaskV3ToolOutput;
};

export type CodexCorrectiveLineage = {
  kind: "corrective";
  parent_run_id: string;
  root_run_id: string;
  child_index: number;
  max_children: 2;
};

export async function resolveCorrectiveLineage(
  root: string,
  sandbox: PathSandbox,
  repoId: string,
  parentRunId: string
): Promise<{ lineage: CodexCorrectiveLineage; parent: CodexRunManifestV2; children_created: number }> {
  const parent = await readV2Manifest(root, sandbox, repoId, parentRunId);
  await assertTerminalParent(root, repoId, parent);
  if (parent.lineage) {
    throw lineageError("Corrective children may only be created from the baseline parent run.");
  }
  const childrenCreated = await countChildren(root, parentRunId);
  if (childrenCreated >= MAX_CORRECTIVE_CHILDREN) {
    throw lineageError("The corrective child-run limit has been reached.");
  }
  const rootRunId = parent.run_id;
  return {
    parent,
    children_created: childrenCreated,
    lineage: {
      kind: "corrective",
      parent_run_id: parent.run_id,
      root_run_id: rootRunId,
      child_index: childrenCreated + 1,
      max_children: MAX_CORRECTIVE_CHILDREN
    }
  };
}

export async function withCorrectiveLineageLock<T>(
  root: string,
  parentRunId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${root}\0${parentRunId}`;
  const previous = lineageLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  lineageLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lineageLocks.get(key) === queued) lineageLocks.delete(key);
  }
}

export function assertCorrectiveScope(
  parent: CodexRunManifestV2,
  allowedPaths: readonly string[]
): void {
  const invalidAllowed = allowedPaths.filter((child) => !parent.allowed_paths.some((parentPattern) => patternCovers(parentPattern, child)));
  if (invalidAllowed.length > 0) {
    throw lineageError("Corrective child scope must preserve or narrow the parent allowed paths.", { paths: invalidAllowed });
  }
}

export async function reviewLoopMetadata(
  root: string | undefined,
  repoId: string,
  manifest: CodexRunManifest | undefined
): Promise<ReviewLoopMetadata> {
  const instructions = [
    "Use repo_codex_review for the terminal result and repo_ship_review for bounded ship readiness.",
    "A corrective child must capture a fresh baseline and preserve or narrow the parent scope.",
    "At most two corrective children may be created from the baseline parent."
  ];
  if (!manifest || manifest.schema_version !== 2) {
    return {
      status: "not_applicable", parent_run_id: null, root_run_id: null, children_created: 0,
      max_children: MAX_CORRECTIVE_CHILDREN, next_child_index: null, allowed_paths: [], instructions
    };
  }
  const rootRunId = manifest.lineage?.root_run_id ?? manifest.run_id;
  const parentRunId = manifest.lineage?.parent_run_id ?? null;
  const parentForChildren = manifest.lineage ? parentRunId : manifest.run_id;
  const childrenCreated = root && parentForChildren
    ? await countChildren(root, parentForChildren)
    : 0;
  const parentTerminal = root && !manifest.lineage
    ? await terminalParentAvailable(root, repoId, manifest)
    : false;
  const eligible = !manifest.lineage && parentTerminal && childrenCreated < MAX_CORRECTIVE_CHILDREN;
  return {
    status: eligible ? "eligible" : manifest.lineage || !parentTerminal ? "blocked" : "limit_reached",
    parent_run_id: parentRunId,
    root_run_id: rootRunId,
    children_created: childrenCreated,
    max_children: MAX_CORRECTIVE_CHILDREN,
    next_child_index: eligible ? childrenCreated + 1 : null,
    allowed_paths: manifest.allowed_paths.slice(0, 100),
    instructions
  };
}

export async function reviewLoopContext(
  root: string | undefined,
  sandbox: PathSandbox,
  repoId: string,
  manifest: CodexRunManifest | undefined,
  result?: DelegationResultV3,
  productReviewCorrection?: DelegationV3ProductReviewCorrection
): Promise<ReviewLoopContextResult> {
  if (manifest?.schema_version === 3) {
    if (!root) {
      return {
        metadata: {
          status: "blocked" as const,
          parent_run_id: manifest.task.lineage?.parent_run_id ?? null,
          root_run_id: manifest.task.lineage?.root_run_id ?? manifest.run_id,
          next_parent_run_id: null,
          children_created: 0,
          max_children: MAX_CORRECTIVE_CHILDREN,
          next_child_index: null,
          next_child_kind: null,
          allowed_paths: [],
          authorization_scope: manifest.authorization.effective_scope,
          scope_extension_required: result?.scope_extension_required ?? [],
          instructions: ["Delegation v3 lineage requires repository-root access for bounded parent/root verification."]
        }
      };
    }
    return new DelegationV3LineageService(root, sandbox).reviewLoop(repoId, manifest, result, productReviewCorrection);
  }
  return {
    metadata: await reviewLoopMetadata(root, repoId, manifest)
  };
}

async function readV2Manifest(
  root: string,
  sandbox: PathSandbox,
  repoId: string,
  runId: string
): Promise<CodexRunManifestV2> {
  if (!AgentRunnerRunIdSchema.safeParse(runId).success) throw lineageError("Invalid parent run id.");
  const path = manifestPath(runId);
  const resolved = await sandbox.resolve(path);
  if (!resolved.stat.isFile() || resolved.stat.isSymbolicLink()) throw lineageError("Parent run manifest is unavailable.");
  const manifest = parseCodexRunManifest(JSON.parse(await readSafeRunArtifact(root, path, 512 * 1024) ?? ""));
  if (manifest.schema_version !== 2 || manifest.repo_id !== repoId) throw lineageError("Corrective children require a matching v2 parent run.");
  return manifest;
}

async function assertTerminalParent(root: string, repoId: string, parent: CodexRunManifestV2): Promise<void> {
  if (await terminalParentAvailable(root, repoId, parent)) return;
  throw lineageError("Corrective children require a terminal parent run or a valid terminal parent result.");
}

async function terminalParentAvailable(root: string, repoId: string, parent: CodexRunManifestV2): Promise<boolean> {
  const status = await new DelegationRunStore(root).readStatus(parent.run_id).catch(() => undefined);
  if (
    status
    && status.repo_id === repoId
    && status.run_id === parent.run_id
    && status.manifest_version === 2
    && status.prompt_path === parent.prompt_path
    && status.legacy_result_path === parent.result_path
    && status.result_json_path === parent.result_json_path
    && TERMINAL_RUNNER_STATUSES.has(status.status)
  ) {
    return true;
  }

  const structured = await readSafeRunArtifact(root, parent.result_json_path, MAX_RESULT_BYTES).catch(() => undefined);
  if (structured !== undefined) {
    try {
      parseStructuredCodexResult(structured, repoId, parent.run_id);
      return true;
    } catch {
      return false;
    }
  }
  const legacy = await readSafeRunArtifact(root, parent.result_path, MAX_RESULT_BYTES).catch(() => undefined);
  return legacy !== undefined && parseLegacyCodexResult(legacy).status !== "unknown";
}

async function countChildren(root: string, parentRunId: string): Promise<number> {
  const runsDir = join(root, ".chatgpt", "codex-runs");
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  if (entries.length > MAX_CORRECTIVE_SCAN_ENTRIES) return MAX_CORRECTIVE_CHILDREN;
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !AgentRunnerRunIdSchema.safeParse(entry.name).success) continue;
    try {
      const raw = await readSafeRunArtifact(root, manifestPath(entry.name), 512 * 1024);
      if (!raw) continue;
      const manifest = parseCodexRunManifest(JSON.parse(raw));
      if (manifest.schema_version === 2 && manifest.lineage?.parent_run_id === parentRunId) count += 1;
    } catch {
      // Malformed unrelated artifacts must not change the bounded child count.
    }
  }
  return count;
}

function patternCovers(parentPattern: string, childPattern: string): boolean {
  if (parentPattern === childPattern) return true;
  if (parentPattern.endsWith("/**")) {
    const prefix = parentPattern.slice(0, -3).replace(/\/$/, "");
    return childPattern.startsWith(`${prefix}/`);
  }
  return false;
}

function manifestPath(runId: string): string {
  return `.chatgpt/codex-runs/${runId}/run.json`;
}

function lineageError(message: string, diagnostics: Record<string, unknown> = {}): RepoReaderError {
  return new RepoReaderError("RUNNER_POLICY_BLOCKED", message, { diagnostics });
}
