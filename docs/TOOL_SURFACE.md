# Tool Surface

Tools are closed-world repository tools. Read tools are read-only and idempotent.
Mutating tools use separate write annotations and are disabled per repo unless
the relevant repo policy opts in. Each tool declares an input schema, an output
schema, and annotations. Runtime results return canonical data in
`structuredContent` and a short human summary in `content`.

For ChatGPT workflows, prefer `repo_write_stage_commit` for normal reviewed
stage-and-commit flows and `repo_write_recover` for normal reviewed recovery
flows. Use `repo_write_stage`, `repo_write_unstage`, `repo_git_restore_paths`,
`repo_cleanup_paths`, and `repo_write_commit` when granular control is needed.
`repo_git_stage`, `repo_git_unstage`, and `repo_git_commit` remain available as
compatibility aliases with the same contracts and safety checks.

## Approval Behavior

ChatGPT clients should show tool payloads and request confirmation before
calling mutating tools. For mutating workflows, inspect status, diff, or file
context first; then request explicit user approval for the actual mutation.
`dry_run` is a preview option for user-requested previews, unclear risk,
new-tool testing, or unusual state. For review-provided actual composite
payloads after explicit approval, call the actual composite tool directly.
`repo_git_review` generated next-tool payloads intentionally omit optional
`reason` fields to keep host/client approval payloads small and stable. ChatGPT
or the user may add a short `reason` manually when it adds meaningful audit
context.

If a client blocks a composite mutating call before showing an approval prompt,
use the review-provided granular fallback payloads. For commit flows, stage with
`repo_write_stage`, then commit with `repo_write_commit`; use the compatibility
alias `repo_git_commit` only if needed. That can indicate client-level
pre-approval safety behavior rather than a server policy failure.

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
      "applied_paths": ["docs/example.md"],
      "failed_path": "src/example.ts",
      "recovery_hint": "Run repo_git_review, then use repo_git_restore_paths for tracked applied paths or repo_cleanup_paths for generated untracked artifacts."
    }
  }
}
```

`error.diagnostics` is optional and allowlisted. It may expose safe metadata such as repo-relative paths, stable recovery hints, or HEAD SHAs, but never file contents, raw diffs, secrets, stack traces, absolute paths, environment values, or raw command output.

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

Reads the repo-local last-write receipt from `.chatgpt/operations/last-write.json`. The receipt is local runtime state written after successful actual changed `repo_write_file` or `repo_write_changes` calls. It contains safe metadata only: repo-relative paths, counts, timestamps, best-effort HEAD SHAs, and a content-free summary.

Input: `repo_id`.
Output: `ok`, `found`, optional `receipt`, `next_tool_payloads`, and `warnings`.
When a receipt is found, `next_tool_payloads.repo_git_review` suggests the read-only review call for current recovery, staging, or commit payloads. When missing, warnings include `NO_LAST_WRITE_RECEIPT`.
Example:

```json
{ "repo_id": "example-repo" }
```

### `repo_tree`

Returns repository structure. It reports nested repos and submodules as metadata entries and does not recurse into them by default.

Input: `repo_id`, optional `path`, `max_depth`, `page_size`, `include_files`, `respect_default_excludes`, `include_generated`, `include_dependencies`, `cursor`.
Output: `entries[]` with `path`, `type`, optional `size_bytes`, plus `excluded_summary`, `truncated`, and optional `next_cursor`.
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
{ "repo_id": "example-repo", "query": "repo_next_action", "mode": "literal", "max_results": 20 }
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

Returns a read-only current-change review for low-friction recovery, cleanup, stage, and commit planning. It gathers git status, the default diff summary, explicit changed paths, conservative stage recommendations, a suggested commit message, warnings, and ready-to-run next tool payloads. It does not restore, clean up, stage, unstage, commit, write files, or run shell commands.

Input: `repo_id`, optional `mode` and `max_files`.
Output: `branch`, `head_sha`, `clean`, `changed_paths[]`, `diff_summary`, `recommendation`, and `next_tool_payloads`.
When staged paths exist, `recommendation.warnings` includes `STAGED_RECOVERY_REQUIRES_UNSTAGE_FIRST` and `recommendation.recovery_guidance[]` explains that `repo_git_restore_paths` is worktree-only. For bad staged changes, use the review-provided `repo_write_recover_*` payloads with explicit `unstage_paths` and `restore_paths`, or use low-level unstage/restore tools when granular control is needed.
`next_tool_payloads` may include composite `repo_write_stage_commit_*` and `repo_write_recover_*` payloads, plus low-level `repo_git_restore_paths_*`, `repo_cleanup_paths_*`, `repo_write_unstage_*`, `repo_write_stage_*`, and `repo_write_commit_dry_run` payloads when applicable. Generated payloads omit optional `reason` fields by design; add a short reason manually only when useful.
Example:

```json
{ "repo_id": "example-repo", "mode": "commit_plan" }
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

