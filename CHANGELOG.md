# Changelog

All notable public changes to GPT Repo MCP are documented here.

## [0.2.0] - Unreleased

### Added

- Repository context maps, symbol context, optional code indexing, failure
  diagnosis, semantic review, and ship-readiness review.
- Operation receipts and ledger access, allowlisted validation, work sessions,
  and transactional patchset prepare/apply/review/rollback workflows.
- Delegation v3 run inspection, structured replies, state-bound review
  attestations, and reviewed multi-run integration.
- Secure Cloudflare connection support, stricter network boundaries, and
  deterministic OSS release verification.

### Changed

- The recommended workflow is now inspect, edit, validate, review, then use one
  reviewed local stage/commit or recovery payload.
- Configuration rejects unknown fields and stores local backup files with
  owner-only permissions.
- Git mutation tools use one canonical `repo_write_*` name per action.
- Planning and readiness decisions come directly from work-session, change,
  Git-review, semantic-review, and ship-review tools.

### Removed

- Duplicate aliases `repo_git_stage`, `repo_git_unstage`, and
  `repo_git_commit`.
- The overlapping advisory routers `repo_next_action` and `repo_plan_review`.
- Internal agent-runner and development-harness execution from the OSS
  distribution.

### Security

- Added pinned secret scanning, reviewed dependency-license/advisory policy,
  candidate checksum verification, and strict exclusion of local/internal
  artifacts.

See [docs/MIGRATION.md](docs/MIGRATION.md) for the 0.1.x upgrade steps.
