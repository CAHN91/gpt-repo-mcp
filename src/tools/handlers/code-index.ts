import { createSuccessEnvelope } from "../../runtime/result-envelope.js";
import { audit } from "../../runtime/telemetry.js";
import type { CodeIndexInput } from "../../contracts/code-index.contract.js";
import { safeTool, type ToolHandler } from "../handler-support.js";

export const codeIndexHandler: ToolHandler = async (input, context) => safeTool<CodeIndexInput>("repo_code_index", input, async (args) => {
  const repo = context.registry.get(args.repo_id);
  const result = context.codeIntelligence
    ? await context.codeIntelligence.index(repo, args.action)
    : {
        ok: true as const,
        repo_id: args.repo_id,
        provider: "codebase_memory" as const,
        action: args.action,
        status: "provider_unavailable" as const,
        events: [{ at: new Date().toISOString(), status: "provider_unavailable" as const, message: "Codebase Memory is not configured." }],
        warnings: ["CODEBASE_MEMORY_NOT_CONFIGURED"]
      };
  audit({ tool: "repo_code_index", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Codebase Memory index status: ${result.status}.`);
});
