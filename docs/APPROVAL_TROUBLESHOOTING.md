# Approval Troubleshooting

Use this checklist when a mutating tool dry-run succeeds but the actual tool call is blocked before the user sees an approval prompt.

## Checklist

- Verify `tools/list` includes the mutating tools relevant to the blocked flow:
  - `repo_write_file`
  - `repo_write_changes`
  - `repo_write_handoff`
  - `repo_write_codex_task`
  - `repo_git_restore_paths`
  - `repo_write_stage`
  - `repo_write_unstage`
  - `repo_write_commit`
  - `repo_write_stage_commit`
  - `repo_write_recover`
  - `repo_cleanup_paths`
- Verify connector metadata was refreshed after changing tool schemas, descriptions, or server instructions.
- Verify `src/instructions.ts` describes the app as read-mostly and does not call it read-only.
- Verify `config.local.json` enables the relevant write or operations policy for the target repo.
- Verify the dry-run call succeeds before the actual mutation.
- Verify the same operation works through MCP Inspector, API Playground, or a raw MCP client if available.

## How To Tell Where A Block Happened

Check the local server stderr audit logs. Each `/mcp` request that reaches the server emits `mcp_request_start` and `mcp_request_finish` with a `request_id`. Tool handlers emit their normal tool audit with the same `request_id`.

| Local logs | Meaning |
| --- | --- |
| ChatGPT says the call was blocked by OpenAI safety checks, with no `mcp_request_start` and no tool audit | The call was blocked before reaching the local MCP server. |
| `mcp_request_start` exists, but no tool audit exists for the same `request_id` | The request reached `/mcp`, but did not reach the tool handler. Inspect MCP session, transport, and routing. |
| `mcp_request_start` and a tool audit with a warning or error code exist for the same `request_id` | The server received the call and rejected it through validation, policy, or runtime handling. |
| `mcp_request_start` and a successful tool audit exist for the same `request_id` | Normal server path. |

For blocked-before-approval cases, the absence of any local `request_id` or audit entry is the key evidence. Request diagnostics include only safe metadata such as method, route, session presence, MCP method, and MCP tool name; they do not include tool arguments or request bodies.

For easier terminal scanning, start the connector with pretty audit logs:

```bash
GPT_REPO_LOG_FORMAT=pretty npm run connect
```

JSON audit logs remain the default. Pretty logs are compact one-line renderings of the same sanitized metadata.

## If A Commit Tool Is Blocked Before Approval

Use the canonical `repo_write_stage`, `repo_write_unstage`, and `repo_write_commit` tools for granular Git operations. There are no duplicate git-prefixed mutation aliases.

1. Confirm `repo_write_commit` with `dry_run: true` passed.
2. Confirm the intended paths are staged with `repo_git_status`.
3. If needed, stage explicit files with `repo_write_stage`.
4. Use the manual fallback:

```bash
git commit -m "<message>"
```

This indicates client-side pre-approval blocking, not necessarily a server policy failure. The server still requires repo-local operations opt-in, exact `expected_head_sha`, and exact `expected_staged_paths`, and it creates a local commit only. It does not push, pull, reset, checkout, switch, rebase, merge, stash, clean, force, delete branches, or run shell commands.

## Canonical Git Tool Names

Safe local Git mutations have one public name each: `repo_write_stage`, `repo_write_unstage`, `repo_write_commit`, and `repo_write_stage_commit`. This avoids duplicate approval surfaces and ambiguous tool selection.
