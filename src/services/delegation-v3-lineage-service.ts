import { readdir } from "node:fs/promises";
import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";
import { DelegationRunStore } from "../delegation/run-store.js";
import { readSafeRunArtifact } from "../delegation/safe-artifact.js";
import {
  DelegationLineageV3Schema,
  DelegationTaskV3ToolInputSchema,
  type DelegationLineageInputV3,
  type DelegationLineageV3,
  type DelegationProductBindingV3,
  type DelegationResultV3,
  type DelegationRunManifestV3,
  type DelegationTaskV3,
  type DelegationTaskV3Input,
  type DelegationTaskV3ToolInput,
  type DelegationTaskV3ToolOutput
} from "../contracts/delegation-v3.contract.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { parseCodexRunManifest } from "./codex-run-manifest.js";
import { GitService } from "./git-service.js";
import { matchesGlob } from "./glob-service.js";
import { evaluateCodexRunIntegrity } from "./codex-run-integrity.js";
import { codexRunPaths } from "./codex-run-paths.js";
import {
  delegationManifestSha256V3,
  normalizeDelegationTaskV3,
  normalizeDelegationTaskV3WithLineage,
  parseDelegationResultV3
} from "./delegation-v3-normalizer.js";
import type { PathSandbox } from "./path-sandbox.js";
import { hashCanonical } from "./product-contract-service.js";
import {
  assertCanonicalEqual,
  assertEqual,
  assertPreservedCriteria,
  assertPreservedStrings,
  childTitle,
  lineageError,
  patternCovers,
  productCorrectionAssignment,
  sameSet,
  unique
} from "./delegation-v3-lineage-rules.js";
import { sha256Text } from "./codex-task-policy.js";

export const MAX_DELEGATION_V3_CHILDREN = 2 as const;
const MAX_LINEAGE_SCAN_ENTRIES = 1_000 as const;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_PROMPT_BYTES = 512 * 1024;
const TERMINAL_RUNNER_STATUSES = new Set([
  "completed",
  "failed",
  "blocked_policy",
  "blocked_verification",
  "timed_out",
  "canceled",
  "committed"
]);
const lineageLocks = new Map<string, Promise<void>>();

type LineageReviewMetadata = {
  status: "not_applicable" | "eligible" | "limit_reached" | "blocked";
  parent_run_id: string | null;
  root_run_id: string | null;
  next_parent_run_id: string | null;
  children_created: number;
  max_children: 2;
  next_child_index: number | null;
  next_child_kind: "corrective" | "scope_amendment" | null;
  allowed_paths: string[];
  authorization_scope: string[];
  scope_extension_required: Array<{ path_or_area: string; reason: string; required_outcome: string }>;
  instructions: string[];
};

export type DelegationV3ProductReviewCorrection = {
  rationale: string;
  evidence: Array<{ criterion_id: string; verdict: "passed" | "failed"; evidence: string }>;
};

export type DelegationV3ReviewLoop = {
  metadata: LineageReviewMetadata;
  next_task_payload?: DelegationTaskV3ToolOutput;
};

export type ResolvedDelegationV3Child = {
  task: DelegationTaskV3;
  productBinding: DelegationProductBindingV3;
  reviewRequirement: "product_required" | "technical_only";
  governanceMode: "advisory" | "enforce";
  parent: DelegationRunManifestV3;
  root: DelegationRunManifestV3;
};

export class DelegationV3LineageService {
  private readonly git: GitService;
  constructor(
    private readonly rootPath: string,
    private readonly sandbox: PathSandbox
  ) {
    this.git = new GitService(rootPath);
  }

  async rootRunIdForParent(repoId: string, parentRunId: string): Promise<string> {
    const parent = await this.readManifest(repoId, parentRunId);
    return parent.task.lineage?.root_run_id ?? parent.run_id;
  }

