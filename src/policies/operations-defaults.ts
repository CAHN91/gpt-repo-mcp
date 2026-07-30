export const DEFAULT_OPERATIONS_POLICY = {
  enabled: false,
  git_stage_enabled: false,
  git_commit_enabled: false,
  validation_enabled: false,
  validation_test_path_globs: [],
  validation_profiles: {},
  max_paths_per_operation: 50,
  cleanup_enabled: false,
  cleanup_allowed_globs: [
    ".chatgpt/tool-tests/**",
    ".chatgpt/backups/**",
    ".chatgpt/audits/**",
    ".chatgpt/backlog/**",
    ".chatgpt/codex-runs/**",
    "coverage/**",
    "dist/**",
    "test-results/**"
  ]
};

export const SHIP_VALIDATION_TEST_PATH_GLOBS = ["tests/**", "**/*.test.ts", "**/*.spec.ts"];
