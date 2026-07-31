# Tool Surface

Tools are closed-world repository tools. Read tools are read-only and idempotent.
Tools with local side effects use annotations that distinguish destructive writes,
non-destructive local metadata mutation, and safe idempotent provider mutation.
Availability depends on the relevant repository policy or configured provider
capability. Each tool declares an input schema, an output schema, and annotations. Runtime results return canonical data in
`structuredContent` and a short human summary in `content`.

The stable user, happy-path, safety, and deprecation decisions for this surface
live in [PRODUCT.md](PRODUCT.md). Terminology for current and compatibility
flows lives in [GLOSSARY.md](GLOSSARY.md).

For ChatGPT workflows, prefer `repo_write_stage_commit` for normal reviewed
stage-and-commit flows and `repo_write_recover` for normal reviewed recovery
flows. Use `repo_write_stage`, `repo_write_unstage`, `repo_git_restore_paths`,
`repo_cleanup_paths`, and `repo_write_commit` only when granular control is
needed. Each Git mutation has one canonical public tool name.

## Internal Registry And Packages

The public MCP surface is one ordered list of 46 tools. The one intentional post-audit addition is `repo_write_integration_review`, because multi-run owner approval is a distinct authority boundary rather than a flag on ordinary review. Internally, every tool is defined exactly once through `src/tools/packages/*` and composed by `src/tools/registry.ts`.

The internal packages are:

| Package | Count | Purpose |
| --- | ---: | --- |
| `developer` | 24 | Canonical direct development, continuity, validation, review, write, and recovery flow |
| `delegation` | 7 | Delegation v3 task, run, reply, review, and attestation flow |
| `patchsets` | 4 | Transactional prepare, apply, review, and rollback |
| `advanced_operations` | 6 | Ledger and granular Git/cleanup fallbacks |
| `diagnostics_and_discovery` | 4 | Failure diagnosis, standalone semantic review, task inventory, and decision memory |
| `code_index` | 1 | Optional Codebase Memory indexing |

Package, tier, and capability metadata are internal only in RNV-06B. They do not alter `tools/list`, approval annotations, schemas, titles, descriptions, handlers, or runtime availability. `src/tools/catalog.ts` and `src/tools/handlers.ts` remain thin compatibility barrels for existing imports.

## Choosing A Workflow

Use the `developer` package path for ordinary repository work: inspect, edit,
validate, review, then use a composite stage/commit or recovery payload.
Direct writes are the default edit path. Use patchsets only when a separately
reviewable prepare/apply/rollback transaction is required, delegation only for
an explicit external-agent handoff, and `advanced_operations` only for granular
recovery or Git control that the composite path cannot express.

The public surface remains one compatibility-stable 46-tool list. Package and
tier metadata make the distinction explicit internally, but runtime filtering
or public removal must wait for opt-in profile semantics and real usage
evidence. Do not add aliases or a second routing tool to compensate for the
surface size.

## Compact Metadata And Review Responses

RNV-06C reduced connector context and review-response bloat while the surface still had 45 tools. The later integration-review correction intentionally adds one specialist write tool, bringing the active surface to 46.

| Surface | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| `src/instructions.ts` | 15,644 bytes | 5,595 bytes | 64.2% |
| `src/tools/descriptions.ts` | 16,819 bytes | 7,692 bytes | 54.3% |

`repo_git_review` and `repo_ship_review` accept optional `detail`:

- omit it or use `compact` for the normal path;
- use `full` for granular dry-run payloads, compatibility diagnostics, or expert review.

Compact Git review preserves status, diff summary, changed paths, recommendations, validation state, delegation gate, warnings, and recovery eligibility, but returns only canonical actual composite payloads: at most one of `repo_write_stage_commit` or `repo_write_commit`, plus at most one `repo_write_recover` alternative. Full review also retains the granular and dry-run payload variants.

Compact ship review keeps the nested Git and semantic evidence, aggregate readiness, optional failure diagnosis, and one canonical ship payload. It omits the duplicated top-level delegation gate and static review-loop instructions; both remain available with `detail: "full"`. A mixed staged/unstaged state that cannot produce a safe one-call ship payload is `review_required` with `GIT_CANONICAL_SHIP_PAYLOAD_UNAVAILABLE` rather than being reported ready without an executable next step.

Regression tests require the representative compact Git result to stay below 70% of its full result and compact ship review below 75%, while full mode, PAC/TAC evidence, gates, validation, and recovery remain intact.

## Approval Behavior

The ChatGPT host approval UI is the normal confirmation boundary for mutating
tools. For mutating workflows, inspect status, diff, or file context first when
needed, then call the relevant write, validation, recovery, or ship tool with an
exact payload. Ask extra clarification before calling a mutating tool only when
the request is destructive, broad, ambiguous, high-risk, or outside a reviewed
payload. `dry_run` is a preview option for user-requested previews, unclear
risk, new-tool testing, or unusual state. For review-provided actual composite
payloads in normal trusted flows, call the actual composite tool directly and
let the host present the mutating call.
`repo_git_review` generated next-tool payloads intentionally omit optional
`reason` fields to keep host/client approval payloads small and stable. ChatGPT
or the user may add a short `reason` manually when it adds meaningful audit
context.

If a client blocks a composite mutating call before showing an approval prompt,
request `repo_git_review` with `detail: "full"` and use its granular fallback
payloads. For commit flows, stage with `repo_write_stage`, then commit with
`repo_write_commit`. That can indicate client-level pre-approval safety behavior
rather than a server policy failure.