  async resolveChild(
    input: DelegationTaskV3ToolInput,
    runId: string
  ): Promise<ResolvedDelegationV3Child> {
    const lineageInput = input.lineage;
    if (!lineageInput) throw lineageError("Delegation v3 child resolution requires lineage input.");
    if (runId === lineageInput.parent_run_id) throw lineageError("A child run id must differ from its parent run id.");
    await this.assertChildRunIdAvailable(runId);

    const parent = await this.readManifest(input.repo_id, lineageInput.parent_run_id);
    const rootRunId = parent.task.lineage?.root_run_id ?? parent.run_id;
    const root = rootRunId === parent.run_id
      ? parent
      : await this.readManifest(input.repo_id, rootRunId);
    if (runId === root.run_id) throw lineageError("A child run id must differ from its root run id.");

    await this.assertStoredLineageBinding(parent, root);
    await this.assertTerminalParent(parent);
    await this.assertNoUnauthorizedCurrentChanges(parent);
    const childrenCreated = await this.countChildren(root.run_id);
    if (childrenCreated >= MAX_DELEGATION_V3_CHILDREN) {
      throw lineageError("The shared Delegation v3 child-run limit has been reached.", {
        root_run_id: root.run_id,
        children_created: childrenCreated,
        max_children: MAX_DELEGATION_V3_CHILDREN
      });
    }

    const baseInput = { ...input };
    delete baseInput.lineage;
    const candidate = normalizeDelegationTaskV3({
      ...baseInput,
      run_id: runId
    } as DelegationTaskV3Input);
    this.assertInheritedRootContracts(root, candidate);
    this.assertParentPreservation(parent, candidate);

    const lineage = await this.resolveLineageBinding(
      lineageInput,
      parent,
      root,
      candidate,
      childrenCreated + 1
    );
    const task = normalizeDelegationTaskV3WithLineage(
      { ...input, run_id: runId } as DelegationTaskV3Input,
      lineage
    );

    return {
      task,
      productBinding: root.product_binding,
      reviewRequirement: root.review_requirement,
      governanceMode: root.delegation_audit.mode,
      parent,
      root
    };
  }

  async reviewLoop(
    repoId: string,
    manifest: DelegationRunManifestV3,
    result?: DelegationResultV3,
    productReviewCorrection?: DelegationV3ProductReviewCorrection
  ): Promise<DelegationV3ReviewLoop> {
    const rootRunId = manifest.task.lineage?.root_run_id ?? manifest.run_id;
    let root: DelegationRunManifestV3;
    try {
      root = rootRunId === manifest.run_id
        ? manifest
        : await this.readManifest(repoId, rootRunId);
      await this.assertStoredLineageBinding(manifest, root);
      await this.assertNoUnauthorizedCurrentChanges(manifest);
    } catch {
      return {
        metadata: {
          status: "blocked",
          parent_run_id: manifest.task.lineage?.parent_run_id ?? null,
          root_run_id: rootRunId,
          next_parent_run_id: null,
          children_created: 0,
          max_children: MAX_DELEGATION_V3_CHILDREN,
          next_child_index: null,
          next_child_kind: null,
          allowed_paths: [],
          authorization_scope: [...manifest.authorization.effective_scope],
          scope_extension_required: result?.scope_extension_required ?? [],
          instructions: ["Lineage child creation is blocked because the parent/root prompt-manifest chain could not be verified."]
        }
      };
    }
    const childrenCreated = await this.countChildren(root.run_id);
    const baseMetadata = {
      parent_run_id: manifest.task.lineage?.parent_run_id ?? null,
      root_run_id: root.run_id,
      next_parent_run_id: manifest.run_id,
      children_created: childrenCreated,
      max_children: MAX_DELEGATION_V3_CHILDREN,
      allowed_paths: [] as string[],
      authorization_scope: [...manifest.authorization.effective_scope],
      scope_extension_required: result?.scope_extension_required ?? [],
      instructions: [
        "Create lineage children only through the review-provided repo_write_codex_task payload.",
        "Corrective children preserve or narrow authorization; scope amendments add only parent-result evidence.",
        "Root product/outcome contracts, PACs, hard constraints, preservation rules, exclusions, and forbidden paths cannot be weakened.",
        "Corrective and scope-amendment children share a maximum of two descendants per root run."
      ]
    };

    if (!result) {
      return {
        metadata: {
          status: "blocked",
          ...baseMetadata,
          next_child_index: null,
          next_child_kind: null
        }
      };
    }
    if (childrenCreated >= MAX_DELEGATION_V3_CHILDREN) {
      return {
        metadata: {
          status: "limit_reached",
          ...baseMetadata,
          next_child_index: null,
          next_child_kind: null
        }
      };
    }

    const correctiveNeeded = Boolean(productReviewCorrection)
      || result.status === "blocked"
      || result.product_acceptance_criteria.some(({ status }) => status !== "passed")
      || result.technical_acceptance_criteria.some(({ status }) => status !== "passed");
    if (result.scope_extension_required.length === 0 && !correctiveNeeded) {
      return {
        metadata: {
          status: "not_applicable",
          ...baseMetadata,
          next_child_index: null,
          next_child_kind: null
        }
      };
    }

    const childIndex = childrenCreated + 1;
    const kind = result.scope_extension_required.length > 0 ? "scope_amendment" : "corrective";
    const payload = this.buildNextTaskPayload(root, manifest, result, kind, childIndex, productReviewCorrection);
    return {
      metadata: {
        status: "eligible",
        ...baseMetadata,
        next_child_index: childIndex,
        next_child_kind: kind
      },
      next_task_payload: payload
    };
  }

