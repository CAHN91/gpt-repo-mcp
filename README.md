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

## How ChatGPT Works With Your Repo

You describe the outcome you want. GPT Repo MCP gives ChatGPT a guided,
controlled path from understanding the repository to producing a reviewed
local result:

```text
Understand -> Edit -> Validate -> Review -> Local commit
```

| You ask ChatGPT to... | ChatGPT can... | GPT Repo MCP keeps control by... |
| --- | --- | --- |
| Understand a project | Map structure, search code, read relevant files, and identify dependencies | Limiting access to approved repositories and bounded reads |
| Build or change something | Plan the work and edit one or many files as a cohesive change | Enforcing write policy, path safety, size limits, stale-state guards, and secret checks |
| Fix a failure | Run approved tests, builds, linting, type checks, or smoke checks and interpret the result | Allowing configured validation profiles instead of arbitrary shell commands |
| Review existing work | Inspect the real Git diff, identify risks, and decide what still needs attention | Using repository state and current file bytes instead of trusting claims |
| Prepare the result | Validate, review, stage, recover, or create a local commit when authorized | Rechecking exact paths, HEAD, review evidence, and host approval before mutation |
| Continue later | Preserve local progress, decisions, risks, and next steps | Keeping continuity artifacts local and content-bounded |
| Coordinate another agent | Prepare and review structured Codex or Claude tasks | Keeping task creation separate from runner execution, commit, push, and deployment |

When the connector starts, ChatGPT receives workflow instructions, tool
descriptions, input schemas, safety annotations, and structured tool results.
Those signals help it choose a workflow that fits the request: a question may
need only search and reading, while an implementation may continue through
multi-file editing, validation, review, and local commit preparation.

ChatGPT chooses which capability to use, but it does not enforce the security
boundary. The server independently checks repository access, permissions,
paths, secrets, validation profiles, stale state, and allowed local Git
operations. It never adds arbitrary shell access, automatic push, or automatic
deployment.

See [Capability guide](docs/CAPABILITIES.md) for the user-oriented workflows
and [Tool surface](docs/TOOL_SURFACE.md) for exact tool schemas and outputs.

## Canonical Development Workflow

1. Read `repo_project_brief` when product or repository context is needed, or `repo_current_work_session` when resuming. Active and blocked continuity includes the full session; completed current-pointer history is compact and requires an explicit `work_session_id` lookup for full details.
2. Locate evidence with `repo_search`, then read only the relevant files with `repo_fetch_file` or `repo_read_many`. Use context or symbol mapping only when impact analysis requires it.
3. Implement directly with `repo_write_file` or `repo_write_changes` by default. Use agent delegation only when the user explicitly asks for it.
4. Validate through an allowlisted `repo_validate` profile.
5. Review with `repo_ship_review` for bounded pre-ship readiness, or `repo_git_review` for Git and recovery planning.
6. Use the exact review-provided `repo_write_stage_commit` payload when the change is ready, or `repo_write_recover` when it is not.

Backlog inventory, decision memory, patchsets, delegation, standalone semantic review, and granular Git tools are specialist paths rather than required workflow steps.

## Drift Monitoring

`repo_agent_runs` list mode includes a bounded, deterministic `drift_summary` for validated Delegation v3 history. It can surface correction loops, repeated scope extensions, growing prompts or authorization, repeated changed areas, failed product reviews, technical-root dominance, and checkpoint cadence. `repo_project_brief.product_brief` exposes only the compact checkpoint state.

These signals are advisory evidence. They never select the next feature, replace the current work session, add workflow steps, or mutate the repository. The repository test suite locks the canonical 46-tool surface and prevents removed tools, aliases, legacy creation workflows, or an unreviewed integration bypass from silently returning.

## Reviewed multi-run integration

Several related Delegation v3 runs may intentionally share one dirty worktree. Each run is reviewed and attested against only its attributed path bytes. The owner can then call `repo_write_integration_review` to create an exact, hash-bound integration pathset and use the returned token for one atomic local `repo_write_stage_commit`. Extra paths, stale bytes, failed product verdicts, stale validation, forbidden/secret paths, or incomplete semantic evidence block. No force or push route is added.

## Architecture and Delegation

