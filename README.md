# GPT Repo MCP

**Let ChatGPT work from your repo — safely.**

[![CI](https://github.com/CAHN91/gpt-repo-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/CAHN91/gpt-repo-mcp/actions/workflows/ci.yml)
![Node.js >=20](https://img.shields.io/badge/Node.js-%3E%3D20-339933)
[![License: MIT](https://img.shields.io/badge/License-MIT-111111)](LICENSE)
![Writes opt-in](https://img.shields.io/badge/Writes-opt--in-157f53)

GPT Repo MCP connects ChatGPT to approved local repositories through a focused,
policy-controlled toolset. ChatGPT can understand a codebase, edit multiple
files, run approved checks, diagnose failures, review the real Git diff, and
prepare a local commit — while you stay in the normal ChatGPT conversation.

Your files remain in the workspace you approved. You choose whether each
repository is read-only, writable, or ready for reviewed local commit work.

> GPT Repo MCP is a tool-only MCP server. It does not add a custom interface to
> ChatGPT and is not affiliated with OpenAI, ChatGPT, Anthropic, or the Model
> Context Protocol maintainers.

## What Becomes Possible

| Your goal | What ChatGPT can do |
| --- | --- |
| Understand an unfamiliar project | Map the structure, search code, read relevant files, and trace dependencies |
| Build a feature or application | Plan and apply cohesive edits across one or many files in an approved repository |
| Fix a failing implementation | Run approved tests, builds, linting, type checks, or smoke checks and use the evidence to correct the code |
| Review work before it ships | Inspect current file bytes and the real Git diff, identify risks, and verify what remains |
| Finish a local change safely | Validate, review, stage, recover, or create a local commit when the repository policy allows it |
| Continue in a later conversation | Preserve bounded local context, decisions, risks, touched files, and next steps |

ChatGPT chooses a workflow that fits your request. GPT Repo MCP independently
enforces repository access, path boundaries, write policy, secret checks,
validation profiles, stale-state guards, and allowed Git operations.

[Explore the capability guide](docs/CAPABILITIES.md) ·
[Review the security model](docs/SECURITY.md) ·
[Browse the complete tool reference](docs/TOOL_SURFACE.md)

## From Request To Reviewed Result

```text
You ask in ChatGPT
        ↓
Understand → Edit → Validate → Review → Local commit
        ↓
Approved local repository
```

A question may need only search and reading. An implementation can continue
through multi-file editing, approved validation, review, and local commit
preparation. ChatGPT receives tool descriptions, schemas, safety annotations,
and structured results that help it select the next appropriate action.

The model guides the work; the server enforces the boundary. No prompt can turn
the server into unrestricted filesystem access, arbitrary shell execution,
automatic push, or automatic deployment.

## Quickstart

### 1. Install

```bash
git clone https://github.com/CAHN91/gpt-repo-mcp.git
cd gpt-repo-mcp
npm install
npm run build
cp config.example.json config.local.json
```

The copied starter config is valid and empty.

### 2. Approve a repository

```bash
npm run add -- /path/to/your/repo
```

In an interactive terminal, choose `read`, `write`, or `ship`. For predictable
setup in scripts or CI-like terminals, provide an explicit `read`, `write`, or
`ship` mode:

```bash
npm run add -- /path/to/your/repo --mode read
npm run add -- /path/to/your/repo --mode write
npm run add -- /path/to/your/repo --mode ship
```

The general command form is `npm run add -- <path> --mode <mode>`.

### 3. Connect ChatGPT

```bash
npm run connect
```

Copy the printed MCP URL into ChatGPT Developer Mode connector settings, start
a new chat, select the connector, and ask:

```text
Use GPT Repo MCP. Which repositories can you access?
```

New to ngrok? Follow [Install ngrok from zero](docs/SETUP.md#install-ngrok-from-zero).
For the OpenAI Secure MCP Tunnel, use `npm run connect:secure` and follow the
[connection guide](docs/CONNECTION_OPTIONS.md).

## Permission Modes

| Mode | Best for | Available outcome |
| --- | --- | --- |
| `read` | Exploration, architecture review, and cautious first use | Search, read, understand, and review repository state |
| `write` | Daily implementation | Read capabilities plus policy-checked single- and multi-file edits |
| `ship` | Reviewed local completion | Write capabilities plus approved validation, recovery, staging, and local commits |

No mode enables push, pull, reset, checkout, switch, rebase, merge, stash,
force operations, branch deletion, shell execution, or arbitrary commands.

## Try It In ChatGPT

```text
Give me a project brief for <repo_id>. Explain the architecture and likely entry points.
```

```text
Implement this feature in <repo_id>. Update every affected file, run the approved checks, and review the final diff.
```

```text
Diagnose the failing tests in <repo_id>, fix the underlying issue, and verify the result.
```

```text
Review the current Git changes in <repo_id>. Tell me what is ready, what is risky, and what still needs work.
```

```text
Prepare this completed change for a local commit, but do not push or deploy anything.
```

More examples and resulting workflows are available in the
[capability guide](docs/CAPABILITIES.md).

## Canonical Development Workflow

Direct ChatGPT implementation is the default:

1. Read `repo_project_brief` when project context is needed, or
   `repo_current_work_session` when resuming previous work.
2. Locate evidence with search and bounded reads.
3. Implement with `repo_write_file` or `repo_write_changes`.
4. Run an approved `repo_validate` profile.
5. Review current repository state with `repo_ship_review` or
   `repo_git_review`.
6. Use the exact reviewed `repo_write_stage_commit` payload when ready, or
   `repo_write_recover` when recovery is required.

Delegation is optional. When explicitly requested, GPT Repo MCP can prepare a
repository-owned task, inspect its bounded result, and record a state-bound
review with `repo_write_codex_review`. The public server records and reviews
the handoff; it does not execute agents or manage external processes.

See [Write workflows](docs/WRITE_WORKFLOWS.md) and
[Delegation artifacts](docs/DELEGATION_ARTIFACTS.md) for the specialist paths.

## Safety By Design

- Only explicitly approved repository roots are accessible.
- Every path is repo-relative and sandboxed against traversal and symlink escapes.
- Writes are disabled until the repository opts in.
- File changes are checked against allowed paths, denied paths, size limits,
  stale-state guards, and secret patterns.
- Validation uses configured profiles instead of arbitrary commands.
- Git mutations operate on explicit paths and current reviewed state.
- Push and deployment remain outside the server.

For the full boundary, threat model, and approval behavior, read
[Security](docs/SECURITY.md).

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run add -- <path>` | Approve a repository and choose a permission mode |
| `npm run add -- <path> --mode <mode>` | Add a repository with an explicit `read`, `write`, or `ship` mode |
| `npm run list` | List approved repositories |
| `npm run remove -- <repo_id>` | Remove an approved repository |
| `npm run doctor` | Check configuration, scripts, tunnel state, port use, and Git state |
| `npm run connect` | Start the server and built-in ngrok connection flow |
| `npm run connect:secure` | Start the server with the OpenAI Secure MCP Tunnel |
| `npm run check:config` | Validate local configuration |

## Documentation

| Start here | When you need... |
| --- | --- |
| [Capability guide](docs/CAPABILITIES.md) | A user-oriented explanation of what ChatGPT can accomplish |
| [Setup](docs/SETUP.md) | Installation and local configuration |
| [ChatGPT connection](docs/CHATGPT_CONNECT.md) | Connector setup inside ChatGPT |
| [Connection options](docs/CONNECTION_OPTIONS.md) | ngrok, Cloudflare, secure tunnel, and manual alternatives |
| [Write workflows](docs/WRITE_WORKFLOWS.md) | Editing, validation, review, recovery, and local commits |
| [Tool surface](docs/TOOL_SURFACE.md) | Exact schemas, outputs, and all 46 tools |
| [Security](docs/SECURITY.md) | Permissions, sandboxing, approvals, and operational boundaries |
| [Architecture](docs/ARCHITECTURE.md) | Internal structure and extension points |
| [Migration guide](docs/MIGRATION.md) | Moving from 0.1.x to 0.2.0 |

Also see the [changelog](CHANGELOG.md), [terminology](docs/GLOSSARY.md), and
[release checklist](docs/RELEASE_CHECKLIST.md).

## Requirements

- Node.js 20 or newer
- npm
- Git
- An HTTPS tunnel such as ngrok, or the supported secure tunnel flow
- ChatGPT with Developer Mode access

## Troubleshooting

- **Unknown repository:** run `npm run list` and confirm the `repo_id`.
- **Write blocked:** ask ChatGPT to use `repo_policy_explain` for the repository and path.
- **Connector URL changed:** restart the connection and update ChatGPT with the new URL.
- **Tunnel returns 502:** confirm the local server is running, check `/health`, and restart the tunnel.
- **Tool schema looks stale:** refresh the connector and start a new ChatGPT conversation.

For detailed diagnostics, see [Setup](docs/SETUP.md#common-failure-modes) and
[Approval troubleshooting](docs/APPROVAL_TROUBLESHOOTING.md).

## License

MIT. See [LICENSE](LICENSE).
