import { OperationsPolicy } from "../../services/operations-policy.js";
import { PatchsetService } from "../../services/patchset-service.js";
import { PathSandbox } from "../../services/path-sandbox.js";
import { WritePolicy } from "../../services/write-policy.js";
import { createSuccessEnvelope } from "../../runtime/result-envelope.js";
import { audit } from "../../runtime/telemetry.js";
import type { PatchsetApplyInput, PatchsetPrepareInput, PatchsetReviewInput, PatchsetRollbackInput } from "../../contracts/patchset.contract.js";
import { assertExpectedHead, readHeadSha, safeTool, type ToolHandler } from "../handler-support.js";

export const preparePatchsetHandler: ToolHandler = async (input, context) => safeTool<PatchsetPrepareInput>("repo_prepare_patchset", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new PatchsetService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes)).prepare(args);
  audit({ tool: "repo_prepare_patchset", repo_id: args.repo_id, paths: result.affected_paths, counts: result.manifest.counts, warnings: result.warnings });
  return createSuccessEnvelope(result, `Prepared patchset ${result.patchset_id}.`, { warnings: result.warnings });
});

export const applyPatchsetHandler: ToolHandler = async (input, context) => safeTool<PatchsetApplyInput>("repo_apply_patchset", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const headShaBefore = await readHeadSha(repo.root);
  assertExpectedHead(args.expected_head_sha, headShaBefore);
  const result = await new PatchsetService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes)).apply(args);
  audit({ tool: "repo_apply_patchset", repo_id: args.repo_id, paths: result.changed_paths, counts: result.counts, warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked patchset ${result.patchset_id}.` : `Applied patchset ${result.patchset_id}.`, { warnings: result.warnings });
});

export const reviewPatchsetHandler: ToolHandler = async (input, context) => safeTool<PatchsetReviewInput>("repo_review_patchset", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new PatchsetService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes), new OperationsPolicy(repo.operations)).review(args);
  audit({ tool: "repo_review_patchset", repo_id: args.repo_id, paths: result.manifest.files.map((file) => file.path), warnings: result.warnings });
  return createSuccessEnvelope(result, `Reviewed patchset ${result.patchset_id}.`, { warnings: result.warnings });
});

export const rollbackPatchsetHandler: ToolHandler = async (input, context) => safeTool<PatchsetRollbackInput>("repo_rollback_patchset", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = await new PatchsetService(repo.root, new PathSandbox(repo.root), new WritePolicy(repo.writes), new OperationsPolicy(repo.operations)).rollback(args);
  audit({ tool: "repo_rollback_patchset", repo_id: args.repo_id, paths: [...result.restored_paths, ...result.deleted_paths], counts: result.counts, warnings: result.warnings });
  return createSuccessEnvelope(result, result.dry_run ? `Dry run checked rollback for patchset ${result.patchset_id}.` : `Rolled back patchset ${result.patchset_id}.`, { warnings: result.warnings });
});
