# Security

## Tool Annotations

Read tools use read-only annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`
- `idempotentHint: true`

Mutating tools use separate write annotations:

- `readOnlyHint: false`
- `destructiveHint: true`
- `openWorldHint: false`
- `idempotentHint: false`

No arbitrary shell tools or command runners are registered. Safe git operations use fixed argument arrays through `execFile`. `repo_validate` accepts only allowlisted profiles. npm scripts may inherit an exact repo-declared Node runtime only after its executable resolves inside a supported manager root, is an executable regular file, and reports the requested exact version. Runtime metadata cannot add arguments, no runtime is installed automatically, and no absolute runtime path is exposed in artifacts. pytest and focused-path protections remain unchanged. No validation path uses a shell or accepts command strings.

Production advisory reachability, temporary overrides, removal conditions, and
the lockfile verification workflow are documented in
[DEPENDENCY_SECURITY.md](DEPENDENCY_SECURITY.md).

## OSS Release Security Verification

Public release candidates use Gitleaks with the repository-owned
`.gitleaks.toml`, `.gitleaksignore`, and
`security/oss-security-policy.json`. The policy pins the reviewed scanner
version, release-asset checksums, and extracted binary checksums for supported
macOS and Linux architectures. The scan rejects a binary whose checksum or
version differs. Its one historical ignore is bound to the exact fingerprint
of a known synthetic test fixture; it does not allow a file, rule, path family,
or secret pattern.

After installing the candidate with `npm ci --ignore-scripts`, run:

```bash
npm run security:scan -- \
  --candidate /absolute/path/to/candidate \
  --export-report /absolute/path/to/candidate.oss-export-report.json \
  --public-repo /absolute/path/to/public-repo \
  --gitleaks-bin /absolute/path/to/pinned/gitleaks