  private async resolveLineageBinding(
    input: DelegationLineageInputV3,
    parent: DelegationRunManifestV3,
    root: DelegationRunManifestV3,
    candidate: DelegationTaskV3,
    childIndex: number
  ): Promise<DelegationLineageV3> {
    const shared = {
      parent_run_id: parent.run_id,
      root_run_id: root.run_id,
      child_index: childIndex,
      max_children: MAX_DELEGATION_V3_CHILDREN,
      reason: input.reason.trim(),
      parent_manifest_sha256: delegationManifestSha256V3(parent),
      root_manifest_sha256: delegationManifestSha256V3(root)
    };

    if (input.kind === "corrective") {
      const invalid = candidate.authorization_scope.filter((pattern) =>
        !parent.authorization.effective_scope.some((parentPattern) => patternCovers(parentPattern, pattern))
      );
      if (invalid.length > 0) {
        throw lineageError("Corrective child authorization must preserve or narrow the parent effective authorization.", {
          paths: invalid
        });
      }
      return DelegationLineageV3Schema.parse({ kind: "corrective", ...shared });
    }

    const parentResult = await this.readResult(parent);
    if (!parentResult || parentResult.result.status !== "blocked" || parentResult.result.scope_extension_required.length === 0) {
      throw lineageError("Scope-amendment children require a blocked parent RESULT.json with structured scope-extension evidence.");
    }
    const requested = [...input.authorization_additions];
    const approvedEntries = requested.map((addition) => {
      const evidence = parentResult.result.scope_extension_required.find(({ path_or_area }) => path_or_area === addition);
      if (!evidence) {
        throw lineageError("Scope-amendment authorization additions must exactly match parent RESULT.json evidence.", {
          paths: [addition]
        });
      }
      return evidence;
    });
    const expectedScope = unique([...parent.authorization.effective_scope, ...requested]);
    if (!sameSet(candidate.authorization_scope, expectedScope)) {
      throw lineageError("Scope-amendment authorization must equal the parent effective scope plus the approved additions.", {
        expected_authorization_scope: expectedScope,
        requested_authorization_scope: candidate.authorization_scope
      });
    }
    return DelegationLineageV3Schema.parse({
      kind: "scope_amendment",
      ...shared,
      authorization_additions: requested,
      evidence: {
        source: "parent_result",
        parent_result_sha256: sha256Text(parentResult.text),
        scope_extension_required: approvedEntries
      }
    });
  }

  private assertInheritedRootContracts(root: DelegationRunManifestV3, child: DelegationTaskV3): void {
    const rootTask = root.task;
    assertEqual(child.repo_id, rootTask.repo_id, "Child repo_id must match the root run.");
    assertEqual(child.task_kind, rootTask.task_kind, "Child task_kind must match the root run.");
    assertCanonicalEqual(child.outcome, rootTask.outcome, "Child outcome frame must match the root run.");
    assertCanonicalEqual(child.relevant_context ?? null, rootTask.relevant_context ?? null, "Child relevant context must match the root run.");
    assertPreservedStrings(rootTask.hard_constraints, child.hard_constraints, "hard constraints");
    assertPreservedStrings(rootTask.must_preserve, child.must_preserve, "must-preserve rules");
    assertPreservedStrings(rootTask.explicit_exclusions, child.explicit_exclusions, "explicit exclusions");
    assertPreservedCriteria(rootTask.technical_acceptance_criteria, child.technical_acceptance_criteria, "TACs");

    if ("product_alignment" in rootTask) {
      if (!("product_alignment" in child)) throw lineageError("Product lineage children must retain product alignment.");
      assertEqual(child.product_alignment.primary_user_id, rootTask.product_alignment.primary_user_id, "Child product user must match the root run.");
      assertCanonicalEqual(child.product_alignment.job_ids, rootTask.product_alignment.job_ids, "Child product jobs must match the root run.");
      assertEqual(child.product_alignment.user_problem, rootTask.product_alignment.user_problem, "Child user problem must match the root run.");
      assertEqual(child.product_alignment.product_goal, rootTask.product_alignment.product_goal, "Child product goal must match the root run.");
      assertPreservedStrings(
        rootTask.product_alignment.additional_must_not_become,
        child.product_alignment.additional_must_not_become,
        "product must-not-become rules"
      );
      assertPreservedCriteria(
        rootTask.product_alignment.product_acceptance_criteria,
        child.product_alignment.product_acceptance_criteria,
        "PACs"
      );
    } else if ("technical_context" in rootTask) {
      if (!("technical_context" in child)) throw lineageError("Technical lineage children must retain technical context.");
      assertCanonicalEqual(child.technical_context, rootTask.technical_context, "Child technical context must match the root run.");
    } else {
      if (!("security_context" in rootTask) || !("security_context" in child)) {
        throw lineageError("Security lineage children must retain security context.");
      }
      assertCanonicalEqual(child.security_context, rootTask.security_context, "Child security context must match the root run.");
    }
  }