The stable public architecture is documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Delegation is a repository-owned
artifact and review protocol; the public server does not include or start an
agent runner. See
[docs/DELEGATION_ARTIFACTS.md](docs/DELEGATION_ARTIFACTS.md) for its persisted
contracts, privacy boundary, stale-state rules, and multi-run integration flow.

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
| `ship` | Local commit prep | Everything in `write`, plus local validation, stage, commit, recover, and cleanup operations after host approval. |

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
Prepare a product-grounded Delegation v3 task for implementing dashboard filters in <repo_id>. Keep starting points advisory, authorization explicit, and product and technical acceptance separate.
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
| Context and planning | `repo_project_brief`, `repo_current_work_session`, `repo_change_plan`, `repo_context_map`, `repo_symbol_context`, `repo_code_index`, `repo_task_inventory`, `repo_decision_memory` |
| Diagnosis and ship review | `repo_failure_diagnose`, `repo_semantic_review`, `repo_ship_review` |
| Git review | `repo_git_status`, `repo_git_diff`, `repo_git_review` |
| File writes | `repo_write_file`, `repo_write_changes` |
| ChatGPT session continuity | `repo_write_handoff`, `repo_last_write` |
| Local ship flow | `repo_validate`, `repo_write_stage`, `repo_write_unstage`, `repo_write_commit`, `repo_write_stage_commit`, `repo_write_recover`, `repo_cleanup_paths` |
| Codex/Claude coordination | `repo_prepare_codex_task`, `repo_write_codex_task`, `repo_agent_runs`, `repo_write_agent_reply`, `repo_codex_review` |

See [docs/TOOL_SURFACE.md](docs/TOOL_SURFACE.md) for full schemas, examples, output shapes, and recommended workflows.

## Codex/Claude Delegation v3 Flow

Direct ChatGPT implementation remains the default. Use delegation tools only when the user explicitly asks for a Codex prompt, repo-local task, or implementation-agent run.

For preview-only chat-copy mode, `repo_prepare_codex_task` validates a strict Delegation v3 task without writing it. For durable repo-local delegation, `repo_write_codex_task` writes:

- `.chatgpt/codex-runs/<run_id>/PROMPT.md`
- `.chatgpt/codex-runs/<run_id>/run.json`
- `.chatgpt/codex-runs/<run_id>/review-gate.json`

Every new task declares a task kind, beneficiary, current problem, desired outcome, why-now, advisory starting points, an authorization boundary, hard constraints, preservation rules, exclusions, and separate product and technical acceptance criteria where applicable. The agent writes strict machine-readable evidence to `RESULT.json`; v3 does not use `RESULT.md` as result evidence.

Use `repo_agent_runs` for bounded lifecycle status and structured questions. After the agent finishes:

```text
repo_codex_review
→ repo_write_codex_review
→ repo_ship_review
→ repo_write_stage_commit or repo_write_recover
```

`repo_codex_review` verifies prompt, manifest, baseline, authorization, connected changes, TAC evidence, PAC evidence, and technical readiness. `repo_write_codex_review` records the state-bound qualitative product verdict. Only a current passing or valid technical-only attestation can open the shared ship gate. Historical v1/v2 runs remain reviewable through isolated legacy readers, but cannot be newly created.

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

## Upgrading

Version 0.2.0 adds new review, validation, work-session, patchset, code-context,
and delegation capabilities. Five overlapping 0.1.x tool names have canonical
replacements. See the [0.2.0 migration guide](docs/MIGRATION.md) before
refreshing the connector.

## Documentation

- [Changelog](CHANGELOG.md)
- [Migrating from 0.1.x](docs/MIGRATION.md)
- [Product and UX contract](docs/PRODUCT.md)
- [Capability guide](docs/CAPABILITIES.md)
- [Current and compatibility terminology](docs/GLOSSARY.md)
- [Setup](docs/SETUP.md)
- [ChatGPT connector steps](docs/CHATGPT_CONNECT.md)
- [Connection options](docs/CONNECTION_OPTIONS.md)
- [Tool surface](docs/TOOL_SURFACE.md)
- [Write workflows](docs/WRITE_WORKFLOWS.md)
- [Delegation artifact protocol](docs/DELEGATION_ARTIFACTS.md)
- [Architecture](docs/ARCHITECTURE.md)
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