Tool `outputSchema` describes successful `structuredContent`. Errors use the
standard MCP error path with `isError: true` and a separate structured error
envelope:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Sanitized message",
    "retryable": false,
    "diagnostics": {
      "rolled_back_paths": ["docs/example.md"],
      "failed_path": "src/example.ts",
      "recovery_hint": "Run repo_git_review and use its repo_write_recover payload for paths whose rollback failed."
    }
  }
}
```

`error.diagnostics` is optional and allowlisted. It may expose safe metadata such as repo-relative applied or rolled-back paths, stable recovery hints, or HEAD SHAs, but never file contents, raw diffs, secrets, stack traces, absolute paths, environment values, or raw command output.

## Tools

### `repo_list_roots`

Lists approved repositories. Does not read file contents.

Input: none.
Output: `repos[]` with `repo_id`, `display_name`, and configured `root`.
Example:

```json
{}
```

### `repo_policy_explain`

Explains effective repository policy without reading or mutating files. Use it when a read, write, or cleanup policy question is blocked unexpectedly, or when the user asks what ChatGPT can access.

Input: `repo_id`, optional `path`, optional `operation` (`read`, `write`, or `cleanup`).
Output: `summary`, per-area `read`, `write`, and `cleanup` decisions, local git operation toggles, effective policy globs, and `guidance[]`.
Example:

```json
{ "repo_id": "example-repo", "path": "app/page.tsx", "operation": "write" }
```

### `repo_last_write`

Reads the repo-local last-write receipt from `.chatgpt/operations/last-write.json`. The receipt is local runtime state written after successful actual changed file/edit-pack operations and patchset apply or rollback operations. It contains safe metadata only: repo-relative paths, counts, timestamps, best-effort HEAD SHAs, and a content-free summary.

Input: `repo_id`.
Output: `ok`, `found`, optional `receipt`, `next_tool_payloads`, and `warnings`.
When a receipt is found, `next_tool_payloads.repo_git_review` suggests the read-only review call for current recovery, staging, or commit payloads. When missing, warnings include `NO_LAST_WRITE_RECEIPT`.
Example:

```json
{ "repo_id": "example-repo" }
```

### `repo_operation_ledger`

Reads recent repo-local write operation history from `.chatgpt/operations/ledger.jsonl`. The ledger is local runtime state written after successful actual changed file/edit-pack and patchset apply or rollback operations. It returns content-free metadata only, newest first, filtered by `repo_id`.

Input: `repo_id`, optional `limit`, optional `cursor`, optional `after_operation_id`.
Output: `ok`, `repo_id`, `events[]`, optional `next_cursor`, and `warnings[]`.

Use `limit` for page size, `cursor` for the next page returned by a previous call, and `after_operation_id` to inspect operations newer than a known operation. Invalid JSONL lines are skipped with warnings; file contents, diffs, prompts, command output, secrets, and absolute paths are never returned.

### `repo_prepare_patchset`

Prepares and persists a local patchset manifest for transactional `create`, full-file `modify`, `delete`, `rename`, and structured `edit` operations. It is annotated as a non-destructive, non-idempotent local mutation because each call creates a new manifest identity. `create` and `modify` use complete file `content`; `delete` removes an existing tracked file; `rename` moves an existing path to `new_path`; `edit` applies ordered exact-match replacement `hunks`. This slice does not support unified diff or validation execution.

Input: `repo_id`, `intent`, `files[]`, optional `base_head_sha`, optional `work_session_id`.
Output: `ok`, `patchset_id`, `manifest_path`, `manifest`, `affected_paths[]`, `warnings[]`, and `next_tool_payloads`.

The tool writes only `.chatgpt/patchsets/<patchset_id>/manifest.json`; it does not change target files, stage, commit, push, run shell commands, or execute validation.

### `repo_apply_patchset`

Applies a prepared structured patchset. It revalidates write policy, path safety, stale-state guards, size limits and secret scanning for content writes and structured edits, plus source/destination checks for delete and rename, before mutating. Structured edits produce per-hunk diagnostics and fail before any mutation when a hunk anchor is missing or ambiguous. If an unexpected apply failure occurs after applying some paths, it restores touched paths from pre-write snapshots before returning the failure.

Input: `repo_id`, `patchset_id`, optional `expected_head_sha`, optional `dry_run`.
Output: `ok`, `dry_run`, `patchset_id`, optional `operation_id`, changed/created/modified/deleted/renamed paths, `hunk_diagnostics[]`, counts, rollback availability and path evidence, optional operation receipt, warnings, and `next_tool_payloads`. An actual changed apply bound to `expected_head_sha` or manifest `base_head_sha` returns a complete `repo_rollback_patchset` payload.

The tool writes files only through the host approval UI and records the operation as `repo_apply_patchset` in last-write and ledger metadata. It does not stage, commit, push, pull, reset, checkout, switch, rebase, merge, stash, clean, run shell commands, or execute validation.

### `repo_review_patchset`

Reviews a prepared or applied patchset without mutating files or Git. It reads the patchset manifest, checks operation ledger state for whether the patchset was applied, and returns the current git review summary.

Input: `repo_id`, `patchset_id`, optional `max_files`.
Output: `ok`, `patchset_id`, `manifest_path`, `manifest`, `applied`, `rolled_back`, optional `git_review`, and `warnings[]`.

### `repo_rollback_patchset`

Rolls back one uncommitted applied patchset when ledger state and current files still match the applied patchset. It restores tracked modified, edited, or deleted paths with Git and deletes untracked patchset-created or rename-destination files only when their current SHA-256 still matches the patchset-applied SHA.

Input: `repo_id`, `patchset_id`, `expected_head_sha`, optional `dry_run`.
Output: `ok`, `dry_run`, `patchset_id`, optional `operation_id`, `restored_paths[]`, `deleted_paths[]`, `skipped[]`, counts, optional operation receipt, warnings, and `next_tool_payloads`.

The tool refuses unapplied, already rolled-back, committed, drifted, staged, tracked-created, or unsupported targets. It does not stage, commit, push, pull, reset, checkout, switch, rebase, merge, stash, run shell commands, or execute validation.

### `repo_validate`

Runs allowlisted repository validation profiles. Input accepts only `test`, `build`, `lint`, `typecheck`, `smoke`, or `all`, plus optional `dry_run`, `timeout_ms`, and focused `test_paths[]`. Matching npm scripts take priority. Exact Node.js versions may be selected from `package.json#volta.node`, `.node-version`, `.nvmrc`, or exact `package.json#engines.node`, in that order. The version must already exist under a supported nvm, mise, fnm, Volta, or asdf installation root. Non-exact ranges do not change the host runtime. When `test` has no npm script, detected pytest suites retain their safe Python fallback. The tool never installs runtimes or accepts command strings.

