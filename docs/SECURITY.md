# Security Model

GPT Repo MCP gives ChatGPT useful repository access without turning the
connection into a general-purpose terminal. Its security model is based on
least authority: you approve each repository, choose its permission mode, and
the server independently validates every tool call.

This page explains the practical guarantees, remaining risks, and choices you
control. For reporting a vulnerability, see the repository's
[security policy](../SECURITY.md).

## Security Model At A Glance

| Area | Protection |
| --- | --- |
| Repository access | Only repositories explicitly registered in local configuration are available |
| File access | Paths are resolved inside the approved root and checked against exclusions and secret-path rules |
| Writes | Disabled by default and limited by repository policy, path rules, size limits, stale-state checks, and secret scanning |
| Validation | Limited to repository-approved test, build, lint, type-check, and smoke profiles |
| Git | Review, staging, recovery, and local commits use explicit paths and current-state checks |
| Network | The server binds locally by default; tunnel URLs must be treated as sensitive temporary access links |
| Automation | No arbitrary shell, automatic push, automatic deployment, or built-in implementation-agent runner |

The model guides the workflow, but the server enforces these boundaries. A
prompt cannot expand an approved root, enable a disabled capability, bypass a
denied path, or turn a validation profile into an arbitrary command.

## What Stays Local And What Is Sent To ChatGPT

GPT Repo MCP runs on your machine and operates on the local repository you
approved. It does not upload the repository as a complete archive or mirror.

Information returned by a tool call does travel through the MCP connection to
ChatGPT. Depending on the request, that can include selected file contents,
search matches, Git diffs, validation output, and safe repository metadata.
Only ask ChatGPT to inspect information you are comfortable sending through
the configured ChatGPT connection.

Most tools identify repositories by a local `repo_id` and use repo-relative
paths. The repository-listing tool can also return the configured root path so
you can verify which local directory was approved.

## Permission Modes

The CLI provides three practical presets:

| Mode | Intended use | Local authority |
| --- | --- | --- |
| `read` | Exploration and review | Search, read, inspect structure, and review Git state |
| `write` | Implementation | Read capabilities plus policy-checked file changes |
| `ship` | Reviewed local completion | Write capabilities plus approved validation, recovery, staging, and local commits |

Changing modes changes local configuration. It never enables push, pull,
merge, deployment, history rewriting, arbitrary shell commands, or access to
other repositories.

Use `repo_policy_explain` when you want ChatGPT to show the effective read,
write, validation, Git, or cleanup policy for a repository or path.

## Repository And Path Boundaries

ChatGPT supplies a `repo_id`; the server resolves it to a locally approved
root. Unknown repository ids are rejected.

Every requested path must be relative to that root. The server rejects:

- absolute paths and parent-directory traversal;
- symlinks that escape the approved repository;
- device files, sockets, and named pipes;
- Git internals, dependency directories, generated output, and other default
  exclusions where the tool does not explicitly support them; and
- paths that look like real secrets, credentials, private keys, or environment
  files.

Nested Git repositories and submodules are separate trust boundaries. Register
them as their own repository id if ChatGPT should access them.

## Read Protection

Read tools return bounded results rather than recursively exposing an entire
repository. Searches, multi-file reads, diffs, and diagnostics have result-size
limits and indicate when output was truncated.

Real environment files, private keys, certificate bundles, identity files, and
directories explicitly named for secrets or credentials are blocked. Public
templates such as `.env.example` can be read only when their contents pass
secret scanning.

Generated or normally excluded files require an explicit supported override.
Secret-looking paths remain blocked even with that override.

## Write Protection

Writes are opt-in per repository. Before changing a file, the server checks:

- that the path remains inside the approved root;
- the repository's allowed and denied write patterns;
- hard blocks for secrets, Git internals, dependencies, and unsafe file types;
- maximum file and operation sizes;
- optional expected file hashes or expected Git HEAD state; and
- secret-looking values in the resulting content.

Multi-file changes are validated before the first write. If a later write
fails, GPT Repo MCP attempts to restore files already changed by that operation
and returns bounded recovery information.

Secret scanning is defense in depth, not a replacement for a secret manager.
Do not place real credentials in prompts, source files, examples, or handoff
notes.

## Validation Without A General Terminal

ChatGPT can run only validation profiles enabled by the repository. Supported
profiles cover tests, builds, linting, type checks, smoke checks, or the
configured complete suite.

