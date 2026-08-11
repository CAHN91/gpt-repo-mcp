# Product Principles

GPT Repo MCP is for developers who want ChatGPT to work with a real local
repository while keeping repository access narrow, visible, and reversible.
This page explains the product choices users should be able to rely on.

## Who It Is For

The primary user is a solo developer or small technical team that wants
ChatGPT to understand, change, validate, review, and locally commit work in an
approved repository.

Many users already work with Codex or another coding agent. GPT Repo MCP
complements those tools by giving ChatGPT current repository context, controlled
development capabilities, and a way to review and coordinate the same local
work without repeatedly copying files or reconstructing context in the
conversation.

## The Expected Experience

A normal task follows a simple path:

1. ChatGPT inspects the approved repository and relevant files.
2. It changes one file or a coherent set of files when writes are enabled.
3. It runs only repository-approved validation.
4. It reviews the actual Git state and remaining risks.
5. It either prepares a reviewed local commit or recovers the affected paths.

Simple questions can stop after reading. Specialist capabilities such as
transactional patchsets, work sessions, code indexing, or external-agent review
are available when the task benefits from them, but they are not required for
ordinary work.

## Product Promises

Users should be able to rely on these guarantees:

- Only explicitly approved repositories are available.
- Repository permissions are clear: `read`, `write`, or `ship`.
- The server offers focused repository capabilities, never arbitrary shell
  access or unrestricted filesystem access.
- Writes and local Git operations are policy-checked and visible to the host
  approval flow.
- Current file bytes, Git state, and validation evidence take precedence over
  assumptions or external-agent claims.
- Failures return useful, sanitized guidance without exposing credentials,
  absolute local paths, stack traces, or raw environment values.
- The server may create a reviewed local commit when authorized. It never
  pushes, merges, deploys, or rewrites Git history.
- Recovery is explicit and path-scoped rather than based on broad reset or
  cleanup commands.

## User Control

The user chooses:

- which local repositories are approved;
- the permission mode for each repository;
- the development outcome to pursue;
- whether mutating calls are approved;
- whether a completed change should be committed; and
- whether anything is later pushed, merged, or deployed outside GPT Repo MCP.

ChatGPT chooses a suitable workflow for the request. The MCP server separately
enforces repository, path, validation, write, secret, and Git policy on every
call.

## External-Agent Work

GPT Repo MCP can prepare bounded task artifacts and review results produced by
an external implementation agent. It does not include, launch, authenticate,
or control that agent.

External-agent claims are treated as evidence rather than proof. The normal
review, validation, and local-commit gates still apply to the real repository
state.

## Compatibility

Public tool names, documented payload fields, error codes, and persisted
artifact formats are versioned compatibility contracts. Breaking changes
should have a documented reason, migration path, and release note.

Some public names retain terms such as `codex` or `ship` for compatibility.
Here, “ship” means readiness for a reviewed local result; it does not mean push
or deployment. See [Terms and compatibility names](GLOSSARY.md).

## Related Guides

- [Capability guide](CAPABILITIES.md)
- [Tools and workflows](TOOL_SURFACE.md)
- [Security model](SECURITY.md)
- [Write workflows](WRITE_WORKFLOWS.md)
- [Architecture](ARCHITECTURE.md)
- [Delegation artifact protocol](DELEGATION_ARTIFACTS.md)
