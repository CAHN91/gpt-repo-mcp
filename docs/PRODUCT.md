# Product and UX Contract

This document is the stable decision contract for GPT Repo MCP's public tool
experience. It defines who the product serves, the recommended paths, and the
promises that future tool-surface changes must preserve. Detailed schemas,
policies, and implementation notes remain in the linked technical documents.

## Primary user and outcome

The primary user is a solo developer or small-team technical owner who wants
ChatGPT to inspect, change, validate, review, and locally commit work in an
approved repository without continuous supervision.

The product succeeds when the user can reach a reviewed local result quickly,
understand what happened, recover safely, and retain control over every
repository, commit, push, and deployment decision.

## Recommended paths

### Direct repository work

1. Establish repository and product context with `repo_project_brief` and the
   smallest relevant read tools.
2. Make bounded changes with the direct write tools.
3. Validate with `repo_validate`.
4. Review actual Git state with compact `repo_git_review`.
5. Use the exact composite `repo_write_stage_commit` or `repo_write_commit`
   payload returned by review.

This is the default happy path. Patchsets and granular Git operations are not
prerequisites for ordinary work.

### Explicit agent delegation

Use Delegation v3 only when work is intentionally handed to an external
implementation agent. Create a grounded v3 task, follow the run through
`repo_agent_runs`, review its real result with `repo_codex_review`, and use
`repo_write_integration_review` when several runs require one owner decision.
The ordinary Git review and local commit gates still apply.

### Recovery

Start from `repo_last_write`, `repo_git_review`, or a failed write's sanitized
diagnostics. Prefer the exact `repo_write_recover` payload returned by review.
Use granular unstage, restore, or cleanup tools only when the composite recovery
path cannot represent the intended action.

## Product promises

- The server exposes closed-world repository capabilities, never arbitrary
  shell access.
- Access is limited to explicitly approved local repositories and their
  configured policies.
- Mutating calls are visible to the host approval UI and protected by stale
  HEAD, path, secret, and policy checks.
- Successful writes return evidence and an executable next step when another
  action is required.
- Failures are sanitized, actionable, and do not expose source contents,
  secrets, absolute paths, stack traces, environment values, or raw commands.
- Compact responses are the default; detailed responses are an explicit
  specialist choice.
- The product may create local commits when authorized. It never pushes,
  deploys, or broadens repository access automatically.
- Current repository state and actual diffs take precedence over agent claims.

## Surface and compatibility

The direct developer workflow is current and recommended. Patchsets,
delegation, diagnostics, and granular operations are specialist surfaces.
Delegation v3 is the current delegation contract. Historical v1/v2 artifacts
remain readable for compatibility but cannot be created through the public
surface.

Public tool names, payload fields, persisted artifact paths, and error codes are
compatibility contracts. Historical names such as `codex` and `ship` may remain
in those contracts even when internal code and documentation use the clearer
terms defined in [GLOSSARY.md](GLOSSARY.md).

## Change and deprecation bar

A public rename, removal, default change, or workflow replacement requires:

1. a documented user problem or usage signal;
2. a migration path and versioned deprecation;
3. preserved safety and recovery guarantees;
4. contract, integration, and distribution verification; and
5. updated canonical documentation in the same change.

Do not add aliases, routing meta-tools, visible approval ceremony, or parallel
happy paths only to hide surface complexity. Simplify the recommended path
first and keep specialist capability explicit.

## Technical sources

- Product data and governance: [product-contract.json](product-contract.json)
- Tool schemas and workflow details: [TOOL_SURFACE.md](TOOL_SURFACE.md)
- Security boundaries: [SECURITY.md](SECURITY.md)
- Write and recovery procedures: [WRITE_WORKFLOWS.md](WRITE_WORKFLOWS.md)
- Delegation artifact and review protocol:
  [DELEGATION_ARTIFACTS.md](DELEGATION_ARTIFACTS.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Current and compatibility terminology: [GLOSSARY.md](GLOSSARY.md)