The server maps those profiles to known project workflows and executes them
without a shell. ChatGPT cannot provide a command string, add arbitrary command
arguments, install a runtime, or invent a new script. Output is bounded and
redacted before it is returned.

## Git Review And Local Commits

Git reading is available for status, diffs, and review. Mutating Git operations
require `ship`-level configuration and use explicit repo-relative paths.

Before staging or committing, GPT Repo MCP verifies the expected HEAD, the
reviewed path set, current staged state, and applicable validation or review
evidence. The normal completion path stages only the reviewed files and creates
one local commit.

GPT Repo MCP does not push, pull, merge, rebase, reset, switch branches, stash,
clean the repository, force operations, or delete branches.

Commands run manually in a terminal are outside MCP enforcement. GPT Repo MCP
can review the resulting repository state, but it cannot prevent another local
process or user from changing files or Git state.

## Approvals And Visible Side Effects

Read-only tools are marked as read-only for the host. Calls that write files,
create local metadata, start optional indexing, validate, recover, stage, or
commit are marked as having local side effects so the host can present an
approval prompt.

Approval presentation is controlled by the ChatGPT client. Server policy is
still checked even after the host approves a call. Many mutating tools also
support `dry_run` when you explicitly want a preview.

## Recovery And Local Working Metadata

Successful writes record bounded local receipts that help ChatGPT review or
recover the affected paths. Transactional patchsets can offer rollback only
while the recorded Git and file state still match.

Work sessions can retain content-free progress such as paths, decisions,
validation references, risks, and next steps. Human-readable handoff notes are
local working files intended for a later conversation. These artifacts live
under `.chatgpt/`, are ignored by Git in the recommended setup, and should not
be committed.

Recovery is deliberately narrow. It operates on explicit reviewed paths and
does not hide broad `reset`, `stash`, `checkout`, or `git clean` behavior.

## External Agent Boundary

GPT Repo MCP can prepare task artifacts and review results from an external
implementation agent. It does not start, resume, schedule, authenticate, or
provide credentials to Codex, Claude, or another agent.

The external process remains user-operated and outside the MCP security
boundary. An agent's claims are treated as evidence, not proof; ChatGPT reviews
the actual repository state before local completion is offered.

## Network And Tunnel Safety

The HTTP server binds to `127.0.0.1` by default. The standard `npm run connect`
flow exposes it through a temporary ngrok URL containing a random path token.
That token provides guess resistance, not user authentication. Anyone who has
the full URL may reach the MCP endpoint while the tunnel is running.

- Do not publish, commit, or share an active tunnel URL.
- Stop the tunnel when the ChatGPT session is finished.
- Treat tunnel credentials and Secure MCP Tunnel API keys as secrets.
- Use the supported external-bind settings only when you understand the network
  exposure.

OpenAI Secure MCP Tunnel keeps the local endpoint private and forwards requests
through an outbound connection when that option is available. Connection
choices and setup details are documented in
[Connection options](CONNECTION_OPTIONS.md).

Network access never expands repository permissions. Every request still passes
the same repository, path, secret, write, validation, and Git checks.

## Logs And Error Handling

Audit logs contain operational metadata such as tool name, repository id,
repo-relative paths, counts, duration, warning codes, and request ids. They are
designed not to contain file contents, raw diffs, prompts, credentials,
environment values, headers, stack traces, or unredacted command output.

Client errors use sanitized messages and stable error codes. Unexpected errors
are converted to generic internal failures instead of returning raw exceptions.

## Important Limitations

GPT Repo MCP reduces authority; it is not a virtual machine or an operating
system sandbox.

- A malicious or compromised local process with filesystem access can operate
  outside GPT Repo MCP.
- A leaked active tunnel URL can expose the MCP endpoint until the tunnel stops.
- Secret detection is pattern-based and cannot identify every sensitive value.
- Host approval behavior depends on the connected ChatGPT client.
- Manually executed Git or shell commands are outside server enforcement.

Use a dedicated development checkout, keep credentials outside the repository,
review requested mutations, and start with `read` mode when evaluating the
project.

## Maintainer Security Verification

Contributor-facing dependency policy and public-release verification are kept
separate from the user security model:

- [Dependency security](DEPENDENCY_SECURITY.md)
- [Release checklist](RELEASE_CHECKLIST.md)
- [Contributing](../CONTRIBUTING.md)
