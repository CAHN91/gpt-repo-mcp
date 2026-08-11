# Terms And Compatibility Names

GPT Repo MCP uses a small vocabulary to distinguish ordinary repository work,
local completion, and optional external-agent workflows.

| Term | Meaning | Related public name |
| --- | --- | --- |
| Repository | One configured local root with its own read, write, validation, and Git policies. | Tools use `repo_id` and the `repo_` prefix. |
| Tool | One focused MCP capability with a documented input and result. | The complete list is in [Tools and workflows](TOOL_SURFACE.md). |
| Direct workflow | The normal understand, edit, validate, review, and local-commit path. | This is the recommended path for ordinary development work. |
| Work session | Optional local continuity state for one repository goal. | A work session is not an implementation-agent run. |
| Delegation | An explicit handoff to an external implementation agent operated separately by the user. | Some compatibility-stable tool names retain `codex`. |
| Agent run | One execution of a delegated task by an external worker. | The task is the assignment; the run is its execution. |
| Review | An evidence-based assessment of current files, Git state, validation, or an external result. | `repo_codex_review` is the compatibility-stable name for delegated-result review. |
| Ship review | The local readiness check that combines review evidence and can authorize a next step. | “Ship” does not mean push, release, or deployment. |
| Stage and commit | The normal composite local Git action after a successful review. | Exposed as `repo_write_stage_commit`. |
| Granular Git operations | Separate stage, unstage, restore, cleanup, and commit actions. | Used when the composite workflow cannot express the intended action. |
| Patchset | A separately reviewable prepare, apply, and rollback file transaction. | A specialist alternative to direct writes. |

Compatibility names remain in place until a versioned release documents a
migration. Users normally describe the desired outcome in natural language and
do not need to choose tools by name.
