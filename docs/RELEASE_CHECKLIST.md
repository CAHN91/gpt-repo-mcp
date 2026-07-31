# Release Checklist

Use this checklist before tagging, publishing, or announcing a public release.

## Local State

- Confirm git status is clean.
- Confirm `package-lock.json` only changed when dependencies changed intentionally.
- Confirm generated backups, `dist/**`, `coverage/**`, `test-results/**`, and smoke-test artifacts are not staged accidentally.

## Verification Commands

```bash
npm ci
npm run typecheck
npm test -- tests/tool-contracts.test.ts tests/mcp-contract.test.ts
npm test
npm run lint
npm run check:public
npm run verify:dist
npm run security:scan -- \
  --candidate /absolute/path/to/candidate \
  --export-report /absolute/path/to/candidate.oss-export-report.json \
  --public-repo /absolute/path/to/public-repo \
  --gitleaks-bin /absolute/path/to/pinned/gitleaks
git diff --check
```

## Public Docs

- Verify README quickstart.
- Verify `CHANGELOG.md` and `docs/MIGRATION.md`.
- Verify `config.example.json`.
- Verify public CLI examples use `gpt-repo` or npm shortcuts, with `connect-gpt` only as a compatibility alias.
- Verify public environment examples use `GPT_REPO_*`, with `REPO_READER_*` only as fallback aliases.
- Verify `docs/SETUP.md`.
- Verify `docs/CHATGPT_CONNECT.md`.
- Verify `docs/CONNECTION_OPTIONS.md`.
- Verify `docs/SECURITY.md`.
- Verify `docs/TOOL_SURFACE.md`.
- Verify `docs/WRITE_WORKFLOWS.md`.
- Verify `docs/DELEGATION_ARTIFACTS.md`.
- Verify `docs/ARCHITECTURE.md`.
- Verify `docs/QUALITY.md`.
- Verify `docs/RELEASE_CHECKLIST.md`.
- Verify root `SECURITY.md`.
- Verify `CONTRIBUTING.md`.
- Verify `LICENSE`.

## Public Hygiene

- Verify no absolute local home-directory paths are present.
- Verify no private company names, private customer names, or internal project paths are present.
- Verify local-only artifacts such as `.DS_Store`, local config, generated state, handoffs, backlog notes, and operation receipts are not tracked.
- Verify no tokens, credentials, private keys, or secrets are present.
- Verify candidate and retained public history have zero unclassified Gitleaks
  findings and zero unclassified email occurrences.
- Verify release-generation reports remain outside the candidate and are not
  included in the public branch or npm package.
- Verify dependency licenses and both production and full audit results match
  `security/oss-security-policy.json`.
- Verify the sanitized public export excludes `.chatgpt/`.
- Verify every exported file is intentionally public and required by the product,
  documentation, tests, or release workflow.
- Verify public documents link only to files included in the candidate.
- Verify the fresh public export has been audited separately from the working tree.
- Verify npm packaging excludes local ChatGPT artifacts, local config, environment files, and generated test output before enabling npm publishing.

## Package Metadata

- Verify `package.json` name, version, description, license posture, repository metadata, and privacy setting are intentional.
- Keep `private: true` unless the release intentionally prepares npm publishing.

## Safety Surface

- Verify read tools remain read-only.
- Verify mutating tools remain disabled by default.
- Verify no shell execution or arbitrary command runner was added.
- Verify no push, pull, reset, checkout, switch, rebase, merge, stash, clean, force, branch deletion, or arbitrary git command tool was added.
