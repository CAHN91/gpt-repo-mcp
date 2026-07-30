# Architecture

GPT Repo MCP (`gpt-repo-mcp`) is a tool-only MCP server. There is no widget in v1. The server exposes a Streamable HTTP `/mcp` endpoint plus a local health route.

## Boundaries

- `src/server.ts` owns the HTTP server, `/mcp` transport, and `/health`.
- `src/instructions.ts` contains server-wide MCP instructions for cross-tool workflows.
- `src/register.ts` creates the MCP server and registers tools.
- `src/contracts/*` contains Zod input and output contracts.
- `src/tools/contracts.ts` is the single tool-name to contract map; `ToolName` is derived from its keys.
- `src/tools/tool-definition.ts` defines internal package, tier, capability, contract, annotation, and handler metadata.
- `src/tools/packages/*` owns each tool definition exactly once in one of six internal packages.
- `src/tools/registry.ts` validates package completeness and duplicates, then composes the canonical 46-tool order.
- `src/tools/catalog.ts` is a thin compatibility re-export of the registry.
- `src/tools/define-tool.ts` converts registry contract objects to MCP SDK schemas and registers metadata.
- `src/tools/handlers/*` contains package-scoped thin adapters from tool input to services; `src/tools/handlers.ts` is a compatibility barrel.
- `src/tools/handler-support.ts` centralizes input parsing, error envelopes, legacy delegation migration guidance, and HEAD guards shared by handlers.
- `src/delegation/*` contains the public, repository-owned delegation artifact contracts and safe stores. It does not execute or load an agent runner.
- `src/services/*` contains filesystem, git, search, tree, read, write, project, task, decision, and advisory planning logic.
- `src/policies/*` contains shared limits, excludes, write defaults, and secret patterns.
- `src/runtime/*` contains context, structured errors, result envelopes, and audit logging.

## Tool Registration Flow

The intended flow is:

```text
contracts -> toolContracts -> package definitions -> registry -> define-tool -> package handlers -> services
```

Contracts define schemas. `toolContracts` assigns exactly one input and output contract to each tool and supplies the derived `ToolName` type. Package modules assign title, annotation, package, tier, optional capability requirements, and handler exactly once. The central registry rejects duplicate or missing definitions and restores the canonical public order before registration. `define-tool` is the only layer that turns Zod objects into MCP SDK `inputSchema` and `outputSchema` shapes. Package handlers resolve approved repos and call services.

The current runtime registers the complete 46-tool surface. The only addition after RNV-06C is the explicit specialist `repo_write_integration_review` authority boundary; package and tier metadata remain internal preparation for later profile work.

## Data Flow

ChatGPT calls a tool with `repo_id` and repo-relative POSIX paths or globs. The handler resolves `repo_id` through `RootRegistry`, creates the required services, and returns a result envelope.

Read filesystem access goes through shared safety layers:

```text
PathSandbox -> IgnoreEngine -> FileClassifier -> SecretScanner/FileReader
```

Write filesystem access stays separate from read services:

```text
PathSandbox -> WritePolicy -> FileWriter
                         \-> WriteChangesService -> FileWriter
write handlers -> OperationReceiptService
```

`repo_write_file` has its own contract, write annotations, repo-level policy, and service. The handler only resolves `repo_id`, builds the sandbox and write policy, and delegates to `FileWriter`.

`repo_write_changes` is the multi-file writer and edit-pack applier. It has its own contract and handler, applies ordered changes through `FileWriter`, and inherits the same repo-local path validation, write policy, symlink, unsupported file type, UTF-8 edit target, hard-risk secret path, resulting-content secret scan, and atomic per-file write guardrails. Grouped same-file edits read one existing file, apply exact-match nested edits in memory, and write once only after every nested edit succeeds. It does not stage, commit, restore, reset, or run shell commands; Git review and recovery workflows are the safety layer after a successful edit pack.

`OperationReceiptService` writes lightweight local receipt metadata after successful actual changed write operations and reads it through `repo_last_write`. Receipts live at `.chatgpt/operations/last-write.json`, are ignored by Git, and contain only safe metadata such as repo-relative paths, counts, timestamps, best-effort HEAD SHAs, and summaries. They do not store contents, snippets, diffs, prompts, command output, secrets, or absolute paths.

Read-only git status and diff operations are owned by `GitService`. Safe local git staging, one-call reviewed stage-and-commit, commit, and explicit worktree restore operations are separate opt-in mutating tools with their own contracts, policy checks, and service logic. Advisory services call existing factual services where practical instead of bypassing repo policy.

Git recovery is separate from write tools. `repo_write_file` and `repo_write_changes` write files only. `repo_write_recover` is the reviewed composite recovery helper: after `expected_head_sha` verification it can unstage explicit paths, restore explicit tracked worktree paths, and clean explicit generated artifacts through cleanup policy in one approved call. `repo_git_restore_paths` remains the granular worktree-only restore tool with fixed `git restore -- <paths>` arguments; it does not unstage, stage, commit, reset, checkout, clean, stash, restore the whole repo, or run shell commands.

`repo_git_review` remains read-only, but it is the workflow hub after write operations. It classifies changed paths and returns ready-to-run payloads for composite `repo_write_stage_commit` and `repo_write_recover` workflows, plus granular explicit worktree restore, cleanup-eligible generated untracked paths, unstage, stage, and commit operations without executing any of them. Safe untracked source, test, and documentation files can enter the same stage-and-commit happy path as tracked edits, while secret candidates, generated/cache/dependency paths, local ChatGPT/Codex artifacts, deleted paths, and renamed paths stay excluded. When staged paths exist, it adds guidance that granular restore is worktree-only while `repo_write_recover` can explicitly unstage and restore the same reviewed path in one approved call.