Input: `repo_id`, `profile`, optional `test_paths[]`, optional `dry_run`, optional `timeout_ms`.
Output: `ok`, `repo_id`, optional `validation_id`, requested `profile`, optional `focused`, optional `test_paths[]`, `dry_run`, overall `status`, selected `commands[]`, counts, optional `validation_artifact`, and warnings.

`dry_run: true` resolves matching runners and verifies a requested Node binary without running project scripts. Actual validation uses `execFile` without a shell and fixed executable/argument arrays. A selected Node runtime only prepends its verified `bin` directory to that command's `PATH`; the artifact exposes runtime name, exact version, and metadata source, never its absolute installation path. Duration/output remain bounded and redacted. Focused paths require `operations.validation_test_path_globs` and are separate arguments. The tool requires both operations flags.

### `repo_start_work_session`

Creates structured local work-session state for a focused multi-step implementation. This is distinct from `repo_write_handoff`: work sessions are compact content-free JSON for active tool workflows, while handoffs are human-readable markdown for chat-to-chat continuity.

Input: `repo_id`, `title`, `objective`, `next_action`, optional `work_session_id`, optional `constraints[]`, optional `files_inspected[]`, optional `touched_files[]`, optional `dry_run`.
Output: `ok`, `dry_run`, `work_session_id`, `session_path`, `current_path`, full `session`, warnings, and `next_tool_payloads.repo_current_work_session`.

The tool writes `.chatgpt/work-sessions/<work_session_id>.json` and `.chatgpt/work-sessions/current.json` through normal write policy. It stores no file contents, raw diffs, command output, prompts, secrets, or absolute paths.

### `repo_update_work_session`

Updates an existing work session by appending content-free progress metadata and optionally replacing status or next action.

Input: `repo_id`, `work_session_id`, optional `status`, optional `next_action`, optional append arrays for inspected files, touched files, decisions, assumptions, pending patchsets, validation results, and unresolved risks, optional `dry_run`.
Output: same shape as `repo_start_work_session`.

Array updates deduplicate repeated entries while preserving first-seen order. Path arrays accept only safe repo-relative POSIX paths.

### `repo_current_work_session`

Reads current-pointer continuity or an explicitly identified historical session without mutating files or Git.

Input: `repo_id`, optional `work_session_id`.
Output: `ok`, `repo_id`, `lookup_source`, `found`, optional `continuity_state`, optional `work_session_id`, optional `session_path`, optional `current_path`, optional `session`, and warnings. `session` is returned for active or blocked continuity and explicit-id history, but omitted for completed current-pointer history.

For current-pointer reads, `continuity_state` is `active`, `blocked`, or `completed_history`. Active and blocked work return the full session in one call. Completed history returns compact identification metadata without the session payload or historical `next_action`; passing `work_session_id` returns the full historical session. When no current session exists, the tool returns `found: false` with warning `NO_CURRENT_WORK_SESSION`.

### `repo_tree`

Returns repository structure. It reports nested repos and submodules as metadata entries and does not recurse into them by default.

Input: `repo_id`, optional `path`, `max_depth`, `page_size`, `include_files`, `respect_default_excludes`, `include_generated`, `include_dependencies`, `cursor`.
Output: `entries[]` with `path`, `type`, optional `size_bytes`, plus `excluded_summary`, `truncated`, and optional `next_cursor`.
Pass `next_cursor` back unchanged with the same path and filters to resume without rescanning completed subtrees. Older numeric cursors remain accepted for compatibility.
Example:

```json
{ "repo_id": "example-repo", "path": "src", "include_files": true, "max_depth": 2 }
```

### `repo_search`

Searches text files with literal or regex matching. It respects default excludes and skips secret candidates.

Input: `repo_id`, `query`, optional `mode`, `include_globs`, `exclude_globs`, `context_lines`, `max_results`, `cursor`.
Output: `results[]` with `path`, `line`, `column`, `text`, `before`, `after`, plus counts, truncation, cursor, and warnings.
Example:

```json
{ "repo_id": "example-repo", "query": "repo_write_stage_commit", "mode": "literal", "max_results": 20 }
```

### `repo_fetch_file`

Reads one repo-relative file, optionally with line bounds.

Input: `repo_id`, `path`, optional `start_line`, `end_line`, `max_bytes`, `override_default_excludes`.
Output: `path`, optional `language`, `size_bytes`, `sha256`, line metadata, `truncated`, `text`, and warnings.
Example:

```json
{ "repo_id": "example-repo", "path": "src/instructions.ts", "start_line": 1, "end_line": 80 }
```

### `repo_read_many`

Reads bounded explicit paths or glob matches. It enforces file and byte limits and reports skipped files with reasons.

Input: `repo_id`, at least one of `paths` or `include_globs`, optional `exclude_globs`, `max_files`, `max_bytes_per_file`, `max_total_bytes`, `cursor`.
Output: `files[]` using the file-content shape, `skipped[]`, counts, truncation, and optional `next_cursor`.
Example:

```json
{ "repo_id": "example-repo", "paths": ["README.md", "docs/ARCHITECTURE.md"], "max_files": 2 }
```

### `repo_context_map`

Returns content-free repository context for impact analysis and planning. It scans bounded TS/JS/TSX/JSX source files outside dependency and generated folders, extracts conservative local relative import strings, and reports graph and framework signals without returning file contents.

Input: `repo_id`, optional `goal`, optional `focus_paths[]`, optional `max_files`.
Output: `entrypoints[]`, `import_edges[]`, `reverse_dependents[]`, `affected_tests[]`, `generated_paths[]`, `dependency_paths[]`, `route_signals[]`, `component_signals[]`, `framework_signals[]`, `scanned_file_count`, `truncated`, and warnings.
Example:

