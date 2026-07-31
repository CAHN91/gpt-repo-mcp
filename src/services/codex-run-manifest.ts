import { z } from "zod";
import type { DelegationRunManifestV3 } from "../contracts/delegation-v3.contract.js";
import {
  CodexCorrectiveLineageSchema,
  CodexRunManifestV2Schema,
  type CodexRunManifestV2
} from "../legacy/codex-v2/manifest.js";
import { RepoReaderError } from "../runtime/errors.js";
import { parseDelegationManifestV3 } from "./delegation-v3-normalizer.js";

export const CodexRunManifestV1Schema = z.object({
  schema_version: z.literal(1),
  repo_id: z.string().min(1),
  run_id: z.string().min(1),
  prompt_path: z.string().min(1),
  result_path: z.string().min(1),
  allowed_paths: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([])
}).passthrough();

export {
  CodexCorrectiveLineageSchema,
  CodexRunManifestV2Schema
};
export type { CodexRunManifestV2 };

export type CodexRunManifestV1 = z.infer<typeof CodexRunManifestV1Schema>;
export type CodexRunManifest = CodexRunManifestV1 | CodexRunManifestV2 | DelegationRunManifestV3;

export function parseCodexRunManifest(value: unknown): CodexRunManifest {
  if (typeof value !== "object" || value === null || !("schema_version" in value)) {
    throw unsupportedManifest();
  }
  const version = (value as { schema_version?: unknown }).schema_version;
  if (version === 1) return CodexRunManifestV1Schema.parse(value);
  if (version === 2) return CodexRunManifestV2Schema.parse(value);
  if (version === 3) return parseDelegationManifestV3(value);
  throw unsupportedManifest();
}

function unsupportedManifest(): RepoReaderError {
  return new RepoReaderError(
    "VALIDATION_ERROR",
    "Codex run manifest schema_version must be explicitly supported as version 1, 2, or 3."
  );
}