The preferred high-level mutation flow is `repo_git_review` followed by the review-provided `repo_write_stage_commit` or `repo_write_recover` payload through the host approval UI. Granular tools remain available for specific requested operations, staged-only commits, troubleshooting, or cases where composite payloads are absent.

## Canonical Development Workflow

The normal direct-development path is intentionally linear:

```text
repo_project_brief or repo_current_work_session
        |
repo_search -> repo_fetch_file / repo_read_many
        |
repo_context_map / repo_symbol_context only when needed
        |
repo_write_file / repo_write_changes
        |
repo_validate
        |
repo_ship_review or repo_git_review
        |
repo_write_stage_commit or repo_write_recover
```

Authority remains separated:

- `repo_project_brief` supplies repository-owned product and technical context, but never selects work.
- `repo_current_work_session` returns full active or blocked current-pointer continuity, but only compact identity metadata for completed history; explicit `work_session_id` lookup retrieves the full historical session.
- `repo_change_plan` analyzes how to implement an explicit caller-supplied goal.
- `repo_task_inventory` discovers backlog markers only when explicitly requested.
- `repo_decision_memory` supplies supporting historical evidence only.
- `repo_git_review` and `repo_ship_review` own current-state and readiness decisions; no planning router sits between them and ChatGPT.

Patchsets, delegation, standalone semantic review, failure diagnosis, code indexing, and granular Git operations remain specialist workflows. They are not inserted into the normal path unless the request requires their distinct capability.

## Multi-Run Integration Review

Modern Delegation v3 runs capture content fingerprints for paths already dirty at baseline. `repo_codex_review` scopes diff loading and state binding to the run's claimed and deterministically attributed paths. Unrelated work outside that pathset does not stale the run; HEAD drift or any content change inside it does. Older v3 artifacts without path states retain the conservative whole-worktree binding.

`repo_write_integration_review` is a separate specialist authority boundary for an owner-selected set of currently attested runs. `IntegrationReviewService` requires exact coverage of the current project changes, current full validation, product verdicts, complete semantic evidence, path safety, and all applicable gates. It writes a hash-bound `.chatgpt/integration-reviews/**` artifact containing the exact HEAD, run review hashes, pathset, content fingerprint, validation hash, and commit message.

The existing `repo_write_stage_commit` consumes either explicit paths for the normal flow or an opaque integration pathset id. The token path is resolved server-side and rechecked before and after staging; clients cannot add paths or change the reviewed message. See the stable [Delegation Artifact Protocol](DELEGATION_ARTIFACTS.md).

## Delegation Drift Evidence

`DelegationDriftService` is an internal read-only analysis service, not a public planning tool. It scans at most the latest 250 validated Delegation v3 runs and reads only strict `run.json`, strict `RESULT.json`, and hash-valid `review.json` artifacts through existing safe run-artifact boundaries.

The service is projected in two bounded places:

- `repo_agent_runs` list mode returns the complete aggregate `drift_summary`;
- `repo_project_brief.product_brief` returns only `delegation_checkpoint`.

`DelegationV3TaskService` may add existing drift signal codes to the task's normal `delegation_audit` warnings. Historical signals never block task creation in RNV-05, choose priorities, alter authorization, replace work-session direction, or create next-tool payloads. A passed product review already provides checkpoint evidence, so no separate checkpoint file, write tool, database, or dashboard exists.

A dedicated workflow-drift regression suite locks the intentional 46-tool surface, physical removal of obsolete routers/aliases, canonical active documentation, and the authority separation between work sessions, explicit-goal planning, run evidence, explicit integration approval, and Git/ship review.

## Adding a Tool

Add a new tool by following the contract-first path:

1. Add input and output Zod objects under `src/contracts/*`.
2. Add the tool entry to `src/tools/contracts.ts`; `ToolName` updates automatically from the map key.
3. Add a concise `Use this when...` description in `src/tools/descriptions.ts`.
4. Add one definition to the appropriate `src/tools/packages/*` module with title, annotation, package, tier, capability metadata, and handler.
5. Add the name once to `CANONICAL_TOOL_ORDER` in `src/tools/registry.ts`.
6. Add a thin handler to the matching `src/tools/handlers/*` module and keep shared parsing/error behavior in `handler-support.ts`.
7. Put real logic in a service under `src/services/*`.
8. Add service tests, MCP contract coverage, registry/package invariants, tool contract discipline tests, and golden prompts when routing changes.

Do not duplicate path validation, ignore handling, secret scanning, schema definitions, or result envelope logic inside individual tools.

## Mutating Tools

Mutating tools are disabled by default per repository and must be enabled through explicit repo-local policy. `repo_write_file` can write or exact-match edit one file inside configured allowed globs and outside configured denied globs. `repo_write_changes` applies the same write/edit semantics to an ordered multi-file edit pack and supports grouped same-file exact-match edits without allowing duplicate top-level paths.

Mutating tools must stay separate from read tools. Do not loosen read services to support mutation, do not add shell execution, and do not add broad git automation. Safe git tools stage explicit paths, unstage explicit paths, restore explicit worktree paths, or create a local commit from an exact staged path list only after policy and HEAD checks. Cleanup tools remove only explicit generated artifacts allowed by cleanup policy.
