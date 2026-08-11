# Tools And Workflows

GPT Repo MCP exposes 46 focused repository tools to ChatGPT. You normally do
not need to call them by name. Describe the outcome you want, and ChatGPT uses
the connector's instructions and tool descriptions to choose an appropriate
workflow.

This guide explains what the tools enable, when ChatGPT uses them, which calls
have local side effects, and where the safety boundaries are. For exact machine
schemas, inspect the connected server through ChatGPT Developer Mode or the
[MCP Inspector](#inspect-exact-schemas).

## Start With The Outcome

Ask for repository work in normal language:

```text
Understand how authentication works and identify the files that would change
if session expiry became configurable.
```

```text
Implement CSV export, update the tests and documentation, run the approved
checks, and review the final diff.
```

```text
Review the current changes and prepare one local commit if they are ready. Do
not push or deploy anything.
```

ChatGPT may use several tools to complete one request. A code question can stop
after reading. An implementation can continue through editing, validation,
review, and an approved local commit.

## The Normal Development Path

| Stage | What ChatGPT does | Common tools |
| --- | --- | --- |
| Understand | Builds a project overview, searches, and reads relevant files | `repo_project_brief`, `repo_search`, `repo_fetch_file`, `repo_read_many` |
| Change | Applies one focused edit or a coherent multi-file change | `repo_write_file`, `repo_write_changes` |
| Validate | Runs a repository-approved check | `repo_validate` |
| Review | Examines Git state, the real diff, and readiness evidence | `repo_git_review`, `repo_ship_review` |
| Finish | Creates one reviewed local commit | `repo_write_stage_commit` |
| Recover | Reverses only the reviewed affected paths | `repo_write_recover` |

Specialist tools for code indexing, transactional patchsets, work continuity,
granular Git operations, or externally executed agent work are available when
the task genuinely needs them. They are not required ceremony for ordinary
repository work.

## Permission And Approval

| Tool behavior | Typical permission | What happens |
| --- | --- | --- |
| Read-only | `read`, `write`, or `ship` | Reads bounded repository or Git evidence without changing local state |
| File or local-note write | `write` or `ship` | Changes approved files or creates approved local working metadata |
| Validation or local Git mutation | `ship` | Runs an approved profile, recovers paths, stages files, or creates a local commit |
| Optional code indexing | Explicit approval and configured provider | Starts or checks bounded indexing for the approved repository |

The ChatGPT host normally presents an approval prompt for calls with local side
effects. Host approval does not replace server policy: the server rechecks the
repository, path, permission, current state, size, secret, validation, and Git
requirements before acting.

No tool provides arbitrary shell execution, unrestricted filesystem access,
automatic push, automatic deployment, force operations, or branch management.

## Tool Groups

| Goal | Tools | Count |
| --- | --- | ---: |
| Access and policy | Repository discovery and effective-policy explanation | 2 |
| Understand and plan | Tree, search, reads, context, indexing, briefs, inventory, decisions, and planning | 11 |
| Edit and continue | Direct writes, work sessions, handoffs, and latest-write evidence | 7 |
| Validate and review | Approved checks, diagnosis, semantic review, ship review, and Git evidence | 7 |
| Complete or recover | Local Git completion, recovery, cleanup, and operation history | 8 |
| Transactional patchsets | Prepare, apply, review, and roll back a bounded change set | 4 |
| External-agent coordination | Prepare tasks, inspect results, answer questions, and record reviews | 7 |

## Access And Policy

### `repo_list_roots`

**Read-only.** Lists repositories that the local configuration has explicitly
approved. Use it to confirm the available `repo_id` before starting work. It
does not scan repository contents.

### `repo_policy_explain`

**Read-only.** Explains what ChatGPT may read, write, validate, recover, clean,
stage, or commit for a repository and optional path. Use it when a capability
is unexpectedly blocked or before enabling broader access.

## Understand And Plan

### `repo_project_brief`

**Read-only.** Produces a bounded onboarding view of the project: languages,
package managers, scripts, key documentation, likely entry points, tests, and
repository-owned product context. It is the best first tool for an unfamiliar
project.

### `repo_tree`

**Read-only.** Shows a bounded directory tree while respecting default
exclusions and nested-repository boundaries. Use it to orient before reading
files.

### `repo_search`

**Read-only.** Searches approved text files for names, strings, usages, TODOs,
or likely entry points. Results include repo-relative paths and bounded context.

### `repo_fetch_file`

**Read-only.** Reads one known UTF-8 text file or line range. Secret-looking
paths remain blocked, and generated files require an explicit supported
override.

### `repo_read_many`

**Read-only.** Reads a bounded set of selected text files in one call. Use it
after search or tree has narrowed the relevant paths.

### `repo_context_map`

**Read-only.** Builds a bounded map around a goal or seed files, including
likely dependencies, nearby tests, and impact signals. Use it when the change
surface is unclear.

### `repo_symbol_context`

**Read-only.** Finds TypeScript or JavaScript symbol definitions, references,
imports, exports, and likely affected tests. It helps ChatGPT reason about code
relationships without reading the whole project.

### `repo_code_index`

**Approval required.** Starts or checks optional Codebase Memory indexing for
the exact approved repository. It accepts no client-provided command or
executable and does not expand repository access.

### `repo_task_inventory`

**Read-only.** Collects bounded TODOs, FIXMEs, roadmap notes, and Markdown
checklist items. Use it only when the user asks to inspect existing work or
backlog signals.

### `repo_decision_memory`

**Read-only.** Extracts evidence-backed architecture decisions, conventions,
rationale, and gaps from repository-owned sources. It does not treat old notes
as current authority without evidence.

### `repo_change_plan`

**Read-only.** Creates a repository-grounded implementation plan for a goal,
including relevant files, ordered steps, test strategy, and open questions. It
does not edit files or make the plan authoritative.

## Edit And Continue

### `repo_write_file`

**Writes one approved file.** Creates, replaces, appends, prepends, or performs
one exact-match edit on a repo-relative UTF-8 text file. Policy, path, size,
stale-state, and secret checks run before the write. It never stages or commits.

### `repo_write_changes`

**Writes multiple approved files.** Applies one validated edit pack across a
coherent set of files. All requested changes are checked before the first
write, and partial failures trigger bounded restoration attempts. It never
stages or commits.

### `repo_start_work_session`

**Writes local progress metadata.** Starts an optional bounded work session
containing status, relevant paths, decisions, risks, validation references, and
the next action. It stores no file contents or raw diffs.

### `repo_update_work_session`

**Writes local progress metadata.** Updates an existing work session while
checking its current state. Use it when meaningful progress, decisions, risks,
or completion status have changed.

### `repo_current_work_session`

**Read-only.** Returns the current active or blocked work session, or a bounded
completed-history result. Use it to resume work in a later conversation without
assuming completed instructions are still active.

### `repo_write_handoff`

**Writes a local handoff note.** Creates a human-readable continuation note
under `.chatgpt/handoffs/` for a later ChatGPT conversation. Handoffs are local
working context and should not be committed.

### `repo_last_write`

**Read-only.** Returns safe metadata about the latest successful write, such as
affected paths and hashes, plus the next review action. It does not return file
contents or diffs.

## Validate And Review

### `repo_validate`

**Runs an approved local check.** Executes only enabled test, build, lint,
type-check, smoke, or complete validation profiles. ChatGPT cannot supply an
arbitrary command string or use it as a terminal.

### `repo_failure_diagnose`

**Read-only.** Interprets saved validation evidence, related Git state, and
bounded code context to identify likely causes and safe focused follow-up
checks. It does not run the suggested check or claim a heuristic as proof.

### `repo_semantic_review`

**Read-only.** Reviews bounded diffs for deterministic semantic risks and marks
confidence. Use it when the user wants focused risk evidence without a full
completion review.

### `repo_ship_review`

**Read-only.** Combines Git review, validation state, semantic risk, failure
evidence, and applicable external-agent review state into one readiness result.
When the work is ready, it can return the exact safe local completion payload.

### `repo_git_status`

**Read-only.** Shows bounded repository status, branch, HEAD, staged paths,
unstaged paths, and untracked paths without changing Git.

### `repo_git_diff`

**Read-only.** Returns a bounded Git diff with files and hunks. It is the main
evidence for reviewing what actually changed.

### `repo_git_review`

**Read-only.** Reviews current Git status and diff, identifies risk, considers
validation and applicable review gates, and returns exact completion or
recovery payloads when safe. It does not mutate Git itself.

## Complete Or Recover

### `repo_write_stage_commit`

**Stages and commits locally.** Uses explicit reviewed paths, expected HEAD,
and an approved commit message to create one local commit. It refuses unrelated
pre-staged files and never pushes.

### `repo_write_recover`

**Recovers reviewed paths.** Executes one bounded recovery plan returned by
Git review: it can unstage, restore tracked worktree files, remove approved
generated artifacts, or discard reviewed safe untracked files. It never resets
or cleans the whole repository.

### `repo_git_restore_paths`

**Restores explicit tracked worktree paths.** This granular recovery tool
checks the expected HEAD and does not unstage, reset, checkout, stash, or
restore the whole repository.

### `repo_write_stage`

**Stages explicit paths.** Uses reviewed repo-relative paths and expected HEAD.
Broad pathspecs such as `.`, `*`, and `--all` are rejected.

### `repo_write_unstage`

**Unstages explicit paths.** Removes selected paths from the Git index while
leaving their worktree changes intact. It is available as a recovery action.

### `repo_write_commit`

**Commits already staged paths locally.** Verifies the exact staged path list,
expected HEAD, and applicable review state before committing. It never stages
additional files or pushes.

### `repo_cleanup_paths`

**Deletes approved generated or local artifacts.** It accepts explicit
repo-relative paths that match cleanup policy and refuses Git-tracked files,
secret-looking paths, broad patterns, and unsafe file types.

### `repo_operation_ledger`

**Read-only.** Returns bounded, content-free history for successful direct
writes, patchset application, and patchset rollback. It helps trace recent local
actions without exposing source text or command output.

## Transactional Patchsets

Patchsets are useful when a complex change benefits from a separately
reviewable prepare, apply, and rollback lifecycle. Direct writes remain simpler
for ordinary work.

### `repo_prepare_patchset`

**Writes a local patchset manifest, not target files.** Prepares bounded create,
modify, edit, delete, and rename operations for later review and application.

### `repo_apply_patchset`

**Applies a prepared patchset.** Rechecks paths, policy, stale state, sizes, and
secrets before changing target files. Unexpected partial failure triggers
restoration attempts.

### `repo_review_patchset`

**Read-only.** Shows the prepared change, whether it has been applied or rolled
back, and the current Git review evidence.

### `repo_rollback_patchset`

**Rolls back an eligible uncommitted patchset.** Rollback is offered only while
the operation record, Git state, and affected file hashes still match. It does
not reset unrelated work.

## External-Agent Coordination

These tools do not provide an agent runner. They prepare and review local
artifacts for an implementation agent that the user operates separately.

### `repo_prepare_codex_task`

**Read-only preview.** Validates a bounded external-agent task, authorization
scope, preservation rules, exclusions, acceptance criteria, and approved
validation before writing any artifact.

### `repo_write_codex_task`

**Writes local task artifacts.** Creates a structured task and review binding
under `.chatgpt/codex-runs/`. It does not start an agent, send credentials,
stage, commit, push, or deploy.

### `repo_agent_runs`

**Read-only.** Lists bounded run state or reads one selected run with sanitized
events and current structured questions. It does not return raw logs, prompt
text, source content, provider thread ids, or environment values.

### `repo_write_agent_reply`

**Writes a bounded local reply artifact.** Answers the exact current structured
questions for an external run. It cannot change scope, supply commands, select
models, or resume the external process.

### `repo_codex_review`

**Read-only.** Reviews an external result against its task, authorized paths,
acceptance evidence, current Git state, and actual changed files. Agent claims
are evidence, not automatic approval.

### `repo_write_codex_review`

**Writes a state-bound local review.** Records the user's or ChatGPT's reviewed
technical or product verdict after current evidence passes the required checks.
It does not stage, commit, or push.

### `repo_write_integration_review`

**Writes a bounded multi-run integration review.** Use it only when the user
explicitly approves combining several individually reviewed external-agent
results in one worktree. It requires exact coverage, current validation, safe
paths, matching HEAD and file state, and no failed applicable review. It is not
a force or skip-review path.

## Recommended Prompt Patterns

### Understand a project

```text
Give me a concise project brief, then inspect only the files needed to explain
how this feature works.
```

### Implement and verify

```text
Implement this change across every affected file. Run the narrowest approved
checks that prove it and review the final Git diff.
```

### Finish locally

```text
Review all current changes. If validation and review are green, create one local
commit containing only the reviewed paths. Do not push or deploy.
```

### Recover a bad change

```text
Review the latest write and current Git state, then safely recover only the
paths affected by that operation.
```

### Review external-agent work

```text
Review this completed external-agent run against its authorized task, current
repository state, acceptance criteria, and actual diff. Do not trust the agent's
summary without evidence.
```

## Inspect Exact Schemas

ChatGPT receives each tool's exact input and output schema directly from the
connected MCP server. Contributors and advanced users can inspect the same
surface locally.

Start the server:

```bash
GPT_REPO_CONFIG=./config.local.json npm run dev
```

Then open the Streamable HTTP endpoint in MCP Inspector:

```bash
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

Use `tools/list` to inspect exact schemas and read/write annotations. For the
security guarantees behind those tools, see [Security](SECURITY.md). For
detailed editing and recovery procedures, see
[Write workflows](WRITE_WORKFLOWS.md).
