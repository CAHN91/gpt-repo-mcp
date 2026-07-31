# Current and Compatibility Terminology

Use the current terms in new internal code and active documentation. Keep
public tool names, payload fields, persisted paths, and stable error codes
unchanged until a versioned deprecation explicitly replaces them.

| Current term | Meaning | Compatibility terminology |
| --- | --- | --- |
| repository | One configured local root and its effective policies. Use `repo` only in identifiers already built around `repo_id`. | Public tools intentionally retain the `repo_` prefix. |
| tool | One closed-world MCP capability with one canonical public name. | Do not call aliases or routing meta-tools separate workflows. |
| direct workflow | The default inspect, write, validate, review, and local commit path. | Sometimes described as the `developer` package path. |
| work session | Durable continuity state for one active repository goal. | A work session is not an agent run or a delegation. |
| delegation | An explicit handoff to an external implementation agent. | Public tool names and persisted paths retain `codex` for compatibility. |
| Delegation v3 | The current task, lineage, result, review, and integration contract. | v1/v2 runs are legacy, read-only compatibility artifacts. |
| agent run | The queued or executing lifecycle of one delegated task. | Do not use `task` and `run` interchangeably: the task is the assignment; the run is its execution. |
| review | Evidence-based assessment of current files, Git state, validation, or a delegated result. | `repo_codex_review` is the compatibility-stable name for delegation review. |
| ship review | The local readiness gate that combines review evidence and returns an authorized next payload. | “Ship” does not mean push, release, or deploy. |
| stage-and-commit | The normal composite local Git mutation after review. | `repo_write_stage_commit` remains the public tool name. |
| granular Git operations | Specialist stage, unstage, restore, cleanup, and commit primitives. | Use only when the composite workflow cannot express the intended action. |
| patchset | A separately reviewable prepare/apply/rollback file transaction. | It is a specialist alternative to direct writes, not the default write model. |

When a current term and a compatibility name differ, prefer the current term in
module names, local variables, comments, and prose. Use the compatibility name
only where the public or persisted contract requires it.