  private assertParentPreservation(parent: DelegationRunManifestV3, child: DelegationTaskV3): void {
    assertPreservedStrings(parent.task.forbidden_paths, child.forbidden_paths, "parent forbidden paths");
    assertPreservedStrings(parent.task.hard_constraints, child.hard_constraints, "parent hard constraints");
    assertPreservedStrings(parent.task.must_preserve, child.must_preserve, "parent must-preserve rules");
    assertPreservedStrings(parent.task.explicit_exclusions, child.explicit_exclusions, "parent explicit exclusions");
    assertPreservedCriteria(parent.task.technical_acceptance_criteria, child.technical_acceptance_criteria, "parent TACs");
    if ("product_alignment" in parent.task) {
      if (!("product_alignment" in child)) throw lineageError("Product lineage children must retain parent PACs.");
      assertPreservedCriteria(
        parent.task.product_alignment.product_acceptance_criteria,
        child.product_alignment.product_acceptance_criteria,
        "parent PACs"
      );
    }
  }

  private async assertStoredLineageBinding(
    manifest: DelegationRunManifestV3,
    root: DelegationRunManifestV3
  ): Promise<void> {
    await this.assertRunIntegrity(root);
    if (manifest.run_id !== root.run_id) await this.assertRunIntegrity(manifest);
    if (!manifest.task.lineage) {
      if (manifest.run_id !== root.run_id) throw lineageError("Root lineage identity is inconsistent.");
      return;
    }
    const lineage = manifest.task.lineage;
    if (lineage.root_run_id !== root.run_id || lineage.root_manifest_sha256 !== delegationManifestSha256V3(root)) {
      throw lineageError("Stored child lineage does not match the root manifest binding.");
    }
    if (manifest.product_binding.kind !== root.product_binding.kind
      || hashCanonical(manifest.product_binding) !== hashCanonical(root.product_binding)
      || manifest.review_requirement !== root.review_requirement) {
      throw lineageError("Stored child lineage changed the root product binding or review requirement.");
    }
    this.assertInheritedRootContracts(root, manifest.task);
    const parent = await this.readManifest(manifest.repo_id, lineage.parent_run_id);
    await this.assertRunIntegrity(parent);
    this.assertParentPreservation(parent, manifest.task);
    if (lineage.parent_manifest_sha256 !== delegationManifestSha256V3(parent)) {
      throw lineageError("Stored child lineage does not match the immediate parent manifest binding.");
    }
    if (lineage.kind === "scope_amendment") {
      const parentResult = await this.readResult(parent);
      if (!parentResult || lineage.evidence.parent_result_sha256 !== sha256Text(parentResult.text)) {
        throw lineageError("Stored scope-amendment lineage does not match the parent RESULT.json binding.");
      }
      const storedEvidence = lineage.evidence.scope_extension_required;
      for (const addition of lineage.authorization_additions) {
        const stored = storedEvidence.find(({ path_or_area }) => path_or_area === addition);
        const actual = parentResult.result.scope_extension_required.find(({ path_or_area }) => path_or_area === addition);
        if (!stored || !actual || hashCanonical(stored) !== hashCanonical(actual)) {
          throw lineageError("Stored scope-amendment evidence no longer matches the parent RESULT.json.", {
            paths: [addition]
          });
        }
      }
    }
  }

