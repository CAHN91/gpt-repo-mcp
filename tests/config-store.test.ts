import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/store.js";

describe("config store", () => {
  test.each([
    {
      name: "top-level config",
      path: [],
      document: { repos: [], limits: {}, limitz: {} }
    },
    {
      name: "repository",
      path: ["repos", 0],
      document: {
        repos: [{ repo_id: "repo", display_name: "Repo", root: ".", display_nam: "Typo" }],
        limits: {}
      }
    },
    {
      name: "write policy",
      path: ["repos", 0, "writes"],
      document: {
        repos: [{
          repo_id: "repo",
          display_name: "Repo",
          root: ".",
          writes: { enabledd: true }
        }],
        limits: {}
      }
    },
    {
      name: "operations policy",
      path: ["repos", 0, "operations"],
      document: {
        repos: [{
          repo_id: "repo",
          display_name: "Repo",
          root: ".",
          operations: { git_stage_enabledd: true }
        }],
        limits: {}
      }
    },
    {
      name: "limits",
      path: ["limits"],
      document: { repos: [], limits: { max_filse: 10 } }
    }
  ])("rejects unknown fields in $name", async ({ document, path }) => {
    const sandbox = await mkdtemp(join(tmpdir(), "config-store-"));
    const configPath = join(sandbox, "config.local.json");
    await writeFile(configPath, JSON.stringify(document));

    await expect(loadConfig(configPath)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_keys",
          path
        })
      ])
    });
  });

  test("migrates legacy ship-like operations to validation-enabled runtime policy", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "config-store-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      repos: [
        {
          repo_id: "ship-like",
          display_name: "Ship Like",
          root: repoRoot,
          operations: {
            enabled: true,
            git_stage_enabled: true,
            git_commit_enabled: true,
            validation_test_path_globs: [],
            cleanup_enabled: true
          }
        }
      ],
      limits: {}
    }, null, 2));

    const config = await loadConfig(configPath);

    expect(config.repos[0]?.operations).toMatchObject({
      enabled: true,
      git_stage_enabled: true,
      git_commit_enabled: true,
      validation_enabled: true,
      validation_test_path_globs: ["tests/**", "**/*.test.ts", "**/*.spec.ts"],
      cleanup_enabled: true
    });
  });

  test("preserves an explicit ship-like validation opt-out", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "config-store-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      repos: [{
        repo_id: "explicit-opt-out",
        display_name: "Explicit Opt Out",
        root: repoRoot,
        operations: {
          enabled: true,
          git_stage_enabled: true,
          git_commit_enabled: true,
          validation_enabled: false,
          validation_test_path_globs: [],
          cleanup_enabled: true
        }
      }],
      limits: {}
    }, null, 2));

    const config = await loadConfig(configPath);

    expect(config.repos[0]?.operations).toMatchObject({
      validation_enabled: false,
      validation_test_path_globs: []
    });
  });
});
