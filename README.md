# GPT Repo MCP

Give ChatGPT practical repo tools for reading code, reviewing changes, editing files, planning work, and coordinating focused Codex/Claude tasks directly in your repo.

![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![MCP server](https://img.shields.io/badge/MCP-server-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178c6)
![Writes opt-in](https://img.shields.io/badge/writes-opt--in-orange)

GPT Repo MCP is a TypeScript MCP server for solo developers who want ChatGPT to work with approved repositories through a focused set of repo tools. ChatGPT can inspect project structure, read bounded files, review git state, plan changes, write one or many files when enabled, prepare local commits, and coordinate focused Codex/Claude task prompts.

ChatGPT becomes the reviewer and workflow coordinator around your repo. It can read the codebase, inspect the current git diff, compare Codex/Claude output with the actual changes, and help decide the next step: edit directly, revise, recover, stage, or create a local commit.

This project is not affiliated with OpenAI, ChatGPT, Anthropic, or the Model Context Protocol maintainers.

## What You Can Do

- Ask ChatGPT to understand a repo: structure, files, scripts, TODOs, decisions, and architecture.
- Review current git changes and get exact next-step payloads for staging, committing, or recovery.
- Let ChatGPT write one file or apply a cohesive multi-file edit pack after you enable write mode.
- Use ChatGPT as the reviewer after Codex/Claude work: read the agent result, inspect the git diff, and decide whether to revise, recover, stage, or commit.
- Prepare focused Codex/Claude prompts in chat or as repo-local task files when you want another agent to implement.
- Keep ChatGPT work organized with local session handoff notes for future ChatGPT chats.
- Ask why a path is blocked with `repo_policy_explain`.

## Core Workflow

1. ChatGPT reads the repo and plans the change.
2. ChatGPT can implement directly with single-file or multi-file writes.
3. Or ChatGPT can prepare a focused Codex/Claude task for another agent to run.
4. ChatGPT reviews the actual git diff and any Codex/Claude result written back into the repo.
5. ChatGPT recommends the next step: revise, recover, stage, or create a local commit.

## Quickstart

### 1. Install

```bash
git clone https://github.com/CAHN91/gpt-repo-mcp.git
cd gpt-repo-mcp
npm install
npm run build
cp config.example.json config.local.json
```

### 2. Add Your Repo

```bash
npm run add -- /path/to/your/repo
```

The copied starter config is valid and empty. This command adds the first approved repository.

Interactive terminals prompt for a permission mode: `read`, `write`, or `ship`.

For predictable setup in scripts or CI-like terminals:

```bash
npm run add -- /path/to/your/repo --mode read
npm run add -- /path/to/your/repo --mode write
npm run add -- /path/to/your/repo --mode ship
```

### 3. Connect ChatGPT

```bash
npm run connect
```

Copy the printed URL:

```text
ChatGPT MCP URL: https://<ngrok-host>/t/<random-token>/mcp
```

Paste it into ChatGPT Developer Mode connector settings, start a new chat, select the connector, and ask:

```text
Use GPT Repo MCP. Which repositories can you access?
```

Need help choosing **Server URL** vs **Tunnel ID**? See [ChatGPT connector setup](docs/CHATGPT_CONNECT.md#server-url-or-tunnel).

```text
Clone -> Install -> Add repo -> Choose mode -> Connect ChatGPT -> Start working
```

## Permission Modes

| Mode | Best For | What ChatGPT Can Do |
| --- | --- | --- |
| `read` | First install, project review, cautious exploration | Inspect repo structure, search/read files, review git status and diffs, plan work. |
| `write` | Daily implementation help | Everything in `read`, plus repo file writes guarded by policy, path checks, secret checks, and size limits. |
| `ship` | Local commit prep | Everything in `write`, plus local stage, commit, recover, and cleanup operations after approval. |

No mode enables push, pull, reset, checkout, switch, rebase, merge, stash, force, branch deletion, shell execution, or arbitrary command execution.

## Example ChatGPT Prompts

These are examples of what you can ask ChatGPT once the connector is active. Use them as patterns, not required commands.

```text
What repositories can you access through GPT Repo MCP?
```

```text
Give me a project brief for <repo_id>. Focus on the app structure, scripts, docs, and likely entrypoints.
```

```text
Review the current git diff in <repo_id>. Summarize the changed files, risks, and whether this looks ready to commit.
```

```text
Read README.md and docs/SETUP.md in <repo_id>, then suggest the next documentation improvement.
```

```text
Read src/auth.ts and tests/auth.test.ts in <repo_id>, then implement the login expiry fix directly in the repo.
```

```text
Can you write to src/app.ts in <repo_id>? Explain which policy allows or blocks it.
```

```text
Prepare a focused Codex prompt for implementing dashboard filters in <repo_id>. Include files to inspect and verification commands.
```

```text
Write a repo-local Codex task for fixing the failing auth test in <repo_id>.
```

```text
Codex is done. Review the Codex result and the git diff for <repo_id>.
```

## Tool Categories

| Category | Tools |
| --- | --- |
| Repo discovery | `repo_list_roots`, `repo_tree`, `repo_search`, `repo_fetch_file`, `repo_read_many` |
| Policy help | `repo_policy_explain` |
| Planning | `repo_project_brief`, `repo_task_inventory`, `repo_decision_memory`, `repo_change_plan`, `repo_next_action`, `repo_plan_review` |
| Git review | `repo_git_status`, `repo_git_diff`, `repo_git_review` |
| File writes | `repo_write_file`, `repo_write_changes` |
| ChatGPT session continuity | `repo_write_handoff`, `repo_last_write` |
| Local ship flow | `repo_write_stage`, `repo_write_unstage`, `repo_write_commit`, `repo_write_stage_commit`, `repo_write_recover`, `repo_cleanup_paths` |
| Compatibility aliases | `repo_git_stage`, `repo_git_unstage`, `repo_git_commit` |
| Codex/Claude coordination | `repo_prepare_codex_task`, `repo_write_codex_task`, `repo_codex_review` |

See [docs/TOOL_SURFACE.md](docs/TOOL_SURFACE.md) for full schemas, examples, output shapes, and recommended workflows.

## Codex/Claude Task Flow

GPT Repo MCP supports two ways to coordinate focused external-agent work.

### Chat-Copy Mode

Ask ChatGPT for a focused Codex/Claude prompt:

```text
Prepare a focused Codex prompt for fixing login expiry. Include the files to inspect and the verification command.
```

ChatGPT returns a copyable prompt in the chat. You can review it, edit it, and paste it into Codex or Claude.

### Repo-Local Mode

Ask ChatGPT to write the task into the repo:

```text
Write a repo-local Codex task for fixing login expiry.
```

The MCP writes:

- `.chatgpt/codex-runs/<run_id>/PROMPT.md`
- `.chatgpt/codex-runs/<run_id>/run.json`

Give Codex or Claude the returned prompt path. The generated task asks the agent to write:

- `.chatgpt/codex-runs/<run_id>/RESULT.md`

Then ask ChatGPT:

```text
Review the Codex result and the git diff for <run_id>.
```

ChatGPT can read the result, inspect the diff, and recommend the next step.

## ChatGPT Session Handoffs

In this repo, a handoff means a ChatGPT-to-ChatGPT session note. It is not the Codex/Claude task flow.

Use `repo_write_handoff` when you want ChatGPT to write local context for a future ChatGPT chat, including current state, decisions, next steps, risks, and important files.

## Boundaries

GPT Repo MCP is intentionally not a shell runner.

- ChatGPT works through named repository ids and repo-relative paths.
- Mutating tools are disabled until a repo opts in.
- File writes are checked against allow/deny policy, path sandboxing, size limits, and secret scanning.
- Git tools operate only on explicit paths and local commits.
- There are no tools for push, pull, reset, checkout, switch, rebase, merge, stash, force, branch deletion, shell execution, or arbitrary command execution.

Read the full model in [docs/SECURITY.md](docs/SECURITY.md).

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the MCP server and CLI. |
| `npm run doctor` | Check config, scripts, tunnel state, port use, and git status. |
| `npm run connect` | Start the MCP server and try to use or reuse an ngrok HTTPS tunnel. |
| `npm run connect:secure` | Start the MCP server and OpenAI Secure MCP Tunnel. |
| `npm run mcp` | Start only the local MCP server with `config.local.json`. |
| `npm run tunnel` | Start only an ngrok tunnel to local port `8787`. |
| `npm run list` | List approved repositories. |
| `npm run add -- <path>` | Add an approved repository root. |
| `npm run add -- <path> --mode <mode>` | Add a repository root with explicit `read`, `write`, or `ship` mode. |
| `npm run remove -- <repo_id>` | Remove an approved repository root. |
| `npm run check:config` | Validate local config. |
| `npm test -- tests/tool-contracts.test.ts tests/mcp-contract.test.ts` | Run focused MCP contract checks. |

## Requirements

- Node.js 20 or newer
- npm
- git
- ngrok for the built-in `npm run connect` convenience tunnel, or another HTTPS tunnel for manual setup
- ChatGPT account with Developer Mode access

New to ngrok? See [Install ngrok from zero](docs/SETUP.md#install-ngrok-from-zero).

## Documentation

- [Setup](docs/SETUP.md)
- [ChatGPT connector steps](docs/CHATGPT_CONNECT.md)
- [Connection options](docs/CONNECTION_OPTIONS.md)
- [Tool surface](docs/TOOL_SURFACE.md)
- [Write workflows](docs/WRITE_WORKFLOWS.md)
- [Security model](docs/SECURITY.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)

## Troubleshooting

- Unknown `repo_id`: run `npm run list`.
- Connector URL changed: restart `npm run connect` and update ChatGPT Developer Mode with the new printed URL.
- Write blocked: ask ChatGPT to run `repo_policy_explain` for the repo id and path.
- Schema mismatch: refresh ChatGPT Developer Mode and run `npm test -- tests/mcp-contract.test.ts tests/tool-contracts.test.ts`.
- Tunnel 502: confirm the local server is running, check `/health`, then restart ngrok or try a fresh tunnel.

## License

MIT. See [LICENSE](LICENSE).
