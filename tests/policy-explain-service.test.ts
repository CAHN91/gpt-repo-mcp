import { describe, expect, test } from "vitest";
import { DEFAULT_WRITE_POLICY } from "../src/policies/write-defaults.js";
import { PolicyExplainService } from "../src/services/policy-explain-service.js";

describe("PolicyExplainService", () => {
  test("explains broad solo-dev writes with hard denied paths", () => {
    const service = new PolicyExplainService({
      repo_id: "demo",
      display_name: "Demo",
      root: "/repo",
      writes: {
        enabled: true,
        allowed_globs: ["**"],
        denied_globs: DEFAULT_WRITE_POLICY.denied_globs,
        max_bytes_per_write: 1048576
      },
      operations: {
        enabled: true,
        git_stage_enabled: true,
        git_commit_enabled: true,
        validation_enabled: true,
        validation_test_path_globs: [],
        max_paths_per_operation: 50,
        cleanup_enabled: true,
        cleanup_allowed_globs: [".chatgpt/tool-tests/**"]
      }
    });

    const appPath = service.explain({ path: "app/page.tsx", operation: "write" });
    expect(appPath.write).toMatchObject({
      allowed: true,
      code: "ALLOWED",
      matched_globs: ["**"]
    });
    expect(appPath.summary).toContain("write policy for app/page.tsx");

    const envPath = service.explain({ path: ".env.local", operation: "write" });
    expect(envPath.write).toMatchObject({
      allowed: false,
      code: "WRITE_DENIED_GLOB"
    });
    expect(envPath.write.notes).toContain("Denied globs and hard secret path checks win over allowed globs.");
  });

  test("explains nested generated and dependency paths as denied in broad write mode", () => {
    const service = new PolicyExplainService({
      repo_id: "demo",
      display_name: "Demo",
      root: "/repo",
      writes: {
        enabled: true,
        allowed_globs: ["**"],
        denied_globs: DEFAULT_WRITE_POLICY.denied_globs,
        max_bytes_per_write: 1048576
      },
      operations: {
        enabled: false,
        git_stage_enabled: false,
        git_commit_enabled: false,
        validation_enabled: false,
        validation_test_path_globs: [],
        max_paths_per_operation: 50,
        cleanup_enabled: false,
        cleanup_allowed_globs: [".chatgpt/tool-tests/**"]
      }
    });
    const deniedPaths = [
      "packages/app/node_modules/pkg/index.js",
      "apps/web/dist/client.js",
      "apps/web/.next/cache/file.js",
      "packages/api/coverage/report.json"
    ];

    for (const path of deniedPaths) {
      const result = service.explain({ path, operation: "write" });
      expect(result.write).toMatchObject({
        allowed: false,
        code: "WRITE_DENIED_GLOB"
      });
      expect(result.write.matched_globs.length).toBeGreaterThan(0);
    }
  });

  test("explains disabled writes and default-excluded reads", () => {
    const service = new PolicyExplainService({
      repo_id: "demo",
      display_name: "Demo",
      root: "/repo",
      writes: {
        enabled: false,
        allowed_globs: [".chatgpt/**", ".codex/**", "docs/**"],
        denied_globs: [".env", ".env.*", "dist/**"],
        max_bytes_per_write: 1048576
      },
      operations: {
        enabled: false,
        git_stage_enabled: false,
        git_commit_enabled: false,
        validation_enabled: false,
        validation_test_path_globs: [],
        max_paths_per_operation: 50,
        cleanup_enabled: false,
        cleanup_allowed_globs: [".chatgpt/tool-tests/**"]
      }
    });

    const result = service.explain({ path: "dist/bundle.js" });

    expect(result.read).toMatchObject({
      allowed: false,
      code: "DEFAULT_EXCLUDE_BLOCKED"
    });
    expect(result.write).toMatchObject({
      allowed: false,
      code: "WRITE_DISABLED"
    });
    expect(result.cleanup).toMatchObject({
      allowed: false,
      code: "OPERATIONS_DISABLED"
    });
    expect(result.guidance).toContain("Use --mode ship for trusted repositories when local validation, stage, commit, recover, and cleanup operations should be enabled.");
  });

  test("explains cleanup allowed globs and tracked-file caveat", () => {
    const service = new PolicyExplainService({
      repo_id: "demo",
      display_name: "Demo",
      root: "/repo",
      writes: {
        enabled: true,
        allowed_globs: ["**"],
        denied_globs: [".env", ".env.*", ".git/**", "node_modules/**"],
        max_bytes_per_write: 1048576
      },
      operations: {
        enabled: true,
        git_stage_enabled: true,
        git_commit_enabled: true,
        validation_enabled: true,
        validation_test_path_globs: [],
        max_paths_per_operation: 50,
        cleanup_enabled: true,
        cleanup_allowed_globs: [".chatgpt/tool-tests/**"]
      }
    });

    const result = service.explain({ path: ".chatgpt/tool-tests/generated.md", operation: "cleanup" });

    expect(result.cleanup).toMatchObject({
      allowed: true,
      code: "ALLOWED",
      matched_globs: [".chatgpt/tool-tests/**"]
    });
    expect(result.cleanup.notes).toContain("Cleanup refuses tracked files and does not run git clean.");
  });

  test("explains validation operation as a first-class policy focus", () => {
    const service = new PolicyExplainService({
      repo_id: "demo",
      display_name: "Demo",
      root: "/repo",
      writes: {
        enabled: true,
        allowed_globs: ["**"],
        denied_globs: DEFAULT_WRITE_POLICY.denied_globs,
        max_bytes_per_write: 1048576
      },
      operations: {
        enabled: true,
        git_stage_enabled: true,
        git_commit_enabled: true,
        validation_enabled: false,
        validation_test_path_globs: [],
        max_paths_per_operation: 50,
        cleanup_enabled: true,
        cleanup_allowed_globs: [".chatgpt/tool-tests/**"]
      }
    });

    const result = service.explain({ operation: "validation" });

    expect(result.requested_operation).toBe("validation");
    expect(result.summary).toContain("validation policy for this repository");
    expect(result.validation).toMatchObject({
      allowed: false,
      code: "VALIDATION_DISABLED"
    });
    expect(result.guidance).toContain("Enable operations.validation_enabled for trusted repositories that should run allowlisted validation profiles.");
  });
});