```json
{
  "repo_id": "example-repo",
  "goal": "Change user billing flow",
  "focus_paths": ["src/billing.ts"],
  "max_files": 80
}
```

Use this before larger edits when ChatGPT needs affected-file or affected-test hints. It is intentionally conservative: dynamic imports, aliases, and non-JS language ownership can be missed.

### `repo_symbol_context`

Returns bounded native TypeScript/JavaScript symbol evidence without changing `repo_context_map` or project files. Queries require at least one exact `symbols[]` name or repo-relative `paths[]` seed. Optional `direction`, `depth`, `max_files`, `max_symbols`, and `max_relations` fields bound call expansion and output.

Output includes definitions, references, imports, exported definition ids, inbound/outbound calls, interface implementations, reverse-dependent paths, affected tests, confidence, truncation, warnings, and cache metadata. The HEAD/worktree-keyed cache under `.chatgpt/index/symbols/**` contains names, repo-relative paths, lines, kinds, and relation ids only—never source text, snippets, prompts, command output, secrets, or absolute paths.

When the optional Codebase Memory provider is configured and its `list_projects` result contains an exact canonical-root match, the response adds bounded graph definitions and call paths under `provider.graph`. Native results remain authoritative and available on every provider error or timeout. If `provider.status` is `index_required`, ChatGPT must ask the user before starting an index.

Ambiguous cross-file names are skipped and lower confidence instead of being guessed. Scanning respects repository boundaries, default excludes, sensitive paths, file/byte limits, and nested repositories. It does not run a shell, language server, build, or test.

### `repo_code_index`

Manages the optional Codebase Memory index without exposing a command runner. Input is only `repo_id` plus `action: "start" | "status"`. `start` is allowed only after ChatGPT has explicitly asked the user and received approval. The tool derives the canonical root from the registry, passes that same root as `CBM_ALLOWED_ROOT`, uses the fixed configured executable with no arguments and no shell, and disables repository artifact persistence.

Indexing runs as a deduplicated background job. Poll `action: "status"` until the result is `ready`, `degraded`, or `failed`, then call `repo_symbol_context` again. The tool never writes project files or Git state.

### `repo_failure_diagnose`

Normalizes saved validation evidence for TypeScript, ESLint, Vitest/Jest, pytest, Node, and Python failures. It correlates diagnostic locations with current changed paths, current work-session/latest-write paths, symbol definitions, call/reference expansion, reverse dependents, and affected tests.

Input: `repo_id`, optional `validation_id` (otherwise latest), optional `scope_paths[]`, `max_diagnostics`, and `max_candidates`.

Output separates normalized `diagnostics[]`, concrete `evidence[]`, deterministic `heuristics[]`, confidence, symbols, affected tests, and recommended checks. Safe next-tool payloads may target one file, call `repo_symbol_context`, or propose focused `repo_validate` only when repository operations policy enables validation and every proposed test matches `validation_test_path_globs`.

The tool is read-only, runs no commands, does not mutate source or Git, bounds and redacts artifact text, rejects outside-root diagnostic paths, and does not claim an LLM-generated root cause. ChatGPT remains responsible for interpreting the returned evidence.

### `repo_semantic_review`

Reviews current tracked diff evidence for exported-contract, API/schema, migration, authorization, configuration, async-error, and regression-test risks. Optional `paths[]`, `categories[]`, `max_findings`, and `max_files` fields bound scope. The service correlates bounded staged/unstaged diffs with `repo_symbol_context`, reverse dependents, affected tests, and latest validation status without modifying `repo_git_review`.

Each finding includes category, priority, confidence, path/line, concrete evidence, affected symbols, related paths, and one recommended check. Findings are deterministic rules rather than LLM opinions. Pure file renames and comment-only changes do not create test-gap findings, duplicate findings are removed, and low-confidence signals are explicitly marked.

`ship_readiness` is advisory: only high-priority, high-confidence findings become semantic blockers. A failed saved validation also produces `review_required` and a safe `repo_failure_diagnose` payload. The tool never stages, commits, writes source, executes validation, or alters existing Git ship-readiness state.

### `repo_ship_review`

Provides one bounded pre-ship call by composing `repo_git_review` and `repo_semantic_review`, then running `repo_failure_diagnose` only when the latest validation failed. Input accepts `repo_id`, optional `detail: "compact" | "full"`, and the same optional `paths[]`, semantic `categories[]`, `max_findings`, and `max_files` bounds as semantic review.

Compact output is the default. It preserves nested Git and semantic evidence, optional failure diagnosis, and aggregate `ship_readiness`, but removes duplicated top-level gate/review-loop data and exposes only a canonical actual `repo_write_stage_commit` or staged-only `repo_write_commit` payload when ready. Full output retains the top-level gate, static review-loop guidance, and granular compatibility payloads. Missing, stale, failed, or focused validation, semantic blockers, high Git-review risk, blocked gates, or absence of a safe canonical ship payload produce `review_required`. The tool itself is read-only and never validates, writes, stages, or commits.

### `repo_git_status`

Returns branch, head SHA, clean flag, file statuses, and status counts.

Input: `repo_id`.
Output: `branch`, `head_sha`, `clean`, `counts`, and `files[]` with `path`, optional `original_path`, `index`, and `worktree`.
Example:

```json
{ "repo_id": "example-repo" }
```

### `repo_git_diff`

Returns a bounded read-only git diff with files and hunks. Prefer this before full file reads when reviewing changes. The first call should pass only `repo_id`; optional fields are second-pass refinements when the default diff is truncated, too broad, or the user asks for a specific comparison.

Input: `repo_id`, optional `base`, `compare`, `staged`, `unstaged`, `paths`, `max_bytes`, `context_lines`.
Output: selected diff options, `files[]` with paths/status/hunks, `truncated`, and warnings.
Example:

```json
{ "repo_id": "example-repo" }
```

Second-pass refinement example:

```json
{ "repo_id": "example-repo", "paths": ["src/tools/descriptions.ts"], "context_lines": 5 }
```

### `repo_git_review`