  private async assertRunIntegrity(manifest: DelegationRunManifestV3): Promise<void> {
    const prompt = await readSafeRunArtifact(this.rootPath, manifest.prompt_path, MAX_PROMPT_BYTES).catch(() => undefined);
    const paths = codexRunPaths(manifest.run_id);
    const evaluated = evaluateCodexRunIntegrity(manifest, prompt, paths);
    if (!evaluated.integrity.manifest_bound) {
      throw lineageError("Delegation v3 lineage requires a verified prompt-manifest binding.", {
        warnings: evaluated.warnings
      });
    }
  }

  private async assertNoUnauthorizedCurrentChanges(parent: DelegationRunManifestV3): Promise<void> {
    const status = await this.git.status();
    if (status.head_sha !== parent.baseline.head_sha) {
      throw lineageError("Delegation v3 child creation requires the parent baseline HEAD to remain current.", {
        expected_head_sha: parent.baseline.head_sha,
        actual_head_sha: status.head_sha
      });
    }
    const preExisting = new Set(parent.baseline.initial_changed_paths);
    const newlyObserved = [...new Set(status.files
      .flatMap(({ original_path, path }) => [original_path, path])
      .filter((path): path is string => typeof path === "string")
      .filter((path) => !path.startsWith(".chatgpt/"))
      .filter((path) => !preExisting.has(path)))];
    const unauthorized = newlyObserved.filter((path) =>
      !parent.authorization.effective_scope.some((pattern) => matchesGlob(path, pattern))
      || parent.authorization.effective_forbidden_paths.some((pattern) => matchesGlob(path, pattern))
    );
    if (unauthorized.length > 0) {
      throw lineageError("Delegation v3 child creation cannot baseline-launder unauthorized parent changes.", {
        paths: unauthorized
      });
    }
  }

  private async assertChildRunIdAvailable(runId: string): Promise<void> {
    const paths = codexRunPaths(runId);
    const existing = await Promise.all([
      readSafeRunArtifact(this.rootPath, paths.promptPath, MAX_PROMPT_BYTES),
      readSafeRunArtifact(this.rootPath, paths.manifestPath, MAX_MANIFEST_BYTES),
      readSafeRunArtifact(this.rootPath, paths.resultJsonPath, MAX_RESULT_BYTES),
      readSafeRunArtifact(this.rootPath, paths.resultPath, MAX_RESULT_BYTES)
    ]);
    if (existing.some((value) => value !== undefined)) {
      throw lineageError("Delegation v3 child run id already has persisted artifacts and cannot be reused.", {
        run_id: runId
      });
    }
  }

  private async assertTerminalParent(parent: DelegationRunManifestV3): Promise<void> {
    if (await this.readResult(parent)) return;
    const status = await new DelegationRunStore(this.rootPath).readStatus(parent.run_id).catch(() => undefined);
    if (
      status
      && status.repo_id === parent.repo_id
      && status.run_id === parent.run_id
      && status.manifest_version === 3
      && status.prompt_path === parent.prompt_path
      && status.result_json_path === parent.result_json_path
      && TERMINAL_RUNNER_STATUSES.has(status.status)
    ) {
      return;
    }
    throw lineageError("Delegation v3 children require a terminal parent run or a valid parent RESULT.json.");
  }

