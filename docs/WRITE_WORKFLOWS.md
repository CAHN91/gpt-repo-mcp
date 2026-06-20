# Write Workflows

`repo_write_file` is the primary low-friction single-file writer/editor for approved repositories. Use it for Codex prompts, docs, notes, and precise one-file code edits.

`repo_write_changes` is the low-friction multi-file writer and edit-pack applier. Use it when ChatGPT has a coherent set of file writes or exact-match edits and the next step should be a Git diff review.

`repo_write_handoff` is the dedicated handoff tool. Handoff and resume-context intent should route there, not to generic file or edit-pack writes.

Writes are disabled by default. A repository must opt in through `config.local.json`, and every request still has to pass path, glob, size, secret-candidate, sandbox, unsupported-file-type, and resulting-content secret checks.

## Enable Writes

Copy `config.example.json` to `config.local.json` to create a valid empty starter config, then add repositories and opt in only where writes are intended:

```bash
cp config.example.json config.local.json
```

For normal local setup, prefer the CLI modes:

```bash
npm run add -- /path/to/repo --mode read
npm run add -- /path/to/repo --mode write
npm run add -- /path/to/repo --mode ship
```

- `read` keeps writes and operations disabled.
- `write` enables broad repo-local writes guarded by hard denied paths, secret checks, path sandboxing, resulting-content secret scans, and size limits.
- `ship` uses write mode and also enables local git stage, commit, recover, and cleanup operations.

`write` and `ship` use the same write policy. For clone-based solo-dev setup, that policy allows repo-local paths broadly with `allowed_globs: ["**"]` while the hard deny list still blocks `.env*`, private keys, Git internals, root and nested dependency directories, common generated/cache directories, coverage, test results, and virtual environments. The difference is that `ship` also enables the local operation policy for stage, commit, recover, and cleanup.

No mode adds shell execution or push, pull, reset, checkout, switch, rebase, merge, stash, clean, force, or branch deletion tools.

Manual config remains supported. The following is a full policy-shape example for documentation; replace `/absolute/path/to/repo` with a real local repository path before using it:

```json
{
  "repos": [
    {
      "repo_id": "example-repo",
      "display_name": "GPT Repo MCP",
      "root": "/absolute/path/to/repo",
      "writes": {
        "enabled": true,
        "allowed_globs": [
          ".chatgpt/**",
          ".codex/**",
          "docs/**",
          "README.md",
          "CHANGELOG.md",
          "CONTRIBUTING.md",
          "SECURITY.md",
          "CODE_OF_CONDUCT.md",
          "SUPPORT.md",
          "LICENSE",
          ".gitignore"
        ],
        "denied_globs": [
          ".env",
          ".env.local",
          ".env.production",
          ".env.*",
          "**/*.pem",
          "**/*.key",
          ".git/**",
          "node_modules/**",
          "**/node_modules/**",
          "dist/**",
          "**/dist/**",
          "build/**",
          "**/build/**",
          "out/**",
          "**/out/**",
          "coverage/**",
          "**/coverage/**",
          "test-results/**",
          "**/test-results/**",
          "playwright-report/**",
          "**/playwright-report/**",
          ".next/**",
          "**/.next/**",
          ".nuxt/**",
          "**/.nuxt/**",
          ".svelte-kit/**",
          "**/.svelte-kit/**",
          ".astro/**",
          "**/.astro/**",
          ".cache/**",
          "**/.cache/**",
          ".turbo/**",
          "**/.turbo/**",
          ".vercel/**",
          "**/.vercel/**",
          ".venv/**",
          "**/.venv/**",
          "venv/**",
          "**/venv/**"
        ],
        "max_bytes_per_write": 1048576
      }
    }
  ],
  "limits": {
    "max_files": 50,
    "max_bytes_per_file": 128000,
    "max_total_bytes": 750000
  }
}
```

Keep `enabled: false` in shared examples and turn it on only in local config for a specific approved repo.