Returns a read-only current-change review for recovery, stage, and local-commit planning. It gathers Git status, bounded diff summary, changed paths, recommendations, validation state, delegation gate, warnings, and safe next actions. Safe untracked source, test, and documentation files may be stageable; secrets, generated/cache/dependency paths, local agent artifacts, deletes, and renames remain excluded. It never mutates files or Git.

Input: `repo_id`, optional `detail: "compact" | "full"`, `paths[]`, `mode`, and `max_files`.
Output: `detail`, `branch`, `head_sha`, `clean`, `changed_paths[]`, `diff_summary`, `recommendation`, `delegation_gate`, `ship_readiness`, and `next_tool_payloads`.

Compact is the public default. Its `next_tool_payloads` contains only canonical actual operations when applicable:

- `repo_write_stage_commit` for an unstaged reviewed happy path;
- `repo_write_commit` when the exact reviewed set is already staged;
- `repo_write_recover` as the composite recovery alternative.

Use `detail: "full"` when granular restore, cleanup, unstage, stage, commit-preview, or dry-run payloads are needed. When staged paths exist, warnings and recovery guidance still explain that worktree-only restore is insufficient and composite recovery must explicitly unstage before restore. `paths[]` scopes evidence and generated payloads to exact changed paths. Generated payloads omit optional `reason` by design.

Compact example:

```json
{ "repo_id": "example-repo", "mode": "commit_plan" }
```

Full diagnostic example:

```json
{ "repo_id": "example-repo", "mode": "commit_plan", "detail": "full" }
```

### `repo_write_stage`

Preferred ChatGPT tool for staging only explicit repo-relative paths after verifying the current HEAD. It never accepts broad pathspecs such as `.`, `*`, `-A`, or `--all`, and it does not run a shell.

Input: `repo_id`, `paths[]`, `expected_head_sha`, optional `dry_run`, and `reason`.
Output: `ok`, `dry_run`, `head_sha`, `staged_paths[]`, `skipped[]`, and `warnings`.
Example:

```json
{
  "repo_id": "example-repo",
  "paths": ["docs/WRITE_WORKFLOWS.md", "src/tools/catalog.ts"],
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "dry_run": true,
  "reason": "Preview staging explicit reviewed files"
}
```

### `repo_git_restore_paths`

Restores only explicit repo-relative worktree paths after verifying the current HEAD. It is the Git recovery layer after `repo_write_file` or `repo_write_changes` when the reviewed diff is bad. It uses fixed `git restore -- <paths>` arguments and does not run a shell, unstage, stage, commit, reset, checkout, clean, stash, restore the whole repo, or restore from another source.

Input: `repo_id`, `paths[]`, `expected_head_sha`, optional `dry_run`, and `reason`.
Output: `ok`, `dry_run`, `head_sha`, `restored_paths[]`, `skipped[]`, and `warnings`.
Example:

```json
{
  "repo_id": "example-repo",
  "paths": ["docs/WRITE_WORKFLOWS.md"],
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "dry_run": true,
  "reason": "Preview restoring a bad unstaged write"
}
```

If the path is already staged, use the unstage workflow first, run review again, and then restore the now-unstaged worktree path. This tool restores worktree paths only and does not modify the index.

### `repo_write_unstage`

Preferred ChatGPT tool for unstaging only explicit repo-relative paths after verifying the current HEAD. It uses fixed git arguments and does not run a shell.

Input: `repo_id`, `paths[]`, `expected_head_sha`, optional `dry_run`, and `reason`.
Output: `ok`, `dry_run`, `head_sha`, `unstaged_paths[]`, `skipped[]`, and `warnings`.
Example:

```json
{
  "repo_id": "example-repo",
  "paths": ["docs/WRITE_WORKFLOWS.md"],
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "dry_run": true,
  "reason": "Preview unstaging one explicit file"
}
```

### `repo_write_commit`

Preferred ChatGPT tool for creating a local commit from already staged paths after verifying the current HEAD and the exact staged path list. It does not stage files, commit unstaged changes, or push.

Input: `repo_id`, `message`, `expected_head_sha`, `expected_staged_paths[]`, optional `dry_run`, and `reason`.
Output: `ok`, `dry_run`, `head_before`, optional `head_after`, optional `commit_sha`, `committed_paths[]`, and `warnings`.
Example:

```json
{
  "repo_id": "example-repo",
  "message": "Harden write tool infrastructure",
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "expected_staged_paths": ["docs/WRITE_WORKFLOWS.md", "src/tools/catalog.ts"],
  "dry_run": true,
  "reason": "Preview local commit from reviewed staged files"
}
```

### `repo_write_stage_commit`

Stages explicit reviewed repo-relative paths and creates one local commit in a single approved operation. It requires `expected_head_sha`, explicit `paths[]`, and a local commit `message`. It rejects broad pathspecs, unsafe paths, invalid messages, stale HEAD, and any pre-existing staged paths that do not exactly match the requested paths. It verifies the exact staged path set before committing. It does not push, reset, checkout, stash, clean, or run a shell.

Use this for the normal happy path after `repo_git_review` when the reviewed diff is good:

```text
repo_git_review
repo_write_stage_commit
```

Input: `repo_id`, `paths[]`, `message`, `expected_head_sha`, optional `dry_run`, and `reason`.
Output: `ok`, `dry_run`, `head_before`, optional `head_after`, optional `commit_sha`, `staged_paths[]`, `committed_paths[]`, optional `remaining_changes`, optional `clean_after`, and `warnings`.
Example:

```json
{
  "repo_id": "example-repo",
  "paths": ["docs/WRITE_WORKFLOWS.md", "src/tools/catalog.ts"],
  "message": "Update write workflow docs",
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "dry_run": true
}
```

### `repo_write_recover`

Runs one reviewed recovery sequence for explicit repo-relative paths. It requires `expected_head_sha` and at least one of `unstage_paths[]`, `restore_paths[]`, `cleanup_paths[]`, or `discard_paths[]`. It validates operation policy and explicit paths before mutating. Actual recovery runs in this order: unstage explicit `unstage_paths`, restore explicit tracked worktree `restore_paths`, delete explicit generated artifacts in `cleanup_paths` through cleanup policy, then delete reviewed safe untracked files in `discard_paths`.