  private async readManifest(repoId: string, runId: string): Promise<DelegationRunManifestV3> {
    if (!AgentRunnerRunIdSchema.safeParse(runId).success) throw lineageError("Invalid Delegation v3 run id.");
    const path = codexRunPaths(runId).manifestPath;
    let text: string | undefined;
    try {
      const resolved = await this.sandbox.resolve(path);
      if (!resolved.stat.isFile() || resolved.stat.isSymbolicLink()) {
        throw lineageError("Delegation v3 parent manifest is unavailable or unsafe.");
      }
      text = await readSafeRunArtifact(this.rootPath, path, MAX_MANIFEST_BYTES);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw lineageError("Delegation v3 parent manifest is unavailable.", { parent_run_id: runId });
      }
      throw error;
    }
    if (!text) throw lineageError("Delegation v3 parent manifest is unavailable.", { parent_run_id: runId });
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw lineageError("Delegation v3 parent manifest contains invalid JSON.");
    }
    const manifest = parseCodexRunManifest(value);
    if (manifest.schema_version !== 3 || manifest.repo_id !== repoId) {
      throw lineageError("Delegation v3 children require a matching schema-version 3 parent run.");
    }
    return manifest;
  }

  private async readResult(
    manifest: DelegationRunManifestV3
  ): Promise<{ result: DelegationResultV3; text: string } | undefined> {
    const text = await readSafeRunArtifact(this.rootPath, manifest.result_json_path, MAX_RESULT_BYTES).catch(() => undefined);
    if (!text) return undefined;
    return {
      result: parseDelegationResultV3(text, manifest.repo_id, manifest.run_id),
      text
    };
  }

  private async countChildren(rootRunId: string): Promise<number> {
    const runsDir = `${this.rootPath}/.chatgpt/codex-runs`;
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    if (entries.length > MAX_LINEAGE_SCAN_ENTRIES) return MAX_DELEGATION_V3_CHILDREN;
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !AgentRunnerRunIdSchema.safeParse(entry.name).success) continue;
      try {
        const text = await readSafeRunArtifact(this.rootPath, codexRunPaths(entry.name).manifestPath, MAX_MANIFEST_BYTES);
        if (!text) continue;
        const manifest = parseCodexRunManifest(JSON.parse(text) as unknown);
        if (manifest.schema_version === 3 && manifest.task.lineage?.root_run_id === rootRunId) count += 1;
      } catch {
        // Malformed unrelated run artifacts do not weaken the bounded lineage count.
      }
    }
    return count;
  }

  private buildNextTaskPayload(
    root: DelegationRunManifestV3,
    parent: DelegationRunManifestV3,
    result: DelegationResultV3,
    kind: "corrective" | "scope_amendment",
    childIndex: number,
    productReviewCorrection?: DelegationV3ProductReviewCorrection
  ): DelegationTaskV3ToolOutput {
    const additions = kind === "scope_amendment"
      ? result.scope_extension_required.map(({ path_or_area }) => path_or_area)
      : [];
    const authorizationScope = kind === "scope_amendment"
      ? unique([...parent.authorization.effective_scope, ...additions])
      : [...parent.authorization.effective_scope];
    const lineage: DelegationLineageInputV3 = kind === "scope_amendment"
      ? {
          kind,
          parent_run_id: parent.run_id,
          reason: `Complete the inherited outcome using only the structured scope additions reported by parent run ${parent.run_id}.`,
          authorization_additions: additions
        }
      : {
          kind,
          parent_run_id: parent.run_id,
          reason: `Correct and complete parent run ${parent.run_id} without weakening the inherited root contracts.`
        };
    const parentTask = parent.task;
    const rootTask = root.task;
    const common = {
      repo_id: root.repo_id,
      title: childTitle(root.title, kind, childIndex),
      task_kind: rootTask.task_kind,
      assignment: kind === "scope_amendment"
        ? "Complete the parent implementation using only the approved scope additions while preserving every inherited product, outcome, safety, and acceptance contract."
        : productReviewCorrection
          ? productCorrectionAssignment(productReviewCorrection)
          : "Correct and complete the parent implementation within the inherited authorization while preserving every inherited product, outcome, safety, and acceptance contract.",
      outcome: rootTask.outcome,
      ...(rootTask.relevant_context ? { relevant_context: rootTask.relevant_context } : {}),
      starting_points: kind === "scope_amendment" ? additions : parentTask.starting_points,
      authorization_scope: authorizationScope,
      forbidden_paths: parentTask.forbidden_paths,
      hard_constraints: parentTask.hard_constraints,
      must_preserve: parentTask.must_preserve,
      explicit_exclusions: parentTask.explicit_exclusions,
      technical_acceptance_criteria: parentTask.technical_acceptance_criteria,
      ...(parentTask.validation ? { validation: parentTask.validation } : {}),
      runner: parentTask.runner,
      lineage
    };

    if ("product_alignment" in parentTask) {
      return DelegationTaskV3ToolInputSchema.parse({
        ...common,
        product_alignment: parentTask.product_alignment
      });
    }
    if ("technical_context" in parentTask) {
      return DelegationTaskV3ToolInputSchema.parse({
        ...common,
        technical_context: parentTask.technical_context
      });
    }
    if ("security_context" in parentTask) {
      return DelegationTaskV3ToolInputSchema.parse({
        ...common,
        security_context: parentTask.security_context
      });
    }
    throw lineageError("Unable to construct a kind-specific Delegation v3 child payload.");
  }
}

export async function withDelegationV3LineageLock<T>(
  rootPath: string,
  rootRunId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${rootPath}\0${rootRunId}`;
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
