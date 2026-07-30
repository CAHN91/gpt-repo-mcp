# Migrating from 0.1.x to 0.2.0

Version 0.2.0 expands the public capability set and removes five overlapping
tool names. Existing repository configuration remains supported, but unknown
configuration fields are now rejected.

## Before upgrading

1. Keep a copy of your current `config.local.json`.
2. Update the checkout and run `npm ci`.
3. Run `npm run build`.
4. Run `npm run check:config` and remove any unsupported configuration fields
   it reports.
5. Refresh the GPT Repo MCP connector in ChatGPT so it receives the current
   tool schemas.

The normal `npm run connect`, `npm run connect:secure`, repository ids,
read/write/ship modes, and `gpt-repo`/`connect-gpt` binaries remain supported.

## Tool-name changes

| 0.1.x tool | 0.2.0 replacement |
| --- | --- |
| `repo_git_stage` | `repo_write_stage` |
| `repo_git_unstage` | `repo_write_unstage` |
| `repo_git_commit` | `repo_write_commit` |
| `repo_next_action` | `repo_current_work_session` when resuming; `repo_change_plan` for an explicit goal; `repo_git_review` or `repo_ship_review` for readiness |
| `repo_plan_review` | `repo_git_review` for current Git state; `repo_semantic_review` for focused semantic risks |

The canonical write-prefixed Git tools preserve the same bounded local
stage/unstage/commit responsibilities. No tool pushes, pulls, deploys, or runs
arbitrary shell commands.

## New optional capabilities

The direct workflow does not require every new tool. Continue to use the normal
path:

1. inspect with the bounded read tools;
2. edit with `repo_write_file` or `repo_write_changes`;
3. validate with `repo_validate`;
4. review with `repo_git_review` or `repo_ship_review`; and
5. use the exact reviewed local commit or recovery payload.

Context maps, symbol/code indexing, patchsets, work sessions, delegation,
operation ledgers, failure diagnosis, and standalone semantic review are
specialist capabilities to use only when the task benefits from them.

## Intentionally not included

The OSS server supports delegation artifacts and review, but it does not ship
an agent runner, provider adapter, scheduler, or the project development
harness. External agent execution remains a separate user-owned integration.
