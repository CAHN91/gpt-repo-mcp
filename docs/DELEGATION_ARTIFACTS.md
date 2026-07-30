# Delegation Artifact Protocol

GPT Repo MCP supports delegation through repository-owned files and explicit
review tools. The protocol lets a manual or external implementation agent work
against a bounded task while the MCP server retains authority over validation,
review, staging, and local commit preparation.

The OSS distribution does not include or start an agent runner. Writing a task
with runner mode `queued` records handoff intent only. Execution, scheduling,
provider credentials, and process supervision remain outside the public MCP
server.

## Canonical Delegation v3 flow

1. Preview and validate a task with `repo_prepare_codex_task`, or write it with
   `repo_write_codex_task`.
2. An external implementation agent reads the task and writes strict
   `RESULT.json` evidence.
3. Inspect bounded lifecycle information with `repo_agent_runs`. If a
   compatible external worker asks structured questions, answer the exact
   current question with `repo_write_agent_reply`.
4. Run `repo_codex_review` to verify the task, current repository state, scope,
   evidence, and technical readiness.
5. Record the required state-bound product or technical verdict with
   `repo_write_codex_review`.
6. Use the normal ship review and its exact stage-commit or recovery payload.
   For several related runs in one dirty worktree, use the separately
   authorized integration-review path described below.

Delegation is a specialist workflow. Direct implementation remains the default
when the user has not explicitly requested an implementation agent.

## Repository-owned artifacts

Each run lives under:

```text
.chatgpt/codex-runs/<run_id>/
```

The current v3 contract uses:

| Artifact | Owner and purpose |
| --- | --- |
| `PROMPT.md` | Server-rendered human-readable assignment and constraints. |
| `run.json` | Server-owned task manifest, identity, baseline, authorization, and contract hashes. |
| `review-gate.json` | Server-owned gate binding protected paths to the run and required review. |
| `RESULT.json` | Implementation-agent evidence for changed files, connected work, technical criteria, and product criteria. |
| `review.json` | Server-written qualitative attestation bound to the reviewed repository state. |

Compatible external workers may also produce bounded lifecycle, event, and
structured interaction artifacts. These files are protocol inputs, not an
execution API: MCP tools never use them to launch, resume, configure, or cancel
a worker.

Delegation artifacts are local working state under `.chatgpt/` and should not
be committed or included in an OSS source export.

## Visibility and privacy

Generic tree, read, batch-read, search, and diff workflows do not expose
internal session, attempt, lock, replacement-lock, or reply artifacts.
Configuration overrides and explicit paths cannot reopen those files.

`repo_agent_runs` is the public inspection boundary. It returns only bounded,
validated, redacted lifecycle metadata, safe event summaries, runtime budget,
and current structured questions. It does not return prompt or result text,
source contents, raw logs, environment values, credentials, or provider thread
identifiers.

`repo_write_agent_reply` requires the exact run, turn index, question hash, and
one answer for every current question. It rejects stale and duplicate replies
and writes only the reply artifact. It cannot change task scope, accept
commands, or control an external worker.

## State binding and staleness

Review authority applies to exact repository state, not to an agent's claim:

- task manifests bind repository identity, run identity, prompt content,
  authorization, baseline HEAD, and relevant contract hashes;
- modern v3 runs fingerprint paths that were already dirty at task creation;
- review attributes only connected changes inside the effective authorized
  scope;
- a HEAD change or byte change inside the attributed pathset makes the review
  stale;
- unrelated work outside a modern run's attributed pathset does not stale that
  run; and
- older v3 artifacts without initial path states use conservative
  whole-worktree binding.

Malformed, unsafe, mismatched, oversized, or stale artifacts fail closed.
Secret-bearing result or review evidence is rejected rather than persisted or
returned.

## Review, lineage, and scope

Authorization scope defines the maximum permitted area; it is not a prediction
of every file needed. Starting points are advisory. The implementation result
must account for all connected work, and review rejects silent scope omission
or expansion.

When a run needs correction or a legitimate scope amendment, the server may
offer a new baseline-bound child task with explicit parent and root lineage.
The child inherits or narrows the valid contract, records the reason, and
cannot bypass review gates. A root lineage has a hard maximum of two children.

Product evidence and technical evidence remain separate. Agent-reported
product evidence never self-approves product work; the owner records the
qualitative verdict through `repo_write_codex_review`.

## Multi-run integration

Several related v3 runs may share one dirty worktree only through an explicit
owner-selected integration review:

1. Every selected run must have current technical review and its required
   state-bound verdict.
2. A current full validation must cover the repository state.
3. `repo_write_integration_review` verifies that the selected reviewed union
   exactly covers the current project changes and writes a hash-bound artifact
   under `.chatgpt/integration-reviews/`.
4. The returned opaque `review_pathset_id` is passed unchanged to
   `repo_write_stage_commit`.

The server owns and rechecks the exact HEAD, run review hashes, pathset, content
fingerprint, validation, path policy, and commit message before and after
staging. A client cannot add paths, replace the reviewed message, rescue a
failed run, or bypass secret and forbidden-path checks. Integration pathsets
are bounded to 2,000 paths.

Historical v1 and v2 task artifacts remain readable through isolated
compatibility paths. Public tools create only v3 tasks, and legacy artifacts
cannot be promoted into a v3 integration review.

## Contributor compatibility rules

- Treat public tool names, schema fields, artifact paths, hashes, error codes,
  and stale-state behavior as compatibility contracts.
- Keep artifact parsing bounded, schema-validated, identity-bound, redacted,
  and fail-closed.
- Keep worker execution outside the public MCP server and outside public tool
  handlers.
- Do not weaken generic-read exclusions for private run state.
- Require a documented migration and contract coverage before changing
  persisted artifact formats or legacy read behavior.
- Keep product truth in repository-owned product documentation rather than in
  generated prompts or implementation-agent output.

For task payloads and operational examples, see
[Write Workflows](WRITE_WORKFLOWS.md). For tool inputs and outputs, see
[Tool Surface](TOOL_SURFACE.md). For service and authority boundaries, see
[Architecture](ARCHITECTURE.md).
