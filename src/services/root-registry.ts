import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";
import { CodeIntelligenceConfigSchema, OperationsPolicyConfigSchema, WritePolicyConfigSchema } from "../config/schema.js";

const RepoConfigSchema = z.object({
  repo_id: z.string().min(1),
  display_name: z.string().min(1),
  root: z.string().min(1),
  writes: WritePolicyConfigSchema.optional(),
  operations: OperationsPolicyConfigSchema.optional()
});

const ConfigSchema = z.object({
  repos: z.array(RepoConfigSchema).default([]),
  limits: z.object({
    max_files: z.number().int().positive().optional(),
    max_bytes_per_file: z.number().int().positive().optional(),
    max_total_bytes: z.number().int().positive().optional()
  }).default({}),
  code_intelligence: CodeIntelligenceConfigSchema.optional()
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type RepoReaderConfig = z.infer<typeof ConfigSchema>;
type RepoReaderConfigInput = z.input<typeof ConfigSchema>;

export class RootRegistry {
  private constructor(
    private readonly repos: RepoConfig[],
    readonly limits: Required<RepoReaderConfig["limits"]>,
    readonly codeIntelligence: RepoReaderConfig["code_intelligence"]
  ) {}

  static async fromConfig(config: RepoReaderConfigInput): Promise<RootRegistry> {
    const parsed = ConfigSchema.parse(config);
    const repos = [];
    for (const repo of parsed.repos) {
      repos.push({ ...repo, root: await realpath(repo.root) });
    }
    return new RootRegistry(repos, {
      max_files: parsed.limits.max_files ?? DEFAULT_LIMITS.max_files,
      max_bytes_per_file: parsed.limits.max_bytes_per_file ?? DEFAULT_LIMITS.max_bytes_per_file,
      max_total_bytes: parsed.limits.max_total_bytes ?? DEFAULT_LIMITS.max_total_bytes
    }, parsed.code_intelligence);
  }

  static async fromFile(configPath: string): Promise<RootRegistry> {
    const raw = await readFile(configPath, "utf8");
    return RootRegistry.fromConfig(JSON.parse(raw));
  }

  list(): Array<Pick<RepoConfig, "repo_id" | "display_name" | "root">> {
    return this.repos.map((repo) => ({
      repo_id: repo.repo_id,
      display_name: repo.display_name,
      root: repo.root
    }));
  }

  get(repoId: string): RepoConfig {
    const repo = this.repos.find((candidate) => candidate.repo_id === repoId);
    if (!repo) {
      throw new RepoReaderError("UNKNOWN_REPO", `Unknown repo_id: ${repoId}`);
    }
    return repo;
  }
}
