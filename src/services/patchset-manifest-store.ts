import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PatchsetManifestSchema,
  PatchsetPrepareInputSchema,
  type PatchsetManifest,
  type PatchsetPrepareInput
} from "../contracts/patchset.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { atomicWriteJson } from "../runtime/fs-helpers.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import { validateRepoPath } from "./path-sandbox.js";
import { WritePolicy } from "./write-policy.js";

export type PatchsetManifestRecord = {
  args: PatchsetPrepareInput;
  patchset_id: string;
  manifest_path: string;
  manifest: PatchsetManifest;
  affected_paths: string[];
};

export class PatchsetManifestStore {
  constructor(
    private readonly root: string,
    private readonly writePolicy: WritePolicy
  ) {}

  async prepare(input: PatchsetPrepareInput): Promise<PatchsetManifestRecord> {
    const args = PatchsetPrepareInputSchema.parse(input);
    assertSafeIntent(args.intent);
    const files = args.files.map((file) => {
      const path = validateRepoPath(file.path);
      if (file.operation === "create" || file.operation === "modify") {
        this.writePolicy.assertAllowed({ path, bytes: Buffer.byteLength(file.content, "utf8"), action: "write" });
        return {
          ...file,
          path,
          new_sha256: sha256(file.content)
        };
      }
      this.writePolicy.assertAllowed({ path, bytes: 0, action: "write" });
      if (file.operation === "rename") {
        const newPath = validateRepoPath(file.new_path);
        this.writePolicy.assertAllowed({ path: newPath, bytes: 0, action: "write" });
        return { ...file, path, new_path: newPath };
      }
      if (file.operation === "edit") {
        return { ...file, path, hunk_count: file.hunks.length };
      }
      return { ...file, path };
    });
    const affected_paths = patchsetAffectedPaths(files);
    assertUniquePaths(affected_paths);

    const patchset_id = createPatchsetId();
    const manifest_path = patchsetManifestPath(patchset_id);
    const manifest: PatchsetManifest = PatchsetManifestSchema.parse({
      patchset_schema_version: 1,
      patchset_id,
      repo_id: args.repo_id,
      created_at: new Date().toISOString(),
      intent: args.intent,
      ...(args.base_head_sha ? { base_head_sha: args.base_head_sha } : {}),
      ...(args.work_session_id ? { work_session_id: args.work_session_id } : {}),
      files,
      counts: {
        files: files.length,
        creates: files.filter((file) => file.operation === "create").length,
        modifies: files.filter((file) => file.operation === "modify").length,
        deletes: files.filter((file) => file.operation === "delete").length,
        renames: files.filter((file) => file.operation === "rename").length,
        edits: files.filter((file) => file.operation === "edit").length
      }
    });

    await atomicWriteJson(join(this.root, manifest_path), manifest);

    return {
      args,
      patchset_id,
      manifest_path,
      manifest,
      affected_paths
    };
  }

  async read(patchsetId: string): Promise<{ manifest: PatchsetManifest; manifest_path: string }> {
    const manifest_path = patchsetManifestPath(patchsetId);
    const manifest = PatchsetManifestSchema.parse(JSON.parse(await readFile(join(this.root, manifest_path), "utf8")));
    return { manifest, manifest_path };
  }
}

export function patchsetAffectedPaths(files: PatchsetManifest["files"] | PatchsetPrepareInput["files"]): string[] {
  return files.flatMap((file) => file.operation === "rename" ? [file.path, file.new_path] : [file.path]);
}

function assertSafeIntent(intent: string): void {
  if (redactSensitiveText(intent) !== intent) {
    throw new RepoReaderError("VALIDATION_ERROR", "Patchset intent contains unsafe text.");
  }
}

function assertUniquePaths(paths: string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      throw new RepoReaderError("VALIDATION_ERROR", `Patchset contains duplicate path: ${path}`, {
        diagnostics: { failed_path: path }
      });
    }
    seen.add(path);
  }
}

function patchsetManifestPath(patchsetId: string): string {
  return `.chatgpt/patchsets/${patchsetId}/manifest.json`;
}

function createPatchsetId(): string {
  return `patchset-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