Use this for the normal recovery path after `repo_git_review` when the reviewed diff is bad:

```text
repo_git_review
repo_write_recover
```

Input: `repo_id`, `expected_head_sha`, optional `unstage_paths[]`, optional `restore_paths[]`, optional `cleanup_paths[]`, optional `discard_paths[]`, optional `dry_run`, and `reason`.
Output: `ok`, `dry_run`, `head_sha`, `unstaged_paths[]`, `restored_paths[]`, `deleted[]`, `discarded[]`, `skipped[]`, optional `remaining_changes`, optional `clean_after`, and `warnings`.

`repo_write_recover` does not discover paths internally, restore all, run `git clean`, reset, checkout, stash, commit, push, or run shell commands. Low-level recovery tools remain available for granular workflows.

Example:

```json
{
  "repo_id": "example-repo",
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "unstage_paths": ["docs/WRITE_WORKFLOWS.md"],
  "restore_paths": ["docs/WRITE_WORKFLOWS.md"],
  "cleanup_paths": [".chatgpt/tool-tests/session-smoke.md"],
  "dry_run": true
}
```

### `repo_cleanup_paths`

Deletes explicitly listed repo-relative generated or local ChatGPT artifacts only when they match the configured cleanup policy and are not tracked by Git. Default cleanup globs include local Codex run artifacts under `.chatgpt/codex-runs/**`. It uses Node filesystem APIs, never shell commands, and does not run `rm -rf` or `git clean`.

Input: `repo_id`, `paths[]`, optional `dry_run`, and `reason`.
Output: `ok`, `dry_run`, `deleted[]` with `path` and `type`, `skipped[]`, and `warnings`.
Example:

```json
{
  "repo_id": "example-repo",
  "paths": [".chatgpt/audits/2026-06-02-write-handoff-runtime-smoke.md"],
  "dry_run": true,
  "reason": "Preview cleanup of an untracked ChatGPT audit artifact"
}
```

Tracked files are refused even if they match `cleanup_allowed_globs`; use normal write/review workflows for tracked public files.

### `repo_project_brief`

Returns a bounded project overview for onboarding and planning without reading the whole repository.

Input: `repo_id`, optional `include` with `package`, `readme`, `architecture`, `scripts`, `recent_git`, `todos`.
Output: repo identity, authoritative `product_brief`, project type, languages, package managers, scripts, key docs, likely entrypoints, structured entrypoint signals, framework signals, test commands, `truncated`, and warnings. A configured `product_brief` includes a compact `delegation_checkpoint` derived from validated root-run and product-review history; it never contains the full drift summary or an implementation recommendation.
Example:

```json
{ "repo_id": "example-repo", "include": ["package", "readme", "scripts", "todos"] }
```

### `repo_task_inventory`

Returns repo-local TODOs, FIXMEs, HACKs, roadmap notes, and markdown checklist items.

Input: `repo_id`, optional `include_globs`, `exclude_globs`, `labels`, `max_results`, `cursor`.
Output: `tasks[]` with path/line/kind/text, counts, `scanned_file_count`, `scan_complete`, task-result pagination fields, and warnings.
Example:

```json
{ "repo_id": "example-repo", "labels": ["todo", "roadmap"], "max_results": 25 }
```

### `repo_decision_memory`

Returns bounded, evidence-grounded project memory, architecture decisions, conventions, rationale, and gaps from selected repo sources.

Input: `repo_id`, optional `include_sources` with `docs`, `readme`, `agents`, `comments`, `package`.
Output: `decisions[]`, `conventions[]`, `gaps[]`, and warnings. Evidence uses repo-relative paths and optional lines or quotes.
Example:

```json
{ "repo_id": "example-repo", "include_sources": ["docs", "readme", "agents"] }
```

### `repo_change_plan`

Returns a read-only implementation plan for a repo-local goal.

Input: `repo_id`, `goal`, optional `include_globs`, `max_files_to_inspect`, `planning_depth`.
Output: goal, relevant files, ordered proposed steps, test strategy, open questions, estimated cost, `scan_complete`, and warnings.
Example:

```json
{ "repo_id": "example-repo", "goal": "Add validation for config limits", "planning_depth": "standard" }
```

### `repo_prepare_codex_task`

Validates and previews a strict Delegation v3 root or lineage child without writing files. Use it only when the user explicitly wants a delegation preview. Direct ChatGPT implementation remains the default for normal implementation requests.

Input requires `repo_id`, `title`, `task_kind`, a bounded `assignment`, the beneficiary/current-problem/desired-outcome/why-now frame, kind-specific product, technical, or security context, advisory `starting_points[]`, `authorization_scope[]`, separate preservation and exclusion contracts, and `technical_acceptance_criteria[]`. Product tasks also require repository-backed product alignment and product acceptance criteria. Optional structured validation accepts only allowlisted profiles.

Output is compact audit and artifact metadata: run identity, task kind, review requirement, prompt/manifest/result/gate paths, product-contract hash when applicable, lineage summary, delegation audit, and warnings. It does not return prompt prose, write files, run an agent, stage, commit, or push.

### `repo_write_codex_task`

Writes a strict Delegation v3 task under `.chatgpt/codex-runs/<run_id>/` after validating the same contract as `repo_prepare_codex_task`. It creates `PROMPT.md`, schema-v3 `run.json`, and server-owned `review-gate.json`; the agent must write strict `RESULT.json`.

Input is the v3 task contract plus optional `dry_run` and audit `reason`. `runner.mode` may be `manual` or `queued`; writing a queued handoff never starts or resumes the runner. Output is compact artifact and audit metadata plus `written_paths[]` and safe next-tool payloads. It never stages, commits, pushes, or accepts arbitrary commands.

### `repo_agent_runs`

