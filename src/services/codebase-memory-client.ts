import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface CodebaseMemoryClient {
  call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export type CodebaseMemoryClientFactory = (repoRoot: string) => Promise<CodebaseMemoryClient>;

export async function validateCodebaseMemoryExecutable(executable: string): Promise<string> {
  const resolved = await realpath(executable);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) {
    throw new Error("Configured Codebase Memory executable is not a regular file.");
  }
  await access(resolved, constants.X_OK);
  return resolved;
}

export function createCodebaseMemoryClientFactory(executable: string): CodebaseMemoryClientFactory {
  let validatedExecutable: Promise<string> | undefined;
  return async (repoRoot) => {
    validatedExecutable ??= validateCodebaseMemoryExecutable(executable);
    const command = await validatedExecutable;
    const transport = new StdioClientTransport({
      command,
      args: [],
      // Do not use the repository as cwd: upstream may have global auto_index enabled.
      // Explicit index_repository is the only path that may initiate indexing.
      cwd: tmpdir(),
      env: {
        CBM_ALLOWED_ROOT: repoRoot,
        CBM_LOG_LEVEL: "error"
      },
      stderr: "pipe"
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "gpt-repo-mcp-code-intelligence", version: "1.0.0" });
    await client.connect(transport);

    return {
      async call(tool, args, timeoutMs) {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
        const response = result as Record<string, unknown>;
        const content = Array.isArray(response.content) ? response.content : [];
        if (response.isError === true) {
          throw new Error(toolErrorMessage(content));
        }
        if (isRecord(response.structuredContent)) {
          return response.structuredContent;
        }
        const textEntry = content.find((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string");
        const text = isRecord(textEntry) && typeof textEntry.text === "string" ? textEntry.text : undefined;
        if (!text) return {};
        const parsed: unknown = JSON.parse(text);
        if (!isRecord(parsed)) throw new Error(`Codebase Memory ${tool} returned a non-object result.`);
        return parsed;
      },
      async close() {
        await client.close();
      }
    };
  };
}

export async function findCodebaseMemoryProject(
  client: CodebaseMemoryClient,
  repoRoot: string,
  timeoutMs: number
): Promise<string | undefined> {
  const response = await client.call("list_projects", {}, timeoutMs);
  const projects = Array.isArray(response.projects) ? response.projects : [];
  const approvedRoot = await realpath(repoRoot);
  for (const candidate of projects.slice(0, 1_000)) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || typeof candidate.root_path !== "string") continue;
    const candidateRoot = await realpath(candidate.root_path).catch(() => undefined);
    if (candidateRoot === approvedRoot) return candidate.name;
  }
  return undefined;
}

function toolErrorMessage(content: unknown[]): string {
  const entry = content.find((candidate) => isRecord(candidate) && candidate.type === "text" && typeof candidate.text === "string");
  const text = isRecord(entry) && typeof entry.text === "string" ? entry.text : undefined;
  return text ? `Codebase Memory tool failed: ${text.slice(0, 500)}` : "Codebase Memory tool failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