Exact root public docs (`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `LICENSE`) are allowed by default so ChatGPT can keep public project documentation current after writes are explicitly enabled. The exact `.gitignore` path is also allowed by default as repo metadata so ChatGPT can add local-only ignore rules such as `.chatgpt/backlog/*.local.md`. This is not a general root-write allowance.

The `npm run add -- <path> --mode write` and `--mode ship` shortcuts intentionally use a broader deny-first solo-dev write policy than the schema default. Hard denied globs and secret/content checks still win. The `gpt-repo` binary is available when the package is linked or installed; clone-based setup should use the npm scripts.

Use `repo_policy_explain` when a read, write, or cleanup policy question is blocked unexpectedly. It reports the effective read/write/cleanup policy, matched globs, stable block code, local git operation toggles, and next safe step without reading or mutating files. For stage, commit, or recovery path blockers, use `repo_git_review` plus the specific local operation tool result.

## Actions

`repo_write_file` uses `action`; `repo_write_changes` uses per-change `type`. The available operations are the same. `write` is the recommended main path when ChatGPT can provide complete final file content.

- `write`: create a missing file or overwrite an existing file.
- `append`: append `content` to an existing file.
- `prepend`: prepend `content` to an existing file.
- `replace`: replace `find` with `replace`; `find` must appear exactly once.
- `insert_before`: insert `content` before `find`; `find` must appear exactly once.
- `insert_after`: insert `content` after `find`; `find` must appear exactly once.

For edit actions, the target must be an existing UTF-8 text file. Binary or NUL-byte targets are rejected.

## Preview With Dry Run

Use `dry_run: true` when you want to preview policy, path, size, and resulting content checks before making a real write:

```json
{
  "repo_id": "example-repo",
  "path": "docs/notes.md",
  "content": "# Notes\n",
  "dry_run": true,
  "reason": "Validate documentation note path before writing"
}
```

For normal approved writes, call `repo_write_file` directly and review the resulting worktree with `repo_git_review` afterwards.

For approved multi-file edit packs, call `repo_write_changes` directly and review the resulting worktree with `repo_git_review` afterwards. `dry_run` is useful when you want a preview, but it is not required.

After `repo_git_review`, prefer its composite payloads. Use `repo_write_stage_commit` for reviewed good changes and `repo_write_recover` for reviewed recovery, cleanup, unstage, or restore. Review-generated payloads intentionally omit optional `reason` fields to keep host/client approval payloads small and stable. ChatGPT or the user may add a short `reason` manually when it adds audit value.

Low-level tools remain available for granular control, absent composite payloads, staged-only commits through `repo_write_commit`, specific user-requested operations, or troubleshooting after a composite failure. If a client blocks `repo_write_stage_commit`, use the review-provided `repo_write_stage` payload, then `repo_write_commit`; use the compatibility alias `repo_git_commit` only if needed.

## Codex Task Workflow

Direct implementation is the default when the user asks ChatGPT to fix, implement, update, or edit code. Use Codex task tools only when the user explicitly asks for a Codex prompt, Codex task, delegation to Codex, or a repo-local Codex run.

For repo-local Codex delegation, call `repo_write_codex_task` by default. Use it whenever Codex will receive an instruction like `Implement .chatgpt/codex-runs/<run_id>/PROMPT.md`; it writes the prompt file before Codex runs.

For chat-copy mode, call `repo_prepare_codex_task` only when the user wants to review or copy the prompt in chat. It returns a complete Codex prompt in `prompt_markdown` and does not write files:

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

For repo-local mode, `repo_write_codex_task` writes:

- `.chatgpt/codex-runs/<run_id>/PROMPT.md`
- `.chatgpt/codex-runs/<run_id>/run.json`

Give Codex the returned `codex_user_prompt`, for example:

```text
Implement .chatgpt/codex-runs/<run_id>/PROMPT.md
```

The generated prompt tells Codex to write `.chatgpt/codex-runs/<run_id>/RESULT.md` before its final chat response. After Codex finishes, call `repo_codex_review` with the same `run_id`; it reads `RESULT.md`, runs git review logic, and returns review/recovery/commit next-tool payloads. If `RESULT.md` is missing, ask the user to paste Codex output or rerun Codex with the prompt completion contract.

Codex task files are local ChatGPT working state under `.chatgpt/` and normally should not be committed.

## ChatGPT Handoff Workflow

When the user says "skapa handoff", "create handoff", "skriv handoff", "session handoff", "resume note", "fortsättningsanteckning", "ny chatt context", "överlämning till nästa chatt", or similar private resume-context language, ChatGPT should use `repo_write_handoff`. Do not use generic `repo_write_file` or `repo_write_changes` for this workflow when `repo_write_handoff` is available.

Recommended sequence:

1. Run `repo_git_status`.
2. If the worktree is dirty or changed files affect the next session, run `repo_git_review`.
3. Summarize the session into structured handoff fields.
4. Call `repo_write_handoff`.
5. Treat generated handoff files as local-only working context and do not commit them.

`repo_write_handoff` creates:

- `.chatgpt/handoffs/YYYY-MM-DD-HHmm-<slug>.local.md`
- `.chatgpt/handoffs/current.local.md`

The handoff should be compact, next-step-driven, and useful for restarting work. It should not be a transcript, raw history dump, or public project record. Include dirty-state, recovery notes, commit notes, or review warnings in `current_state`, `risks`, or `next_steps` when that context affects the next session.

Minimal payload:

```json
{
  "repo_id": "example-repo",
  "title": "Write Tools v2 handoff",
  "current_state": "Slice v2.3 is updating instructions and docs so ChatGPT routes private handoff requests to repo_write_handoff.",
  "why": "The next session needs compact local resume context without turning private session notes into public documentation.",
  "completed_work": ["Added repo_write_handoff as the preferred handoff workflow"],
  "workflow": ["Run repo_git_status before handoff", "Run repo_git_review when dirty state matters"],
  "constraints": ["Handoffs are local-only", "Do not commit *.local.md handoff files"],
  "next_steps": [
    {
      "title": "Slice v2.4 - Runtime smoke repo_write_handoff",
      "goal": "Verify the handoff workflow through a live MCP call",
      "done_when": "Runtime smoke proves current.local.md and the detailed .local.md handoff are created safely"
    }
  ],
  "important_files": ["src/instructions.ts", "docs/WRITE_WORKFLOWS.md", "docs/TOOL_SURFACE.md"]
}
```

The MCP server is responsible for local-only path generation, `.local.md` enforcement, `current.local.md`, git metadata, file writing, write policy, and secret/content checks.

If the user explicitly asks for public documentation, durable project knowledge, release notes, or audit notes, do not use the handoff workflow. Use the normal docs/write workflow instead.

## Precise Edit Workflow

Use `replace`, `insert_before`, or `insert_after` when a single exact anchor is safer than rewriting a whole file:

```json
{
  "repo_id": "example-repo",
  "path": "docs/notes.md",
  "action": "replace",
  "find": "old sentence",
  "replace": "new sentence",
  "dry_run": true,
  "reason": "Preview one exact documentation edit"
}
```

The edit fails if `find` is missing or appears more than once. This avoids ambiguous edits.

## Source File Edits

Source file writes are allowed only when the repo write policy allows the target path, for example `src/**`. The default policy allows `.chatgpt/**`, `.codex/**`, `docs/**`, exact root public docs, and exact `.gitignore`, so source edits are rejected unless the user opts in for that repo.

## Multi-File Edit-Pack Workflow

Use `repo_write_changes` when the intended output is a cohesive edit pack across multiple files. Prefer full-file `write` changes when ChatGPT can produce complete final file contents; use `replace`, `insert_before`, and `insert_after` only when an exact anchor is clearer and safer.

```json
{
  "repo_id": "example-repo",
  "changes": [
    {
      "type": "write",
      "path": "docs/feature.md",
      "content": "# Feature\n\nFinal documentation text.\n"
    },
    {
      "type": "replace",
      "path": "src/index.ts",
      "find": "export const enabled = false;",
      "replace": "export const enabled = true;"
    },
    {
      "type": "append",
      "path": "tests/feature.test.ts",
      "content": "\ntest('feature stays enabled', () => {});\n"
    }
  ],
  "reason": "Apply one reviewed feature edit pack"
}
```

Prefer full-file `write` when complete final content is available. Use grouped `edit` when several exact-match edits must be applied to the same existing file without repeating the path in top-level `changes[]`:

```json
{
  "repo_id": "example-repo",
  "changes": [
    {
      "type": "edit",
      "path": "src/app.ts",
      "edits": [
        {
          "type": "replace",
          "find": "const enabled = false;",
          "replace": "const enabled = true;"
        },
        {
          "type": "insert_after",
          "find": "export function run() {",
          "content": "\n  console.log('running');"
        }
      ]
    }
  ],
  "reason": "Apply several exact-match edits to one file"
}
```

Grouped edits read the target file once, apply nested edits in order to in-memory text, and write the file once. Each `find` must appear exactly once at that edit's turn. If any nested edit fails, that file is not written. Repeating the same top-level path in separate `changes[]` entries is still rejected; use one grouped `edit` for same-file exact-match edits.

Recommended sequence:

1. Use read tools to inspect existing files when needed.
2. Call `repo_write_changes` with the complete edit pack.
3. Call `repo_git_review` to inspect changed paths, diff summary, warnings, HEAD, and ready-to-run next tool payloads.
4. If the diff is wrong, use the review-provided `repo_write_recover` payload after approval.
5. Low-level `repo_git_restore_paths`, `repo_cleanup_paths`, and `repo_write_unstage` remain available when granular control is needed.
6. If the diff is good, use the review-provided actual `repo_write_stage_commit` payload after approval. Use dry-run only when preview is requested or risk is unclear.
7. If the client blocks the composite commit call, use review-provided granular fallback payloads: `repo_write_stage`, then `repo_write_commit`. Use `repo_git_commit` only as a compatibility fallback when needed.

`repo_write_changes` does not stage, commit, restore, reset, checkout, or run shell commands. It applies changes sequentially and stops at the first error. Git review and explicit path restore are the safety layer for accepted writes.

If a later edit fails after earlier files were already applied, the error envelope may include safe diagnostics: `applied_paths`, `failed_path`, and `recovery_hint`. These values are repo-relative metadata only. They do not include file contents, raw diffs, snippets, secrets, stack traces, absolute paths, or command output.

Successful actual `repo_write_file` and changed `repo_write_changes` calls save a local last-write receipt at `.chatgpt/operations/last-write.json`. The receipt is safe metadata only: tool name, repo id, timestamp, best-effort HEAD SHAs, touched/changed/created/modified repo-relative paths, counts, and summary. It does not store file contents, snippets, raw diffs, prompts, command output, secrets, or absolute paths. Receipt files are local runtime state and are ignored by Git.

Use `repo_last_write` when returning to a write workflow across ChatGPT turns:

```text
repo_write_changes
repo_last_write
repo_git_review
repo_write_recover if bad
repo_write_stage_commit if good
```

`repo_last_write` is read-only. It does not restore, clean up, stage, unstage, commit, or infer recovery payloads. It points back to `repo_git_review`, which remains the source of current git-state payloads.

Review-generated next-tool payloads omit optional `reason` fields by design. This keeps approval payloads smaller and reduces host/client filter friction while preserving explicit paths, `expected_head_sha`, staged-path checks, messages, and dry-run flags.

## Git Recovery Workflow

Use `repo_write_recover` to undo reviewed bad writes with explicit paths from `repo_git_review`.

```text
repo_write_changes
repo_git_review
repo_write_recover from review payloads if the diff is bad
repo_write_stage_commit from review payloads if the diff is good
```

If a bad change is already staged, `repo_git_review` can include the same explicit path in both `unstage_paths` and `restore_paths`. `repo_write_recover` unstages first, then restores the worktree path.

```text
repo_write_changes
repo_git_review
repo_write_recover from review payload with unstage_paths and restore_paths
```

Generated artifacts can be removed through review-provided `cleanup_paths`; cleanup still uses the same `cleanup_allowed_globs` policy as `repo_cleanup_paths`. Cleanup only removes explicit paths and refuses targets tracked by Git, so it is suitable for local ChatGPT artifacts such as untracked `.chatgpt/audits/**`, `.chatgpt/backlog/*.local.md`, or `.chatgpt/codex-runs/**` files but not for public tracked docs.

`repo_write_recover` is explicit path-only. It requires `expected_head_sha`, validates operation policy, unstages only `unstage_paths`, restores only `restore_paths`, cleans only `cleanup_paths`, and returns best-effort `remaining_changes` and `clean_after`. It does not discover paths internally, reset, checkout, stash, run `git clean`, commit, push, or run shell commands.

Example dry run:

```json
{
  "repo_id": "example-repo",
  "restore_paths": ["docs/feature.md", "src/index.ts"],
  "cleanup_paths": [".chatgpt/tool-tests/generated.md"],
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "dry_run": true,
  "reason": "Preview recovering bad write-tool changes"
}
```

`repo_git_restore_paths` is the granular worktree-only restore tool. It rejects broad pathspecs such as `.`, `*`, `-A`, and `--all`, absolute paths, traversal, Git internals, shell-like syntax, and hard-risk secret paths. It runs only fixed `git restore -- <paths>` through `execFile`; it does not run a shell.

It restores worktree changes only. If changes are already staged, use the `repo_write_unstage` payload from `repo_git_review` first, review again, and then restore the now-unstaged worktree paths. It does not run `reset --hard`, `checkout`, `switch`, `clean`, `stash`, `restore --staged`, or `restore --source`.

## Runtime Smoke Checklist

Use this checklist after enabling writes in local config and refreshing the MCP client tool list:

1. Call `repo_list_roots` and confirm the intended repo appears with the expected `repo_id` and root.
2. Call `repo_write_file` to create a small file under `.chatgpt/tool-tests/`.
3. Optionally use `dry_run: true` first if you want a preview.
4. Call `repo_fetch_file` for the new path and confirm the returned `sha256` matches `new_sha256`.
5. Try a `replace` dry run where `find` appears exactly once.
6. Try one ambiguous `replace` where `find` appears more than once and confirm it fails.
7. Call `repo_git_status` and confirm only the expected smoke-test artifacts are untracked or modified.
8. Call `repo_git_review` and use `repo_write_recover` for any tracked smoke-test files or cleanup-eligible artifacts that should be recovered.
9. Use low-level `repo_git_restore_paths` or `repo_cleanup_paths` only when testing granular fallback behavior.
10. Use dry-run first only when previewing the smoke action.
11. Confirm `repo_git_status` returns a clean worktree.

The smoke test should only touch files under `.chatgpt/tool-tests/` and should not leave committed artifacts behind.

## Non-Goals

The write tools do not provide:

- shell execution
- git add, commit, push, reset, or checkout
- direct Codex execution
- arbitrary writes outside the configured write policy
- writes to absolute paths, traversal paths, symlink escapes, secret candidates, denied globs, device files, sockets, named pipes, binary edit targets, or secret-looking resulting content