Lists newest-first content-light run metadata or reads one selected run with bounded redacted events and current structured questions. It exposes lifecycle status and runtime budget without prompt text, result text, source content, raw logs, environment values, or provider thread ids. It never starts, resumes, cancels, or otherwise controls a runner.

List mode additionally returns repository-wide `drift_summary`, independent of pagination and lifecycle-status filters. The summary scans at most the latest 250 validated Delegation v3 runs and reports bounded counts, trends, repeated changed areas, failed product reviews, signal codes, and checkpoint status. Invalid artifacts are skipped with bounded warnings. Detail mode remains specific to one run and does not return the repository-wide summary.

Drift evidence is advisory. The output deliberately has no recommendation, priority, next action, implementation plan, or mutation payload.

### `repo_write_agent_reply`

Writes a bounded reply artifact for the exact current `awaiting_input` turn returned by `repo_agent_runs`. It requires the run id, turn index, expected question hash, and one answer for every current question id. It rejects stale or duplicate replies and cannot accept commands, model configuration, environment values, or scope changes.

### `repo_codex_review`

Reviews a completed agent run without mutation. Delegation v3 requires strict `RESULT.json`; historical v1/v2 runs retain isolated legacy review behavior. The service verifies prompt and manifest integrity, Git baseline, effective authorization, connected-change attribution, exact changed-file evidence, TAC/PAC correlation, validation evidence, lineage, deterministic technical readiness, product-review requirement, and a bounded product evidence pack.

Agent-reported PAC evidence never self-approves product work. Before a valid attestation, v3 review exposes no direct stage or commit path. A blocked or failed review may return a complete bounded corrective or scope-amendment task payload.

### `repo_write_codex_review`

Writes the state-bound qualitative review attestation after `repo_codex_review` returns passed technical readiness and an available review-state hash. Product-required runs accept `passed` or `failed` with exactly one bounded judgment per PAC. Technical-only runs accept `not_applicable` with a rationale and no PAC evidence.

The server reruns review, rejects stale or tampered state, validates or backfills the exact review gate, and writes a hash-bound secret-safe `review.json`. A product FAIL is durable and keeps ship blocked. A valid passing or technical-only attestation makes a run-bound `repo_ship_review` payload available; it does not stage, commit, or push.

### `repo_write_file`

Writes or precisely edits one repo-relative UTF-8 text file under the configured write policy. It does not run shell commands, execute Codex, or perform git add/commit/push.

This is the generic single-file writer for docs, notes, prompts, and focused code edits. It is not the ChatGPT handoff tool; handoff and resume-context intent should use `repo_write_handoff`.

Input: `repo_id`, `path`, optional `action` (`write`, `replace`, `append`, `prepend`, `insert_before`, `insert_after`), optional `content`, optional `find`, optional `replace`, optional `create_dirs`, `dry_run`, `expected_old_sha256`, `expected_missing`, `expected_head_sha`, and `reason`.
Output: `ok`, `path`, `action`, `dry_run`, `changed`, `created`, `bytes_written`, optional `old_sha256`, optional `new_sha256`, `summary`, and `warnings`.
Workflow details: [WRITE_WORKFLOWS.md](WRITE_WORKFLOWS.md).
Example:

```json
{
  "repo_id": "example-repo",
  "path": "docs/notes.md",
  "content": "# Notes\n",
  "dry_run": true,
  "reason": "Preview a documentation note before writing"
}
```

### `repo_write_changes`

Applies an ordered atomic edit pack across allowed repo files. Prefer full-file `write` when complete final content is available. Use grouped `edit` when several exact-match edits must be applied to the same existing file.

Input change types include the existing one-file operations `write`, `replace`, `append`, `prepend`, `insert_before`, and `insert_after`. A grouped same-file edit uses:

```json
{
  "type": "edit",
  "path": "src/app.ts",
  "edits": [
    { "type": "replace", "find": "const enabled = false;", "replace": "const enabled = true;" },
    { "type": "insert_before", "find": "export function run() {", "content": "const started = true;\n" },
    { "type": "insert_after", "find": "export function run() {", "content": "\n  console.log('running');" }
  ]
}
```

Grouped edits are exact-match only. The target must be an existing UTF-8 text file, nested edits are applied in order in memory, every `find` must appear exactly once at that edit's turn, and the file is written once only if all nested edits pass. Top-level duplicate path rejection still applies.

Every change is fully validated before the first write. If a later filesystem operation fails, previously written paths are restored to their original content or removed when they were newly created. An incomplete rollback returns only safe affected-path diagnostics and directs recovery through the canonical `repo_write_recover` payload from `repo_git_review`. A process crash or external filesystem failure during rollback cannot be made transactionally atomic by the operating system.

Full-file `write` creates missing files or overwrites existing files and is the recommended main path when complete final content is available. Exact-match edit operations use the same single-match semantics as `repo_write_file`. The tool does not stage, commit, run shell commands, or execute Codex; review the resulting worktree with `repo_git_review`.

Each change may include `expected_old_sha256` to require that an existing file still has the SHA-256 value the caller read, or `expected_missing` to require that a creation target is still absent. The edit pack may include `expected_head_sha` to require the current Git HEAD to match before applying. Stale preconditions fail before the pack writes files and return safe diagnostics for rereading the affected path or HEAD.

Input: `repo_id`, `changes`, optional `dry_run`, and optional `reason`. Each change has `type` (`write`, `replace`, `append`, `prepend`, `insert_before`, or `insert_after`), `path`, and the operation-specific `content`, `find`, or `replace` fields.
Output: `ok`, `dry_run`, `changed_paths`, `files`, `counts`, `summary`, `warnings`, `next_steps`, and optional `operation_receipt`.
Workflow details: [WRITE_WORKFLOWS.md](WRITE_WORKFLOWS.md).
Example:

```json
{
  "repo_id": "example-repo",
  "changes": [
    {
      "type": "write",
      "path": "docs/notes.md",
      "content": "# Notes\n"
    },
    {
      "type": "replace",
      "path": "docs/ARCHITECTURE.md",
      "find": "old phrase",
      "replace": "new phrase"
    }
  ],
  "dry_run": true,
  "reason": "Preview a coherent docs edit pack"
}
```

