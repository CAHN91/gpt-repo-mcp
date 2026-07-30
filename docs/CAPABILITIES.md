# Capability Guide

GPT Repo MCP gives ChatGPT a focused set of local repository capabilities.
Instead of uploading a project into the conversation or giving ChatGPT a
general-purpose shell, you approve a repository and choose whether it can be
read, changed, or prepared for a local commit.

This guide explains the experience in terms of outcomes. For exact tool names,
inputs, outputs, and schemas, see [TOOL_SURFACE.md](TOOL_SURFACE.md).

## What Changes When ChatGPT Is Connected

Without repository tools, ChatGPT works from the files and text provided in the
conversation. With GPT Repo MCP, ChatGPT can gather current evidence from an
approved local repository and act on that evidence within its configured
permission mode.

A normal implementation can move through one connected workflow:

1. Understand the goal and repository context.
2. Locate and read only the relevant code.
3. Edit one file or a cohesive set of files.
4. Run an approved validation profile.
5. Review the actual changes and current Git state.
6. Recover the change or prepare a local commit when authorized.

The user still chooses the goal, repository, permission mode, and whether work
should be committed, pushed, or deployed.

## How ChatGPT Adapts Its Workflow

GPT Repo MCP provides several kinds of guidance when the connector starts and
while tools are used:

- **Workflow instructions** describe the recommended direct-development path
  and when specialist workflows are appropriate.
- **Tool descriptions and schemas** explain what each capability does, when it
  should be used, and which inputs are valid.
- **Safety annotations** tell the host which calls are read-only and which have
  local side effects that require approval.
- **Structured results** return current evidence, warnings, and exact safe next
  steps when another action is available.

ChatGPT uses this information to select tools for the current request. The
selection is guided, not hard-coded: a code question may stop after reading,
while a feature request may continue through editing, tests, review, and local
commit preparation.

The server remains the enforcement boundary. It validates every request against
the configured repository, policy, paths, sizes, secrets, current HEAD and file
state, validation profiles, and allowed Git operations. A model instruction
cannot bypass those checks.

## Understand And Navigate A Codebase

ChatGPT can:

- list approved repositories and inspect their high-level structure;
- search for code, text, usages, configuration, or likely entry points;
- read one known file, a line range, or a bounded set of relevant files;
- map file dependencies, symbol references, affected tests, and likely impact;
- summarize repository-owned product context, scripts, architecture, and active
  work without treating old notes as current truth.

This helps ChatGPT build a current picture from the repository instead of
guessing from filenames or relying only on conversation history.

Example request:

```text
Understand how authentication is structured in this repo. Read only the
relevant files and tell me which tests would be affected by changing session
expiry.
```

## Build And Edit Complete Changes

In `write` or `ship` mode, ChatGPT can:

- create or precisely edit a single file;
- apply one cohesive set of changes across multiple files;
- use exact-match edits for focused replacements and insertions;
- prepare transactional patchsets when explicit apply and rollback semantics
  are useful;
- inspect the resulting diff before proposing the next action.

Direct file editing is the default. Patchsets and granular Git operations are
specialist paths, not required ceremony for ordinary work.

Example request:

```text
Add CSV export to the reports page. Update the implementation, tests, and user
documentation, then show me the resulting diff.
```

Every write still passes repository policy, path containment, denied-path,
file-size, stale-state, and secret-content checks.

## Test, Diagnose, And Correct Failures

ChatGPT can run repository-approved validation profiles for tests, builds,
linting, type checks, smoke checks, or the complete configured suite. Results
are bounded and structured so ChatGPT can identify the relevant failure without
receiving unrestricted command execution.

When validation fails, ChatGPT can correlate saved validation evidence,
normalize useful diagnostics, inspect the implicated code, make a correction,
and validate again.

Example request:

```text
Run the approved test profile. Diagnose the failure, fix the underlying issue,
and rerun the narrowest check that proves the correction.
```

GPT Repo MCP does not expose an arbitrary terminal or allow ChatGPT to invent
new shell commands. Validation is limited to configured, allowlisted workflows.

## Review And Prepare Work For Shipping

ChatGPT can review the repository's actual Git status and diff, combine that
evidence with validation and semantic risk findings, and determine whether the
work is ready for a local commit.

A successful review can return an exact next-step payload for staging and
committing the reviewed paths. Before mutation, the server rechecks the current
HEAD, file bytes, path set, validation evidence, and relevant review gates.

Example request:

```text
Review everything currently changed. Check validation and semantic risk, then
prepare one local commit if the result is ready.
```

The server can create an authorized local commit. It does not push, merge,
deploy, rewrite history, or broaden repository access.

## Recover Safely

Writes and reviews produce bounded evidence that can be used for recovery.
ChatGPT can inspect the latest write, review current Git state, and use an exact
recovery payload for approved paths.

Transactional patchsets can also provide first-class rollback when the applied
state, HEAD, and affected files still match the recorded operation.

Example request:

```text
The latest edit is not correct. Review what changed and safely recover only the
paths from that operation.
```

Recovery does not use hidden `reset`, `stash`, or force operations.

## Continue Across Conversations

Optional work sessions preserve content-free progress such as status, touched
paths, decisions, validation references, risks, and the next action. Local
handoffs can store a human-readable continuation note for a future ChatGPT
conversation.

These capabilities support continuity without turning historical notes into
automatic product authority. The user still selects the next goal.

Example request:

```text
Create a local handoff for the next ChatGPT conversation with the current
state, decisions, risks, and remaining work.
```

## Coordinate Codex Or Claude

When the user explicitly requests delegation, ChatGPT can prepare a structured
task, inspect run artifacts, answer current structured questions, and review an
agent's result against the authorized scope, repository state, and acceptance
evidence.

Agent claims are treated as evidence, not proof. ChatGPT reviews the actual
result and diff before the normal ship-readiness and local-commit gates apply.

Example request:

```text
Prepare a focused Codex task for this migration. After the implementation is
complete, review its result against the real diff and acceptance criteria.
```

The public OSS server does not include or start an agent runner. Writing a task
does not execute an agent, stage changes, commit, push, or deploy.

## Permission Modes

| Mode | Intended use | Available outcome |
| --- | --- | --- |
| `read` | Exploration and review | Understand code, inspect Git state, and plan work |
| `write` | Direct implementation | Read capabilities plus guarded file changes |
| `ship` | Reviewed local completion | Write capabilities plus approved validation, recovery, staging, and local commits |

No mode enables arbitrary shell execution, automatic push, automatic deploy,
force operations, branch deletion, or unrestricted filesystem access.

## Where To Go Next

- Start with the [README quickstart](../README.md#quickstart).
- Review the [product and UX contract](PRODUCT.md).
- See [TOOL_SURFACE.md](TOOL_SURFACE.md) for exact tool contracts.
- See [WRITE_WORKFLOWS.md](WRITE_WORKFLOWS.md) for write and recovery details.
- See [SECURITY.md](SECURITY.md) for enforced boundaries.