### `repo_git_stage`

Compatibility alias for `repo_write_stage`. Stages only explicit repo-relative paths after verifying the current HEAD. It uses fixed git arguments and does not run a shell.

Input: `repo_id`, `paths[]`, `expected_head_sha`, optional `dry_run`, and `reason`.
Output: `ok`, `dry_run`, `head_sha`, `staged_paths[]`, `skipped[]`, and `warnings`.
Example:

```json
{
  "repo_id": "example-repo",
  "paths": ["docs/WRITE_WORKFLOWS.md"],
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "dry_run": true,
  "reason": "Preview staging one explicit file"
}
```

### `repo_git_unstage`

Compatibility alias for `repo_write_unstage`. Unstages only explicit repo-relative paths after verifying the current HEAD. It uses fixed git arguments and does not run a shell.

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

### `repo_git_commit`

Compatibility alias for `repo_write_commit`. Creates a local commit from already staged paths after verifying the current HEAD and the exact staged path list. It does not stage files, commit unstaged changes, or push.

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

Runs one reviewed recovery sequence for explicit repo-relative paths. It requires `expected_head_sha` and at least one of `unstage_paths[]`, `restore_paths[]`, or `cleanup_paths[]`. It validates operation policy and explicit paths before mutating. Actual recovery runs in this order: unstage explicit `unstage_paths`, restore explicit tracked worktree `restore_paths`, then delete explicit generated artifacts in `cleanup_paths` through cleanup policy.

Use this for the normal recovery path after `repo_git_review` when the reviewed diff is bad:

```text
repo_git_review
repo_write_recover
```

Input: `repo_id`, `expected_head_sha`, optional `unstage_paths[]`, optional `restore_paths[]`, optional `cleanup_paths[]`, optional `dry_run`, and `reason`.
Output: `ok`, `dry_run`, `head_sha`, `unstaged_paths[]`, `restored_paths[]`, `deleted[]`, `skipped[]`, optional `remaining_changes`, optional `clean_after`, and `warnings`.

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
Output: repo identity, project type, languages, package managers, scripts, key docs, likely entrypoints, test commands, `truncated`, and warnings.
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

### `repo_next_action`

Returns an advisory next-step recommendation for solo-dev work without running tests or writing files.

Input: `repo_id`, optional `mode` (`ship`, `cleanup`, `plan`, `debug`, `refactor`) and `horizon`.
Output: recommendation, rationale, suggested actions, blockers, useful context, confidence, and warnings.
Example:

```json
{ "repo_id": "example-repo", "mode": "ship", "horizon": "today" }
```

### `repo_plan_review`

Plans broad or ambiguous review requests before expensive repo reading.

Input: `prompt`.
Output: clarifying-question flag, optional suggested question, recommended next tools, recommended scope, estimated cost, and `explicit_full_repo`.
Example:

```json
{ "prompt": "Gör en komplett fullständig analys av hela repo:t" }
```

### `repo_prepare_codex_task`

Renders a Codex-optimized task prompt without writing files. Use this only for chat-copy mode when the user explicitly wants a prompt they can review or copy into Codex. Do not use this for repo-local Codex delegation where Codex will be told to implement `.chatgpt/codex-runs/<run_id>/PROMPT.md`; call `repo_write_codex_task` instead so the file exists before Codex runs. Direct ChatGPT implementation remains the default for normal "fix" or "implement" requests.