### `repo_write_handoff`

Creates a local-only ChatGPT session handoff under `.chatgpt/handoffs/` and updates `.chatgpt/handoffs/current.local.md`. Use this when the user asks for handoff or resume context: "skapa handoff", "create handoff", "skriv handoff", "session handoff", "resume note", "fortsättningsanteckning", "ny chatt context", "överlämning till nästa chatt", or similar private resume-context language.

Input: `repo_id`, `title`, `current_state`, `why`, `next_steps[]`, optional `current_track`, `completed_work`, `decisions`, `workflow`, `constraints`, `important_files`, `risks`, `open_questions`, `update_current`, and `dry_run`.

Output: `ok`, `dry_run`, `handoff_path`, optional `current_path`, `updated_current`, `branch`, `head_sha`, `clean`, `startup_prompt`, `current_next_step`, and `warnings`.

The tool is mutating but local-only. It writes `.chatgpt/handoffs/YYYY-MM-DD-HHmm-<slug>.local.md` and, unless `update_current` is false, `.chatgpt/handoffs/current.local.md`. It requires repo write opt-in and enforces path policy, `.local.md`, write policy, and secret/content checks through the same write layer as other write tools.

`repo_write_handoff` does not stage, commit, push, reset, checkout, restore, stash, clean, run shell commands, or execute Codex. Handoff files are private working context and normally should not be committed.

Do not use `repo_write_file` or `repo_write_changes` for this workflow when `repo_write_handoff` is available. Public documentation, release notes, audit records, and durable project knowledge belong in normal docs/write workflows instead.

Workflow details: [WRITE_WORKFLOWS.md](WRITE_WORKFLOWS.md).
Example:

```json
{
  "repo_id": "example-repo",
  "title": "Write Tools v2 handoff",
  "current_state": "Tool wiring is complete and docs are being updated.",
  "why": "The next ChatGPT session needs compact resume context.",
  "next_steps": [
    {
      "title": "Runtime smoke repo_write_handoff",
      "goal": "Verify handoff creation through MCP",
      "done_when": "The smoke creates a detailed .local.md handoff and current.local.md"
    }
  ],
  "important_files": ["src/tools/handlers.ts", "docs/WRITE_WORKFLOWS.md"]
}
```

## Recommended Workflows

### Canonical direct-development path

1. Use `repo_project_brief` when repository or product context is needed, or `repo_current_work_session` when resuming; continue its direction only for active or blocked continuity, not completed history.
2. Locate code with `repo_search`; read only selected paths through `repo_fetch_file` or bounded `repo_read_many`.
3. Use `repo_context_map` or `repo_symbol_context` only when impact, dependents, symbols, or affected tests are uncertain.
4. Implement with `repo_write_file` or `repo_write_changes`.
5. Run the relevant allowlisted `repo_validate` profile.
6. Use `repo_ship_review` for bounded readiness or `repo_git_review` for Git/recovery planning.
7. Execute the exact review-provided `repo_write_stage_commit` payload when ready, or `repo_write_recover` when the change should be reversed.

Do not insert task inventory, decision memory, patchsets, delegation, standalone semantic review, failure diagnosis, code indexing, or granular Git operations unless their distinct capability is required.

### Explicit planning and discovery

- Call `repo_change_plan` only after the user and ChatGPT have chosen the goal.
- Call `repo_task_inventory` only for explicit TODO, roadmap, checklist, or backlog discovery.
- Call `repo_decision_memory` only for historical architecture decisions and conventions.
- Start broad review with `repo_project_brief`, then narrow through tree/search and bounded reads.

### Specialist mutation paths

- Use patchsets when atomic prepare/apply/review/rollback semantics materially improve a complex multi-file operation.
- Use granular `repo_write_stage`, `repo_write_unstage`, `repo_write_commit`, `repo_git_restore_paths`, or `repo_cleanup_paths` only for staged-only, stepwise recovery, troubleshooting, or missing composite payloads.
- Use `repo_failure_diagnose` after a real saved validation failure, and standalone `repo_semantic_review` only when semantic evidence is needed without the full ship review.

### Multi-run integration

Use this only after the owner has selected multiple related v3 runs for one worktree integration:

1. Complete `repo_codex_review` and `repo_write_codex_review` for every run.
2. Run a current non-focused `repo_validate` with profile `all`.
3. Call `repo_write_integration_review` with the exact run ids, validation id, HEAD, and intended commit message.
4. Use its `repo_write_stage_commit` payload containing only `review_pathset_id`.

The integration review fails when any current project path is outside the selected reviewed union, any product verdict failed, semantic evidence is truncated or blocking, validation is stale, or bytes/HEAD changed. The token cannot be expanded by the client.

### Delegation v3

1. Delegate only when the user explicitly asks for an implementation agent.
2. Preview with `repo_prepare_codex_task` when needed, or write the durable task with `repo_write_codex_task`.
3. Observe through `repo_agent_runs` and answer structured questions through `repo_write_agent_reply` when required.
4. After completion, call `repo_codex_review`.
5. Record the state-bound product or technical-only verdict with `repo_write_codex_review`.
6. Use the returned run-bound `repo_ship_review` payload, then the exact stage-commit or recovery payload.

### ChatGPT handoff

Run `repo_git_status`, review relevant dirty state when needed, summarize the session into structured fields, and call `repo_write_handoff`. Keep generated `.local.md` files local-only.

## MCP Inspector

Run the local server against a config file:

```bash
GPT_REPO_CONFIG=./config.local.json npm run dev
```

In another shell, inspect the Streamable HTTP endpoint:

```bash
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

Verify these contract points in Inspector:

- `initialize` returns server instructions and the `tools` capability.
- `tools/list` shows every tool with `inputSchema`, `outputSchema`, and the expected read or mutating annotations.
- Representative tool calls return repository data in `structuredContent`.
- Representative error calls return the standard error envelope without leaking absolute paths or secrets.