```

The command scans candidate contents and the complete retained public Git
history, checks candidate and historical email occurrences against the narrow
public/example policy, inventories installed package licenses, and classifies
production and development advisories. Existing public contribution metadata
may be approved only by exact commit and author/committer role; the policy
stores no private address and does not permit the same address at another
location. Its output contains counts, rule ids, package metadata, and safe
locations only. It never returns matched secrets or email addresses.

Unknown Gitleaks findings, new or unreviewed private email occurrences,
unapproved licenses, production advisories, unknown development advisories,
and expired advisory-review deadlines block release. Test credentials should
be assembled at runtime so source files do not contain token-shaped literals.

Codex task tools do not run Codex or execute commands. Task strings and arrays are bounded; scope entries must be safe repo-relative paths or globs, default forbidden patterns cannot be replaced, and structured validation accepts only allowlisted profiles with separate safe test paths. Runner handoff metadata is limited to manual or queued mode and allowlisted runner names; queued mode requires an explicit runner, and writing metadata never starts or queues it. Legacy verification command strings are retained only as bounded prompt compatibility and are never executed by the MCP. `repo_write_codex_task` writes a strict v3 prompt, manifest, baseline binding, and hash-sealed server-owned `review-gate.json`; historical v1/v2 manifests remain review-only. `repo_agent_runs` is read-only, ignores unsafe/symlink run entries, validates manifest/status/event identity, caps artifact bytes and returned events, redacts event summaries, and never returns prompt/result content or raw runner logs. `repo_codex_review` reconstructs the expected v3 prompt and manifest binding, verifies strict `RESULT.json`, authorization, baseline, connected changes, separate TAC/PAC evidence, deterministic technical readiness, product-review requirement, bounded product evidence, review state, and any existing gate-bound attestation. Agent PAC claims are evidence only and never self-approve product work. Its review-only parser accepts a finite set of harmless status aliases and omitted empty `blockers`/`followups` arrays with explicit warnings; unknown fields and other contract violations remain rejected, and strict runner completion parsing is unchanged. Integrity or scope failure, non-completed status, or incomplete/unpassed acceptance removes all happy-path stage/commit payloads while safe recovery/read-only evidence may remain. Legacy `RESULT.md` remains readable but cannot satisfy required v2 acceptance ids. Review remains read-only.

Structured feedback adds no command surface. `repo_agent_runs` may expose only
bounded/redacted current questions and never returns an external provider
thread id. `repo_write_agent_reply` requires an exact
repo/run/turn/question-hash binding and complete bounded answers, rejects stale
or duplicate writes, and only creates the reply artifact. It cannot accept
commands, working directories, environment values, models, or provider
configuration and never invokes an implementation agent. Agent execution,
provider adapters, credentials, scheduling, and process supervision are not
included in the OSS distribution.

## Delegation v3 Review Gate

Every newly written Delegation v3 run receives a private server-owned `.chatgpt/codex-runs/<run_id>/review-gate.json`. The gate binds the run identity, v3 manifest and prompt hashes, baseline HEAD/hash, effective authorization, review requirement, and repository governance mode. New manifests also capture content states for paths already dirty at baseline. Review can therefore prove when the run changed those bytes again instead of treating every pre-existing path as permanently unattributable. Older v3 runs without this evidence retain the previous conservative binding; v1/v2 remain historical review-only.

`DelegationGateService` is the single enforcement point for `repo_git_review`, `repo_ship_review`, `repo_write_stage`, `repo_write_commit`, and `repo_write_stage_commit`. Modern attestations bind exact HEAD plus the exact attributed pathset and its content fingerprint. Unrelated changes outside that pathset do not stale the run; any byte, existence, file-kind, evidence, or HEAD change inside it does. When several runs overlap a requested path, every applicable enforce gate must pass. Missing, failed, stale, tampered, invalid, or truncated enforce state blocks before mutation. Advisory gates return warnings without blocking.

Granular stage checks the gate before `git add`. Staged-only commit checks the actual staged path set. Composite stage-and-commit checks before staging and again against the actual staged set immediately before commit; when the second check fails and the operation created the staged state, the service restores those paths from the index before returning the error. Runner `commit_after_green` and `push_after_commit` configuration is rejected so a future runner cannot silently bypass the same gate.

Unstage, worktree restore, cleanup, safe discard, and reviewed recovery remain available under an open gate because they remove or reverse changes rather than ship them. Manual `git add` or `git commit` executed directly in a terminal is outside MCP enforcement. GPT Repo MCP must describe this boundary honestly and does not claim to prevent out-of-band Git commands.

## Integration Review Boundary

`repo_write_integration_review` is an explicit owner-approved path for several currently attested Delegation v3 runs in one dirty worktree. It is not a force or skip-review option. The service requires exact coverage of every current project change, valid technical and product review state for each selected run, current full validation, complete semantic evidence, safe paths, no failed applicable gate, exact HEAD, and exact path bytes. Failed product verdicts and unresolved attribution remain blocking.

A successful integration review writes a hash-bound local artifact under `.chatgpt/integration-reviews/**` and returns only an opaque pathset id. `repo_write_stage_commit` resolves that id server-side, refuses a changed commit message or expanded pathset, and rechecks the artifact, HEAD, bytes, paths, gates, secret/path policy, and actual staged set before one local commit. The explicit path flow keeps its configured path limit; only the server-owned pathset can use the separate 2,000-path hard ceiling. No push, shell, merge, force, or review bypass exists.

## Transport

The default OSS connection path is `npm run connect`. It starts the local MCP server and starts or reuses ngrok as a built-in convenience HTTPS tunnel. The printed ChatGPT URL ends in `/t/<random-token>/mcp`. See [CONNECTION_OPTIONS.md](CONNECTION_OPTIONS.md) for built-in, manual, and Secure MCP Tunnel connection paths.

That random path token is guess-resistance only, not authentication. Anyone with the full URL can reach the MCP endpoint while the public tunnel is running, so treat it as a temporary local development endpoint and stop it when done.

The HTTP server binds to `127.0.0.1` by default. Non-loopback binds are
refused unless `GPT_REPO_HOST` names the external interface and
`GPT_REPO_ALLOW_EXTERNAL_BIND=true` is also set. Browser-originated requests
must present a loopback HTTP Origin and loopback Host; MCP and tunnel clients
that do not send an Origin continue through the normal path and policy checks.

Network exposure does not bypass repository policy. ChatGPT still supplies only `repo_id`; approved roots, default excludes, path sandboxing, secret checks, read/write policies, expected HEAD checks, and tool schemas still apply. Mutating tools remain disabled unless the target repo explicitly enables writes or operations.

OpenAI Secure MCP Tunnel is an advanced option for longer-lived or private connector setups when supported. In that mode, the local MCP endpoint stays private at `/mcp`, while `tunnel-client` opens an outbound connection to OpenAI and forwards MCP requests back to the local server. Store the tunnel runtime API key in `.env` or another local secret store, never in committed files.

## Approved Roots

ChatGPT never supplies absolute repository paths. It supplies `repo_id`; the server resolves that id to an approved root from config. Unknown repos are rejected.

All model-supplied paths must be repo-relative POSIX paths. `PathSandbox` rejects absolute paths, traversal, symlink escapes, device files, sockets, and named pipes.

## Default Excludes

Default excludes apply consistently to tree, search, bounded reads, project briefing, task inventory, decision memory, and change planning. Common excluded areas include Git internals, dependency directories, generated output/cache directories, coverage, virtual environments, and generated test artifacts.

Generated/default-excluded files can be fetched only through `repo_fetch_file` with `override_default_excludes: true`, and the result includes a warning. Secret candidates remain blocked.

## Secret Candidates

Secret-looking paths are blocked by default, even when explicitly requested. Sensitive examples include `.env`, private keys, certificate bundles, identity key files, and directories exactly named `secrets` or `credentials`. Ordinary code, docs, and tests are not blocked merely because their paths contain words like `secret` or `credential`.

Public environment templates are the narrow exception for reads: `.env.example`, `.env.sample`, `.env.template`, and `example.env` can be read when their contents pass secret scanning. Real environment files such as `.env`, `.env.local`, `.env.production`, and arbitrary `.env.*` names remain blocked.

Secret-value detection is defense-in-depth. One shared matcher covers
assignment, JSON, YAML, bearer-header, private-key block, and established
provider-token formats. Explicit documentation placeholders remain allowed.
The matcher is shared by write/commit checks and output/log redaction, but it
does not replace secret-path blocking or repository policy.

Tool outputs, errors, and logs must not include file contents from blocked secret candidates, tokens, credentials, environment variables, private keys, raw tool outputs, or raw errors. Except for the configured `root` returned by `repo_list_roots`, tools should prefer `repo_id` and repo-relative paths over absolute paths.

## Write Policy

Writes are disabled by default for every repo. A repo must opt in with `writes.enabled: true`.

The CLI permission modes are config shortcuts only:

- `read`: writes and operations disabled.
- `write`: broad repo-local file edits enabled under write policy, with hard denied paths and secret checks still enforced.
- `ship`: write mode plus local validation with focused test-path globs, git stage, commit, recover, and cleanup operations.

No mode enables shell execution, arbitrary command execution, push, pull, reset, checkout, switch, rebase, merge, stash, clean, force, or branch deletion.

Default allowed write globs are `.chatgpt/**`, `.codex/**`, `docs/**`, exact root public docs (`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `LICENSE`), and exact `.gitignore`. This is not a general root-write allowance; root files such as `package.json`, source files, scripts, tests, and arbitrary notes remain blocked unless the repo opts in with custom allow globs. The `.gitignore` allowance is a narrow repo-metadata path for adding local-only ignore policy. Default denied write globs include real env files, private key files, Git internals, root and nested dependency directories, common generated/cache directories, coverage, test results, and virtual environments. Denied globs and hard secret-candidate checks win over allowed globs.

Clone-based `npm run add -- <path> --mode write` and `--mode ship` intentionally use `allowed_globs: ["**"]` for solo-dev ergonomics while preserving the hard denied globs, hard secret-path checks, resulting-content secret scans, path sandboxing, and size limits. Use `repo_policy_explain` to inspect the effective read/write/cleanup policy and explain why a supported path check is allowed or blocked.

`repo_write_file` also enforces repo-relative paths, no traversal, no absolute paths, no symlink escapes, no device files, no sockets, no named pipes, `max_bytes_per_write`, denied globs, allowed globs, stale-state guards when supplied, and secret scanning of the resulting content. `dry_run: true` performs policy, path, size, precondition, and content checks and computes the result without writing. Optional stale-state guards are `expected_old_sha256` for existing files, `expected_missing` for file creation, and `expected_head_sha` for matching the current Git HEAD before writing.

`repo_write_changes` supports the same per-file stale-state guards inside each change and supports `expected_head_sha` for the whole edit pack. Per-change stale-state preconditions are checked before applying the pack so stale context does not partially write earlier files.

`repo_write_file` does not create visible overwrite backups by default. Its result includes `old_sha256` and `new_sha256` for review, but the user-facing write flow does not require manually supplying expected SHA values unless the caller wants stale-state protection.

`OperationReceiptService` writes lightweight local receipt metadata after successful actual changed write operations and reads the latest receipt through `repo_last_write`. The latest receipt lives at `.chatgpt/operations/last-write.json`; append-only historical events are written to `.chatgpt/operations/ledger.jsonl`. These files are local runtime state, are ignored by Git, and contain only safe metadata such as repo-relative paths, per-file SHA-256 values, counts, timestamps, best-effort HEAD SHAs, rollback hints, future patchset/session/validation/commit linkage fields, event types, and content-free summaries. They do not store contents, snippets, diffs, prompts, command output, secrets, or absolute paths.

`repo_operation_ledger` is read-only and returns only validated content-free ledger events for the requested `repo_id`. Invalid or unsafe ledger lines are skipped with stable warnings.

Patchset tools support `create`, full-file `modify`, `delete`, `rename`, and structured `edit` patchsets. `repo_prepare_patchset` is a non-destructive, non-idempotent local mutation: it writes only a new `.chatgpt/patchsets/**` manifest and does not touch target files. `repo_apply_patchset` revalidates write policy, path safety, stale-state guards, size limits, and secret scanning for content writes and structured edits, captures pre-write state for touched paths, restores those paths on unexpected apply failure, and records receipts as `repo_apply_patchset`. Structured edits apply ordered exact-match replacement hunks and report per-hunk diagnostics before mutation when validation fails. A changed actual apply bound to a Git HEAD returns a complete `repo_rollback_patchset` payload. `repo_rollback_patchset` rolls back only uncommitted applied patchsets whose ledger state and current file hashes still match; it restores tracked modified, edited, or deleted paths through fixed git restore arguments and deletes only SHA-matched untracked patchset-created or rename-destination regular files. Patchset tools do not stage, commit, push, pull, reset, checkout, switch, rebase, merge, stash, clean, run shell commands, or execute validation.

Work-session tools store implementation continuity under `.chatgpt/work-sessions/**` through the normal write policy. `repo_start_work_session` and `repo_update_work_session` write content-free JSON only; `repo_current_work_session` is read-only and never clears or rewrites a completed pointer. Its result labels the lookup source and deterministically distinguishes active work, blocked ongoing work, and completed history. Completed current-pointer reads omit the full session payload and historical next action; explicit-id reads retain full history. Session state may contain repo-relative paths, decisions, assumptions, patchset ids, validation profile/status references, unresolved risks, and next action. It must not contain file contents, snippets, raw diffs, command outputs, prompts, secrets, or absolute paths. Path fields are validated as repo-relative POSIX paths and stored schema-v1 state is parsed through Zod before it is returned.

`repo_symbol_context` is a bounded read-only analysis surface for TypeScript and JavaScript. It scans only sandbox-approved source files outside default excludes, dependencies, generated output, nested repositories, and secret-looking paths. Its internal `.chatgpt/index/symbols/**` cache is keyed by HEAD/worktree state and stores content-free metadata only. The optional Codebase Memory integration accepts only an administrator-configured absolute executable, starts it over MCP stdio with an empty argument list and no shell, requires exact canonical-root project matching, bounds graph output, strips absolute paths, and always falls back to native analysis.

`repo_code_index` accepts only an approved `repo_id` and fixed `start` or `status` action. ChatGPT must obtain user approval before `start`. The implementation derives the repository root from `RootRegistry`, sets `CBM_ALLOWED_ROOT` to that exact root, starts the provider outside the repository so an upstream global `auto_index` setting cannot implicitly index it, disables persistent repo artifacts, deduplicates concurrent jobs, and never accepts client-provided paths, commands, executables, modes, or arguments.

`repo_failure_diagnose` reads only saved validation artifacts, safe work-session/write metadata, Git status, and bounded symbol metadata. Artifact paths are schema-restricted, all reads pass through the repository sandbox, outside-root stack paths are discarded, text is bounded and redacted, and focused-test payloads are emitted only for policy-allowlisted paths. It never executes a suggested check or presents heuristics as proven root cause.

`repo_semantic_review` is a read-only deterministic risk surface over bounded staged/unstaged diffs, content-free symbol metadata, and latest validation status. It emits no raw source beyond existing bounded diff processing, deduplicates and caps findings, marks confidence explicitly, and treats only high-priority high-confidence rules as semantic ship blockers. It does not mutate the existing Git review state or execute recommended checks.

`repo_ship_review` is a read-only orchestration surface over Git review, the shared delegation gate, semantic review, validation state, and bounded failure diagnosis. An optional v3 `run_id` must match the applicable gate set. It returns stage/commit payloads only when validation, semantic review, Git review, and every applicable enforce gate are satisfied; it never executes validation or mutates files or Git.

## Operations Policy

Local operations are disabled by default for every repo. A repo must opt in with `operations.enabled: true` plus the specific capability flag needed: `operations.git_stage_enabled: true`, `operations.git_commit_enabled: true`, `operations.cleanup_enabled: true`, or `operations.validation_enabled: true`. New `--mode ship` entries also include `operations.validation_test_path_globs` for focused test authorization; `npm run check:config` warns when older ship-like entries omit those globs.

`repo_write_stage` and `repo_write_unstage` accept only explicit repo-relative POSIX paths and require `expected_head_sha`. Staging consults the shared Delegation v3 gate before index mutation; unstaging remains available under open gates because it is a recovery operation. They reject empty path lists, `.`, `*`, shell-like pathspecs, absolute paths, traversal, `.git`, real environment files, private key/certificate files, identity key filenames, and directories literally named `secrets` or `credentials`. Legitimate code, docs, and tests whose filenames contain words like `secret` or `credential` are allowed when the path is explicit and otherwise safe. Actual staging uses fixed `git add -- <paths>` arguments, and actual unstaging uses fixed `git restore --staged -- <paths>` arguments.

Public environment template files can be staged only through a narrow filename allowlist: `.env.example`, `.env.sample`, `.env.template`, and `example.env`. These files are still read and scanned for secret-looking values before staging or commit validation. Real environment files such as `.env`, `.env.local`, and `.env.production` remain blocked.

`repo_write_commit` requires `expected_head_sha`, a non-empty message, and non-empty `expected_staged_paths`. It verifies actual staged paths exactly match the expected list, checks the shared Delegation v3 gate against that actual set, and only then uses fixed `git commit -m <message>` arguments. It does not stage files, use `git commit -a`, or push.

`repo_cleanup_paths` is disabled by default and requires both `operations.enabled: true` and `operations.cleanup_enabled: true`. It deletes only explicitly listed repo-relative paths that match `operations.cleanup_allowed_globs` and refuses targets tracked by Git. Defaults are `.chatgpt/tool-tests/**`, `.chatgpt/backups/**`, `.chatgpt/audits/**`, `.chatgpt/backlog/**`, `.chatgpt/codex-runs/**`, `coverage/**`, `dist/**`, and `test-results/**`. It rejects absolute paths, traversal, `.`, `*`, broad pathspec-like values, `.git`, `.env`, secret-looking paths, symlink escapes, device files, sockets, and named pipes. Deletion uses Node filesystem APIs only and never runs `git clean`.

`repo_validate` is disabled by default and requires both operations flags. It accepts only `test`, `build`, `lint`, `typecheck`, `smoke`, and `all`. Matching npm scripts take priority. Node metadata priority is Volta, `.node-version`, `.nvmrc`, then exact `engines.node`; only strict `major.minor.patch` values participate. Supported installed roots are nvm, mise, fnm, Volta, and asdf. A missing exact runtime fails with `VALIDATION_NODE_RUNTIME_UNAVAILABLE` instead of silently using the host Node. Only `test` may use pytest fallback. Focused paths remain glob-validated separate arguments. Execution uses `execFile` without a shell, bounded timeout, and redacted output; it never installs runtimes or accepts commands.

`repo_write_recover` can discard reviewed safe untracked files through explicit `discard_paths[]` from `repo_git_review`. Discard refuses tracked files, secret candidates, generated/cache/dependency paths, symlinks, non-regular files, broad pathspecs, traversal, and stale HEAD. Generated artifacts remain governed by `cleanup_paths[]` and cleanup policy.

## Nested Repos and Submodules

Nested Git repositories and submodules are separate trust boundaries. Tree/search/read_many/planning workflows do not recurse into them by default. Register a nested repo or submodule as its own `repo_id` to allow reading it.

Symlinks are still resolved through the sandbox, so a symlink cannot be used to escape the approved root or bypass nested-repo boundaries.

## Error Envelope

All tool errors use the shared structured error envelope through the MCP error path:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Sanitized message",
    "retryable": false,
    "diagnostics": []
  }
}
```

Validation errors identify the invalid field without echoing sensitive values. Policy errors distinguish blocked secret candidates, default-excluded paths, traversal attempts, symlink escapes, binary files, and size limits where possible. Unexpected errors are converted to sanitized internal errors before returning to ChatGPT.

## Audit Logging

Audit logs may include tool name, `repo_id`, safe repo-relative paths or globs, counts, truncation state, warning codes, `request_id`, safe MCP method and tool name, HTTP status code, duration, MCP session presence, and one allowlisted request-failure category: `invalid_session`, `session_capacity`, `transport_request`, `transport_close`, `server_initialization`, or `internal`.

Every request-failure category is correlated with the request id. Audit logs must not include request bodies, tool arguments, full MCP session ids, headers, returned file text, file content, secret-looking values, raw structured outputs, raw errors, error messages, stack traces, environment variables, tokens, credentials, SSH keys, private keys, or unredacted absolute paths. Client-facing 500 responses remain generic.

HTTP MCP transports are stored in a bounded `Map`, not under client-controlled
object properties. The server defaults to 100 concurrent sessions and a
30-minute idle TTL. Expired, explicitly deleted, and shutdown sessions close
their transports. Capacity exhaustion returns a generic 503 response without
disclosing session identifiers.

`GPT_REPO_CONFIG`, `GPT_REPO_PUBLIC_PATH_TOKEN`, `GPT_REPO_HOST`,
`GPT_REPO_ALLOW_EXTERNAL_BIND`, `GPT_REPO_LOG_FORMAT`,
`GPT_REPO_LOG_COLOR`, `GPT_REPO_MAX_SESSIONS`, and
`GPT_REPO_SESSION_IDLE_TTL_MS` are the public environment variables. Legacy
`REPO_READER_*` names remain supported as fallback aliases for compatibility
where documented.

`GPT_REPO_LOG_FORMAT=pretty` changes only terminal formatting. Pretty logs use the same sanitized audit event data as the default JSON logs. `GPT_REPO_LOG_COLOR=auto|always|never` controls color, and `NO_COLOR` disables color.
