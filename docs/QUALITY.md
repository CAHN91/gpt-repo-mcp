# Quality Checklist

This project is a closed-world MCP server for approved local repositories. Quality work should preserve the contract-first architecture, clear tool surface, and conservative safety model.

## Architecture Invariants

- Tool flow stays `contracts -> toolContracts -> package definitions -> registry -> define-tool -> package handlers -> services`.
- `src/tools/catalog.ts` remains a thin compatibility re-export of the registry:
  no definitions, inline Zod schemas, or policy logic.
- Handlers stay thin: resolve context, create services, call services, return envelopes.
- Filesystem access stays behind the existing sandbox, ignore, classifier, reader, writer, and policy services.
- Mutating behavior stays separate from read services.

## Tool Contract Rules

- Every tool has one central input contract and one central output contract in `src/tools/contracts.ts`.
- Contracts use Zod objects and include field descriptions for public MCP usability.
- Output schemas describe successful `structuredContent`; errors use the shared MCP error envelope.
- Tool names, descriptions, annotations, and handlers are defined once in
  `src/tools/packages/*` and composed through the registry.
- Tests must prove registry entries use the central contract objects.

## MCP Surface Rules

- Tool descriptions start with `Use this when...`.
- Read tools use read-only annotations.
- Mutating tools use mutating annotations:
  - `readOnlyHint: false`
  - `destructiveHint: true`
  - `openWorldHint: false`
  - `idempotentHint: false`
- Tool results keep machine-readable data in `structuredContent` and short summaries in `content`.
- Do not add standard MCP `search` or `fetch` unless connector compatibility becomes an explicit project goal.

## Security Rules

- Do not add shell execution or generic command execution.
- Do not weaken approved-root, path traversal, symlink, secret, denied glob, expected SHA, expected HEAD, or exact staged path checks.
- Do not expose push, pull, reset, checkout, switch, rebase, merge, stash, clean, force, branch deletion, or arbitrary git command tools.
- Prefer repo-relative paths in outputs and logs.
- Keep generated backups and cleanup artifacts out of commits unless explicitly reviewed.

## Required Verification

Run the focused checks for the area changed, then run:

```bash
npm run typecheck
npm test -- tests/tool-contracts.test.ts tests/mcp-contract.test.ts
npm run lint
npm run check:public
npm run verify:dist
git diff --check
```

Run service tests when touching service behavior:

```bash
npm test -- tests/file-writer.test.ts tests/git-operations-service.test.ts tests/cleanup-service.test.ts
```

## Release Readiness Checklist

- README describes the current tool surface and disabled-by-default mutating tools.
- `docs/SECURITY.md`, `docs/TOOL_SURFACE.md`,
  `docs/DELEGATION_ARTIFACTS.md`, `docs/WRITE_WORKFLOWS.md`, and this file are
  current.
- `docs/ERRORS.md` lists stable error codes.
- CI must pass before merge.
- Contract tests must run when the tool surface, annotations, or schemas change.
- Mutating tool schema descriptions must remain covered by tests.
- Public hygiene checks must pass before release.
- The built `dist/server.js` runtime smoke must pass before release.
- MCP contract tests pass and snapshots match intentional tool surface changes.
- No private local paths, personal workflow instructions, tokens, or recorder guidance are present in public docs.
- Public documents do not link to internal roadmaps, dated specifications, or
  source-only runtime documentation.
- `package.json` metadata is accurate and `package-lock.json` is unchanged unless dependencies changed intentionally.

## How To Add A Tool

1. Add input and output contracts under `src/contracts/*`.
2. Add the tool to `src/tools/contracts.ts`.
3. Add a concise description in `src/tools/descriptions.ts`.
4. Add metadata and handler wiring in the matching `src/tools/packages/*` module.
5. Add a thin adapter in the matching `src/tools/handlers/*` module.
6. Put real logic in `src/services/*`.
7. Add service tests when behavior is non-trivial.
8. Update MCP contract tests, registry discipline tests, and docs.

## How To Add A Mutating Tool

1. Require explicit opt-in config with safe disabled defaults.
2. Use mutating annotations and add the tool to the shared mutating tool list.
3. Provide `dry_run` where practical.
4. Require explicit repo-relative paths where paths are applicable.
5. Do not use shell execution or arbitrary git/command runners.
6. Put authorization decisions in a policy or service layer.
7. Put execution logic in a service, not a handler.
8. Add focused service tests for policy, safety, dry-run, and mutation behavior.
9. Add MCP contract and tool contract tests.
10. Update security, tool surface, workflow, and error docs.
