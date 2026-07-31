import type {
  PatchsetHunkDiagnostic,
  PatchsetManifest
} from "../contracts/patchset.contract.js";

export type PatchsetApplyFileResult = {
  operation: PatchsetManifest["files"][number]["operation"];
  path: string;
  new_path?: string;
  changed: boolean;
  old_sha256?: string;
  new_sha256?: string;
  hunk_diagnostics?: PatchsetHunkDiagnostic[];
};

export function rollbackHintForResults(
  results: PatchsetApplyFileResult[],
  rollbackExecutable: boolean,
  unavailableReason = "First-class rollback requires an expected Git HEAD; review the patchset and current Git state before calling repo_rollback_patchset."
) {
  return {
    executable: rollbackExecutable,
    reason: results.length === 0
      ? "No changed patchset paths require rollback."
      : rollbackExecutable
        ? "First-class rollback is available through repo_rollback_patchset while the patchset remains uncommitted, unstaged, and unchanged since apply."
        : unavailableReason,
    paths: results.flatMap((result) => {
      if (result.operation === "create") {
        return [{
          path: result.path,
          strategy: "cleanup_created" as const,
          reason: "Patchset rollback can delete this SHA-matched untracked created file."
        }];
      }
      if (result.operation === "rename" && result.new_path) {
        return [
          {
            path: result.path,
            strategy: "restore_tracked" as const,
            reason: "Patchset rollback can restore this tracked rename source when current state still matches."
          },
          {
            path: result.new_path,
            strategy: "cleanup_created" as const,
            reason: "Patchset rollback can delete this SHA-matched untracked rename destination."
          }
        ];
      }
      return [{
        path: result.path,
        strategy: "restore_tracked" as const,
        reason: result.operation === "delete"
          ? "Patchset rollback can restore this tracked deleted path when current state still matches."
          : "Patchset rollback can restore this tracked modified path when current state still matches."
      }];
    })
  };
}

export function changedPathsForResults(results: PatchsetApplyFileResult[]): string[] {
  return results.flatMap((result) => {
    if (!result.changed) return [];
    return result.operation === "rename" && result.new_path ? [result.path, result.new_path] : [result.path];
  });
}

export function hunkDiagnosticsForResults(results: PatchsetApplyFileResult[]): PatchsetHunkDiagnostic[] {
  return results.flatMap((result) => result.hunk_diagnostics ?? []);
}
