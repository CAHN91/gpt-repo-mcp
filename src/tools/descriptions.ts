export const descriptions = {
  repo_list_roots:
    "Use this when the user asks which approved repositories are available. Does not read file contents.",
  repo_policy_explain:
    "Use this when a read, write, or cleanup policy question is blocked or the user asks what ChatGPT can access in a repo. Explains effective read/write/cleanup policy, local git operation toggles, matched globs, block reasons, and next steps without reading or mutating files.",
  repo_last_write:
    "Use this when the user asks what the last write operation changed or how to continue review/recovery after a previous write. Reads safe local receipt metadata only and never mutates files or git.",
  repo_tree:
    "Use this when the user asks to inspect repository structure or locate likely files by directory. Do not use this when the user asks to read file contents.",
  repo_search:
    "Use this when the user asks to find code, inspect usages, perform a bughunt, or locate relevant files before reading them. Prefer this before repo_read_many.",
  repo_fetch_file:
    "Use this when the user names a specific file or after repo_tree/repo_search identifies a relevant file. Supports line ranges. Do not use for broad repository review.",
  repo_read_many:
    "Use this when the user asks to read a bounded set of explicit files or glob-matched files. Do not use this to read an entire repository.",
  repo_git_status:
    "Use this when the user asks for git status, branch, dirty files, or changed file counts. Do not use this to inspect file contents.",
  repo_git_diff:
    "Use this when the user asks to review changes or inspect a git diff. Default first call should pass only repo_id. Do not include staged, unstaged, paths, max_bytes, or context_lines on the first pass. Use optional filters only after the default diff is truncated, too broad, or the user asks for a specific comparison.",
  repo_git_review:
    "Use this when the user asks to review current git changes, recover bad write-tool edits, clean up generated artifacts, prepare staging, or plan a local commit without mutating anything. Workflow hub that returns status, diff summary, warnings, and ready-to-run composite payloads for repo_write_stage_commit and repo_write_recover plus low-level fallback payloads.",
  repo_git_stage:
    "Use this when compatibility with the git-prefixed staging alias is needed; prefer repo_write_stage for ChatGPT workflows. Stages explicit repo-relative paths only, requires user approval and expected HEAD, and never runs shell commands.",
  repo_git_unstage:
    "Use this when compatibility with the git-prefixed unstaging alias is needed; prefer repo_write_unstage for ChatGPT workflows. Unstages explicit repo-relative paths only, requires user approval and expected HEAD, and never runs shell commands.",
  repo_git_restore_paths:
    "Use this when the user explicitly asks to recover bad unstaged worktree changes for reviewed explicit repo-relative paths. Runs only git restore -- <paths>, requires expected HEAD, does not unstage, stage, commit, reset, checkout, or run shell commands.",
  repo_git_commit:
    "Use this when compatibility with the git-prefixed commit alias is needed; prefer repo_write_commit for ChatGPT workflows. Creates a local-only commit from exact staged paths, requires user approval and expected HEAD, does not push, and never runs shell commands.",
  repo_write_stage:
    "Use this when the user explicitly asks to stage reviewed repo-relative paths separately or granular control is needed; prefer repo_write_stage_commit after repo_git_review for normal reviewed commits. Requires user approval, expected HEAD, explicit paths, and never runs shell commands.",
  repo_write_unstage:
    "Use this when the user explicitly asks to unstage reviewed repo-relative paths separately or granular recovery control is needed; prefer repo_write_recover after repo_git_review for normal reviewed recovery. Requires user approval, expected HEAD, explicit paths, and never runs shell commands.",
  repo_write_commit:
    "Use this when the user explicitly asks to create a local-only commit from already staged reviewed paths, or staged-only flow requires a commit without staging; prefer repo_write_stage_commit after repo_git_review for normal reviewed commits. Requires user approval, exact staged path verification, expected HEAD, does not push, and never runs shell commands.",
  repo_write_stage_commit:
    "Use this when the user has reviewed repo_git_review output and explicitly approves staging and committing exact repo-relative paths in one local-only operation. Requires expected HEAD, explicit paths, exact staged path verification, does not push, and never runs shell commands.",
  repo_write_recover:
    "Use this when the user has reviewed repo_git_review output and explicitly approves recovering exact repo-relative paths in one operation. Can unstage, restore tracked worktree paths, and clean configured generated artifacts; requires expected HEAD, explicit paths, does not reset, checkout, stash, clean, commit, push, or run shell commands.",
  repo_cleanup_paths:
    "Use this when the user explicitly asks to delete generated repo-local artifacts or local ChatGPT artifacts separately, or granular cleanup control is needed; prefer repo_write_recover after repo_git_review for normal reviewed recovery. Requires user approval, explicit paths, refuses tracked files, and never runs shell commands or git clean.",
  repo_project_brief:
    "Use this when the user asks to understand, onboard into, plan work for, summarize, or start a daily planning session for an approved repository. Prefer this as the first planning tool because it returns bounded project signals without reading the whole repo.",
  repo_task_inventory:
    "Use this when the user asks to find repo-local TODOs, FIXMEs, HACKs, roadmap notes, markdown checklist items, backlog candidates, or next tasks. Returns file and line grounded backlog signals for planning.",
  repo_decision_memory:
    "Use this when the user asks about project memory, architecture decisions, conventions, patterns, rationale, or why the project is structured a certain way. Returns bounded evidence-grounded decisions, conventions, and gaps from repo documentation and package metadata.",
  repo_change_plan:
    "Use this when the user asks how to implement, refactor, debug, fix, or add a feature without writing files. Returns an evidence-grounded implementation plan, likely files, risks, tests, and open questions.",
  repo_next_action:
    "Use this when the user asks what to do next, what to prioritize, whether work is ready to ship, what to clean up, or how to choose focused solo-dev work. Returns advisory next actions from repo status, project brief, and task inventory.",
  repo_plan_review:
    "Use this when the user asks for broad or ambiguous repository review. It estimates scope and suggests whether to ask a clarifying question before reading many files; for onboarding or daily planning prefer repo_project_brief first.",
  repo_prepare_codex_task:
    "Use this when the user explicitly wants chat-copy mode: a Codex prompt returned in chat for review/copying. Does not write files or implement the change. Do not use when Codex will be told to implement .chatgpt/codex-runs/<run_id>/PROMPT.md; use repo_write_codex_task instead.",
  repo_write_codex_task:
    "Use this when the user explicitly asks to create, write, start, resume, or hand off a repo-local Codex prompt/task/run that Codex will execute from the repo. Prefer this by default for repo-local Codex delegation. Writes only .chatgpt/codex-runs/<run_id>/PROMPT.md and run.json through repo write policy; does not implement, stage, commit, push, or run Codex.",
  repo_codex_review:
    "Use this when Codex has finished or the user asks to review a repo-local Codex run. Reads .chatgpt/codex-runs/<run_id>/RESULT.md and git diff review state without mutating files or git.",
  repo_write_file:
    "Use this when the user explicitly asks to write or precisely edit one allowed repository file. Primary low-friction single-file writer/editor for docs, notes, prompts, and focused code edits; requires user approval, repo opt-in, and never runs shell, git, or Codex.",
  repo_write_changes:
    "Use this when the user explicitly asks to apply a cohesive multi-file edit pack to allowed repository files. Primary low-friction multi-file writer/editor for full-file writes and exact-match edits; requires user approval, repo opt-in, and never runs shell, git, stage, commit, or restore.",
  repo_write_handoff:
    "Use this when the user asks for a local-only ChatGPT handoff: skapa handoff, create handoff, skriv handoff, session handoff, resume note, fortsättningsanteckning, ny chatt context, or överlämning till nästa chatt. Creates .chatgpt/handoffs/*.local.md and updates current.local.md; never stages, commits, pushes, resets, checks out, or runs shell commands."
} as const;