Input: `repo_id`, `title`, `objective`, optional `context_summary`, `inspect_first[]`, `allowed_paths[]`, `forbidden_paths[]`, `implementation_scope`, `acceptance_criteria[]`, `verification_commands[]`, and `run_id`.
Output: `run_id`, `prompt_path`, `result_path`, `manifest_path`, `prompt_markdown`, `codex_user_prompt`, `next_steps[]`, and `warnings[]`.
Example:

```json
{
  "repo_id": "example-repo",
  "title": "Fix login expiry",
  "objective": "Read src/auth.ts and fix expired login handling.",
  "inspect_first": ["src/auth.ts", "tests/auth.test.ts"],
  "allowed_paths": ["src/auth.ts", "tests/auth.test.ts"],
  "verification_commands": ["npm test -- tests/auth.test.ts"]
}
```

### `repo_write_codex_task`

Writes a repo-local Codex task prompt under `.chatgpt/codex-runs/<run_id>/`. Use this by default for repo-local Codex delegation, start/resume flows, or any handoff where Codex will receive `Implement .chatgpt/codex-runs/<run_id>/PROMPT.md`. It writes only `PROMPT.md` and `run.json` through the normal write policy. It does not implement code, run Codex, stage, commit, push, or execute shell commands.

Input: same task fields as `repo_prepare_codex_task`, plus optional `dry_run` and `reason`.
Output: all prepare fields plus `dry_run` and `written_paths[]`.

After this tool, give Codex the returned `codex_user_prompt`, for example `Implement .chatgpt/codex-runs/<run_id>/PROMPT.md`. The prompt's completion contract tells Codex to write `.chatgpt/codex-runs/<run_id>/RESULT.md` before its final chat response.
Example:

```json
{
  "repo_id": "example-repo",
  "title": "Fix login expiry",
  "objective": "Read src/auth.ts and fix expired login handling.",
  "inspect_first": ["src/auth.ts"],
  "allowed_paths": ["src/**", "tests/**"]
}
```

### `repo_codex_review`

Reads `.chatgpt/codex-runs/<run_id>/RESULT.md` and the current git diff review state. Use this after Codex finishes a repo-local Codex run. It is read-only and returns the parsed Codex result plus the same review payload style used by `repo_git_review`.

Input: `repo_id`, `run_id`, optional `max_files`.
Output: `result_found`, optional `codex_result`, optional `git_review`, optional `next_tool_payloads`, `next_steps[]`, and `warnings[]`.

If `RESULT.md` is missing, the tool returns `CODEX_RESULT_MISSING` and asks the user to paste Codex output or rerun Codex with the prompt completion contract.
Example:

```json
{
  "repo_id": "example-repo",
  "run_id": "2026-06-04T081500Z-fix-login-expiry"
}
```

### `repo_write_file`

Writes or precisely edits one repo-relative UTF-8 text file under the configured write policy. It does not run shell commands, execute Codex, or perform git add/commit/push.

This is the generic single-file writer for docs, notes, prompts, and focused code edits. It is not the ChatGPT handoff tool; handoff and resume-context intent should use `repo_write_handoff`.

Input: `repo_id`, `path`, optional `action` (`write`, `replace`, `append`, `prepend`, `insert_before`, `insert_after`), optional `content`, optional `find`, optional `replace`, optional `create_dirs`, `dry_run`, and `reason`.
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

Applies an ordered edit pack across allowed repo files. Prefer full-file `write` when complete final content is available. Use grouped `edit` when several exact-match edits must be applied to the same existing file.

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

Applies an ordered multi-file edit pack under the configured write policy. Full-file `write` creates missing files or overwrites existing files and is the recommended main path when complete final content is available. Exact-match edit operations use the same single-match semantics as `repo_write_file`. The tool does not stage, commit, restore, run shell commands, or execute Codex; review the resulting worktree with `repo_git_review`.

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

Project onboarding:

1. `repo_list_roots` if the target repo is unknown.
2. `repo_project_brief` for project type, scripts, docs, entrypoints, and test commands.
3. `repo_tree` or `repo_search` for focused drilldown.
4. `repo_fetch_file` or bounded `repo_read_many` for selected files only.

Choose next work:

1. `repo_project_brief` to establish project context.
2. `repo_task_inventory` to find repo-local backlog signals.
3. `repo_next_action` to recommend focused next work from project, task, and git signals.

Project memory:

1. `repo_decision_memory` for evidence-grounded decisions, conventions, patterns, and gaps.
2. `repo_fetch_file`, `repo_search`, or bounded `repo_read_many` for evidence drilldown when needed.

Plan a change:

1. `repo_decision_memory` when conventions or architecture decisions may constrain the change.
2. `repo_change_plan` for an implementation, refactor, debug, or feature plan.
3. `repo_search`, `repo_fetch_file`, or bounded `repo_read_many` for focused drilldown.

Ship/current changes:

1. `repo_git_review` with `{ "repo_id": "..." }` for current status, diff summary, risks, and next dry-run or actual payloads.
2. `repo_git_diff` with only `{ "repo_id": "..." }` only when raw diff hunks need direct inspection.
3. `repo_next_action` with ship-oriented prompting when choosing readiness or next cleanup.

Stage and commit reviewed changes:

1. `repo_git_review` to get explicit changed paths, recommendations, HEAD, and dry-run payloads.
2. `repo_write_stage_commit` with the review-provided actual payload after approval. Use dry-run only when preview is requested or risk is unclear.
3. If the client blocks the composite call, use the review-provided granular payloads: `repo_write_stage`, then `repo_write_commit`. Use `repo_git_commit` only as a compatibility fallback when needed.

Recover bad reviewed changes:

1. `repo_git_review` to identify tracked restore paths, staged paths that need unstaging, and cleanup-eligible generated files.
2. `repo_write_recover` with the review-provided actual payload after approval. Use dry-run only when preview is requested or risk is unclear.
3. Use granular `repo_write_unstage`, `repo_git_restore_paths`, or `repo_cleanup_paths` only when step-by-step control is needed.

Broad review:

1. `repo_plan_review` for broad or ambiguous requests.
2. For explicit full-repo review, follow staged project brief, task inventory, decision memory, tree/search, then bounded read batches.

Write one file:

1. Use read tools to inspect the target path when editing existing content.
2. Call `repo_write_file` with `dry_run: true` for policy validation when useful.
3. Call `repo_write_file` without `dry_run` only for a single intended file write.

Apply a multi-file edit pack:

1. Prefer full-file `write` changes when complete final file content is available.
2. Use exact-match edit changes only when the anchor is unambiguous.
3. Call `repo_write_changes` with `dry_run: true` when preview is useful, or call it directly when the edit pack is approved.
4. Call `repo_git_review` to inspect the resulting diff and get recovery, cleanup, stage, unstage, and commit payloads.
5. If the edit pack is wrong, recover with explicit paths through `repo_write_recover`.
6. If the diff is good, stage and commit with the review-provided `repo_write_stage_commit` payload.
7. If a composite commit call is blocked by the client, stage with `repo_write_stage`, then commit with `repo_write_commit`.

Delegate to Codex:

1. Use direct write tools by default for normal ChatGPT implementation requests.
2. When the user explicitly asks for Codex delegation, call `repo_write_codex_task` for repo-local mode by default; use `repo_prepare_codex_task` only for chat-copy prompt review/copying.
3. Give Codex the returned `codex_user_prompt`.
4. After Codex finishes, call `repo_codex_review` with the returned `run_id`.
5. Review `codex_result` and `git_review`, then use review-provided commit or recovery payloads after user approval.

Create a ChatGPT handoff:

1. Run `repo_git_status`.
2. Run `repo_git_review` when dirty state or current changes matter to the next session.
3. Summarize the session into structured fields.
4. Call `repo_write_handoff`.
5. Leave `.chatgpt/handoffs/*.local.md` and `current.local.md` local-only.

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
