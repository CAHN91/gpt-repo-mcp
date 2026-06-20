import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { SERVER_INSTRUCTIONS, createMcpServer } from "../src/register.js";
import { RootRegistry } from "../src/services/root-registry.js";
import { readOnlyAnnotations, writeAnnotations } from "../src/tools/annotations.js";
import { toolCatalog } from "../src/tools/catalog.js";
import { isMutatingToolName } from "../src/tools/mutating-tools.js";

const execFileAsync = promisify(execFile);

describe("MCP contract", () => {
  test("initialize exposes server instructions and tool capability", async () => {
    const { client, close } = await connectFixtureServer();
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "gpt-repo-mcp", version: "0.1.0" });
      expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
      expect(SERVER_INSTRUCTIONS).not.toContain("read-only repository app");
      expect(SERVER_INSTRUCTIONS).toContain("Mutating tools are disabled by default and require repo-local config opt-in");
      expect(SERVER_INSTRUCTIONS).toContain("Prefer the repo_write_* names for ChatGPT workflows");
      expect(SERVER_INSTRUCTIONS).toContain("repo_write_commit, repo_write_stage_commit, and repo_git_commit create local commits only");
      expect(SERVER_INSTRUCTIONS).toContain("repo_git_review is the workflow hub");
      expect(SERVER_INSTRUCTIONS).toContain("prefer composite workflow tools");
      expect(SERVER_INSTRUCTIONS).toContain("repo_write_stage_commit for reviewed happy-path local commits");
      expect(SERVER_INSTRUCTIONS).toContain("repo_write_recover for reviewed recovery");
      expect(SERVER_INSTRUCTIONS).toContain("Dry-run is optional preview");
      expect(SERVER_INSTRUCTIONS).toContain("Omit optional reason by default");
      expect(SERVER_INSTRUCTIONS).toContain("repo_last_write");
      expect(SERVER_INSTRUCTIONS).not.toContain("dry-run first when possible");
      expect(SERVER_INSTRUCTIONS).toContain("do not push");
      expect(SERVER_INSTRUCTIONS).toContain("do not run shell commands");
    } finally {
      await close();
    }
  });

  test("tools/list exposes schemas and appropriate annotations for every tool", async () => {
    const { client, close } = await connectFixtureServer();
    try {
      const listed = await client.listTools();
      expect(new Set(listed.tools.map((tool) => tool.name))).toEqual(new Set(toolCatalog.map((tool) => tool.name)));

      for (const tool of listed.tools) {
        expect(tool.title).toEqual(expect.any(String));
        expect(tool.description).toEqual(expect.stringMatching(/^Use this when/));
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        if (isMutatingToolName(tool.name)) {
          expect(tool.annotations).toMatchObject(writeAnnotations);
        } else {
          expect(tool.annotations).toMatchObject(readOnlyAnnotations);
        }
      }
    } finally {
      await close();
    }
  });

  test("tools/list exposed surface stays stable", async () => {
    const { client, close } = await connectFixtureServer();
    try {
      const listed = await client.listTools();

      expect(listed.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        inputKeys: Object.keys(tool.inputSchema.properties ?? {}).sort(),
        outputKeys: Object.keys(tool.outputSchema?.properties ?? {}).sort()
      }))).toMatchInlineSnapshot(`
        [
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks which approved repositories are available. Does not read file contents.",
            "inputKeys": [],
            "name": "repo_list_roots",
            "outputKeys": [
              "repos",
            ],
            "title": "List approved repositories",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when a read, write, or cleanup policy question is blocked or the user asks what ChatGPT can access in a repo. Explains effective read/write/cleanup policy, local git operation toggles, matched globs, block reasons, and next steps without reading or mutating files.",
            "inputKeys": [
              "operation",
              "path",
              "repo_id",
            ],
            "name": "repo_policy_explain",
            "outputKeys": [
              "cleanup",
              "effective_policy",
              "guidance",
              "ok",
              "operations",
              "path",
              "read",
              "repo_id",
              "requested_operation",
              "summary",
              "write",
            ],
            "title": "Explain repository policy",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks what the last write operation changed or how to continue review/recovery after a previous write. Reads safe local receipt metadata only and never mutates files or git.",
            "inputKeys": [
              "repo_id",
            ],
            "name": "repo_last_write",
            "outputKeys": [
              "found",
              "next_tool_payloads",
              "ok",
              "receipt",
              "warnings",
            ],
            "title": "Read last write receipt",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks to inspect repository structure or locate likely files by directory. Do not use this when the user asks to read file contents.",
            "inputKeys": [
              "cursor",
              "include_dependencies",
              "include_files",
              "include_generated",
              "max_depth",
              "page_size",
              "path",
              "repo_id",
              "respect_default_excludes",
            ],
            "name": "repo_tree",
            "outputKeys": [
              "entries",
              "excluded_summary",
              "next_cursor",
              "truncated",
            ],
            "title": "Inspect repository tree",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks to find code, inspect usages, perform a bughunt, or locate relevant files before reading them. Prefer this before repo_read_many.",
            "inputKeys": [
              "context_lines",
              "cursor",
              "exclude_globs",
              "include_globs",
              "max_results",
              "mode",
              "query",
              "repo_id",
            ],
            "name": "repo_search",
            "outputKeys": [
              "matched_count",
              "next_cursor",
              "results",
              "returned_count",
              "truncated",
              "warnings",
            ],
            "title": "Search repository text",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user names a specific file or after repo_tree/repo_search identifies a relevant file. Supports line ranges. Do not use for broad repository review.",
            "inputKeys": [
              "end_line",
              "max_bytes",
              "override_default_excludes",
              "path",
              "repo_id",
              "start_line",
            ],
            "name": "repo_fetch_file",
            "outputKeys": [
              "end_line",
              "language",
              "path",
              "sha256",
              "size_bytes",
              "start_line",
              "text",
              "total_lines",
              "truncated",
              "warnings",
            ],
            "title": "Fetch one file",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks to read a bounded set of explicit files or glob-matched files. Do not use this to read an entire repository.",
            "inputKeys": [
              "cursor",
              "exclude_globs",
              "include_globs",
              "max_bytes_per_file",
              "max_files",
              "max_total_bytes",
              "paths",
              "repo_id",
            ],
            "name": "repo_read_many",
            "outputKeys": [
              "files",
              "matched_count",
              "next_cursor",
              "returned_count",
              "skipped",
              "truncated",
            ],
            "title": "Read bounded files",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks for git status, branch, dirty files, or changed file counts. Do not use this to inspect file contents.",
            "inputKeys": [
              "repo_id",
            ],
            "name": "repo_git_status",
            "outputKeys": [
              "branch",
              "clean",
              "counts",
              "files",
              "head_sha",
            ],
            "title": "Read git status",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks to review changes or inspect a git diff. Default first call should pass only repo_id. Do not include staged, unstaged, paths, max_bytes, or context_lines on the first pass. Use optional filters only after the default diff is truncated, too broad, or the user asks for a specific comparison.",
            "inputKeys": [
              "base",
              "compare",
              "context_lines",
              "max_bytes",
              "paths",
              "repo_id",
              "staged",
              "unstaged",
            ],
            "name": "repo_git_diff",
            "outputKeys": [
              "base",
              "compare",
              "files",
              "staged",
              "truncated",
              "unstaged",
              "warnings",
            ],
            "title": "Read git diff",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks to review current git changes, recover bad write-tool edits, clean up generated artifacts, prepare staging, or plan a local commit without mutating anything. Workflow hub that returns status, diff summary, warnings, and ready-to-run composite payloads for repo_write_stage_commit and repo_write_recover plus low-level fallback payloads.",
            "inputKeys": [
              "max_files",
              "mode",
              "repo_id",
            ],
            "name": "repo_git_review",
            "outputKeys": [
              "branch",
              "changed_paths",
              "clean",
              "diff_summary",
              "head_sha",
              "next_tool_payloads",
              "ok",
              "recommendation",
            ],
            "title": "Plan git review",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when compatibility with the git-prefixed staging alias is needed; prefer repo_write_stage for ChatGPT workflows. Stages explicit repo-relative paths only, requires user approval and expected HEAD, and never runs shell commands.",
            "inputKeys": [
              "dry_run",
              "expected_head_sha",
              "paths",
              "reason",
              "repo_id",
            ],
            "name": "repo_git_stage",
            "outputKeys": [
              "dry_run",
              "head_sha",
              "ok",
              "skipped",
              "staged_paths",
              "warnings",
            ],
            "title": "Stage explicit git paths",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when compatibility with the git-prefixed unstaging alias is needed; prefer repo_write_unstage for ChatGPT workflows. Unstages explicit repo-relative paths only, requires user approval and expected HEAD, and never runs shell commands.",
            "inputKeys": [
              "dry_run",
              "expected_head_sha",
              "paths",
              "reason",
              "repo_id",
            ],
            "name": "repo_git_unstage",
            "outputKeys": [
              "dry_run",
              "head_sha",
              "ok",
              "skipped",
              "unstaged_paths",
              "warnings",
            ],
            "title": "Unstage explicit git paths",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user explicitly asks to recover bad unstaged worktree changes for reviewed explicit repo-relative paths. Runs only git restore -- <paths>, requires expected HEAD, does not unstage, stage, commit, reset, checkout, or run shell commands.",
            "inputKeys": [
              "dry_run",
              "expected_head_sha",
              "paths",
              "reason",
              "repo_id",
            ],
            "name": "repo_git_restore_paths",
            "outputKeys": [
              "dry_run",
              "head_sha",
              "ok",
              "restored_paths",
              "skipped",
              "warnings",
            ],
            "title": "Restore explicit worktree paths",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when compatibility with the git-prefixed commit alias is needed; prefer repo_write_commit for ChatGPT workflows. Creates a local-only commit from exact staged paths, requires user approval and expected HEAD, does not push, and never runs shell commands.",
            "inputKeys": [
              "dry_run",
              "expected_head_sha",
              "expected_staged_paths",
              "message",
              "reason",
              "repo_id",
            ],
            "name": "repo_git_commit",
            "outputKeys": [
              "commit_sha",
              "committed_paths",
              "dry_run",
              "head_after",
              "head_before",
              "ok",
              "warnings",
            ],
            "title": "Create local git commit",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user explicitly asks to stage reviewed repo-relative paths separately or granular control is needed; prefer repo_write_stage_commit after repo_git_review for normal reviewed commits. Requires user approval, expected HEAD, explicit paths, and never runs shell commands.",
            "inputKeys": [
              "dry_run",
              "expected_head_sha",
              "paths",
              "reason",
              "repo_id",
            ],
            "name": "repo_write_stage",
            "outputKeys": [
              "dry_run",
              "head_sha",
              "ok",
              "skipped",
              "staged_paths",
              "warnings",
            ],
            "title": "Stage reviewed paths",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user explicitly asks to unstage reviewed repo-relative paths separately or granular recovery control is needed; prefer repo_write_recover after repo_git_review for normal reviewed recovery. Requires user approval, expected HEAD, explicit paths, and never runs shell commands.",
            "inputKeys": [
              "dry_run",
              "expected_head_sha",
              "paths",
              "reason",
              "repo_id",
            ],
            "name": "repo_write_unstage",
            "outputKeys": [
              "dry_run",
              "head_sha",
              "ok",
              "skipped",
              "unstaged_paths",
              "warnings",
            ],
            "title": "Unstage reviewed paths",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user explicitly asks to create a local-only commit from already staged reviewed paths, or staged-only flow requires a commit without staging; prefer repo_write_stage_commit after repo_git_review for normal reviewed commits. Requires user approval, exact staged path verification, expected HEAD, does not push, and never runs shell commands.",
            "inputKeys": [
              "dry_run",
              "expected_head_sha",
              "expected_staged_paths",
              "message",
              "reason",
              "repo_id",
            ],
            "name": "repo_write_commit",
            "outputKeys": [
              "commit_sha",
              "committed_paths",
              "dry_run",
              "head_after",
              "head_before",
              "ok",
              "warnings",
            ],
            "title": "Create reviewed local commit",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user has reviewed repo_git_review output and explicitly approves staging and committing exact repo-relative paths in one local-only operation. Requires expected HEAD, explicit paths, exact staged path verification, does not push, and never runs shell commands.",
            "inputKeys": [
              "dry_run",
              "expected_head_sha",
              "message",
              "paths",
              "reason",
              "repo_id",
            ],
            "name": "repo_write_stage_commit",
            "outputKeys": [
              "clean_after",
              "commit_sha",
              "committed_paths",
              "dry_run",
              "head_after",
              "head_before",
              "ok",
              "remaining_changes",
              "staged_paths",
              "warnings",
            ],
            "title": "Stage and commit reviewed paths",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user has reviewed repo_git_review output and explicitly approves recovering exact repo-relative paths in one operation. Can unstage, restore tracked worktree paths, and clean configured generated artifacts; requires expected HEAD, explicit paths, does not reset, checkout, stash, clean, commit, push, or run shell commands.",
            "inputKeys": [
              "cleanup_paths",
              "dry_run",
              "expected_head_sha",
              "reason",
              "repo_id",
              "restore_paths",
              "unstage_paths",
            ],
            "name": "repo_write_recover",
            "outputKeys": [
              "clean_after",
              "deleted",
              "dry_run",
              "head_sha",
              "ok",
              "remaining_changes",
              "restored_paths",
              "skipped",
              "unstaged_paths",
              "warnings",
            ],
            "title": "Recover reviewed paths",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user explicitly asks to delete generated repo-local artifacts or local ChatGPT artifacts separately, or granular cleanup control is needed; prefer repo_write_recover after repo_git_review for normal reviewed recovery. Requires user approval, explicit paths, refuses tracked files, and never runs shell commands or git clean.",
            "inputKeys": [
              "dry_run",
              "paths",
              "reason",
              "repo_id",
            ],
            "name": "repo_cleanup_paths",
            "outputKeys": [
              "deleted",
              "dry_run",
              "ok",
              "skipped",
              "warnings",
            ],
            "title": "Clean up generated paths",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks to understand, onboard into, plan work for, summarize, or start a daily planning session for an approved repository. Prefer this as the first planning tool because it returns bounded project signals without reading the whole repo.",
            "inputKeys": [
              "include",
              "repo_id",
            ],
            "name": "repo_project_brief",
            "outputKeys": [
              "key_docs",
              "languages",
              "likely_entrypoints",
              "package_managers",
              "project_type",
              "repo",
              "scripts",
              "test_commands",
              "truncated",
              "warnings",
            ],
            "title": "Create project brief",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks to find repo-local TODOs, FIXMEs, HACKs, roadmap notes, markdown checklist items, backlog candidates, or next tasks. Returns file and line grounded backlog signals for planning.",
            "inputKeys": [
              "cursor",
              "exclude_globs",
              "include_globs",
              "labels",
              "max_results",
              "repo_id",
            ],
            "name": "repo_task_inventory",
            "outputKeys": [
              "matched_count",
              "next_cursor",
              "returned_count",
              "scan_complete",
              "scanned_file_count",
              "tasks",
              "truncated",
              "warnings",
            ],
            "title": "Inventory repository tasks",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks about project memory, architecture decisions, conventions, patterns, rationale, or why the project is structured a certain way. Returns bounded evidence-grounded decisions, conventions, and gaps from repo documentation and package metadata.",
            "inputKeys": [
              "include_sources",
              "repo_id",
            ],
            "name": "repo_decision_memory",
            "outputKeys": [
              "conventions",
              "decisions",
              "gaps",
              "warnings",
            ],
            "title": "Extract decision memory",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks how to implement, refactor, debug, fix, or add a feature without writing files. Returns an evidence-grounded implementation plan, likely files, risks, tests, and open questions.",
            "inputKeys": [
              "goal",
              "include_globs",
              "max_files_to_inspect",
              "planning_depth",
              "repo_id",
            ],
            "name": "repo_change_plan",
            "outputKeys": [
              "estimated_cost",
              "goal",
              "open_questions",
              "proposed_steps",
              "relevant_files",
              "scan_complete",
              "test_strategy",
              "warnings",
            ],
            "title": "Plan repository change",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks what to do next, what to prioritize, whether work is ready to ship, what to clean up, or how to choose focused solo-dev work. Returns advisory next actions from repo status, project brief, and task inventory.",
            "inputKeys": [
              "horizon",
              "mode",
              "repo_id",
            ],
            "name": "repo_next_action",
            "outputKeys": [
              "blockers",
              "confidence",
              "rationale",
              "recommendation",
              "suggested_actions",
              "useful_context",
              "warnings",
            ],
            "title": "Recommend next action",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user asks for broad or ambiguous repository review. It estimates scope and suggests whether to ask a clarifying question before reading many files; for onboarding or daily planning prefer repo_project_brief first.",
            "inputKeys": [
              "prompt",
            ],
            "name": "repo_plan_review",
            "outputKeys": [
              "estimated_cost",
              "explicit_full_repo",
              "recommended_next_tools",
              "recommended_scope",
              "should_ask_clarifying_question",
              "suggested_question",
            ],
            "title": "Plan repository review",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when the user explicitly wants chat-copy mode: a Codex prompt returned in chat for review/copying. Does not write files or implement the change. Do not use when Codex will be told to implement .chatgpt/codex-runs/<run_id>/PROMPT.md; use repo_write_codex_task instead.",
            "inputKeys": [
              "acceptance_criteria",
              "allowed_paths",
              "context_summary",
              "forbidden_paths",
              "implementation_scope",
              "inspect_first",
              "objective",
              "repo_id",
              "run_id",
              "title",
              "verification_commands",
            ],
            "name": "repo_prepare_codex_task",
            "outputKeys": [
              "codex_user_prompt",
              "manifest_path",
              "next_steps",
              "ok",
              "prompt_markdown",
              "prompt_path",
              "repo_id",
              "result_path",
              "run_id",
              "warnings",
            ],
            "title": "Prepare Codex task prompt",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user explicitly asks to create, write, start, resume, or hand off a repo-local Codex prompt/task/run that Codex will execute from the repo. Prefer this by default for repo-local Codex delegation. Writes only .chatgpt/codex-runs/<run_id>/PROMPT.md and run.json through repo write policy; does not implement, stage, commit, push, or run Codex.",
            "inputKeys": [
              "acceptance_criteria",
              "allowed_paths",
              "context_summary",
              "dry_run",
              "forbidden_paths",
              "implementation_scope",
              "inspect_first",
              "objective",
              "reason",
              "repo_id",
              "run_id",
              "title",
              "verification_commands",
            ],
            "name": "repo_write_codex_task",
            "outputKeys": [
              "codex_user_prompt",
              "dry_run",
              "manifest_path",
              "next_steps",
              "ok",
              "prompt_markdown",
              "prompt_path",
              "repo_id",
              "result_path",
              "run_id",
              "warnings",
              "written_paths",
            ],
            "title": "Write Codex task prompt",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use this when Codex has finished or the user asks to review a repo-local Codex run. Reads .chatgpt/codex-runs/<run_id>/RESULT.md and git diff review state without mutating files or git.",
            "inputKeys": [
              "max_files",
              "repo_id",
              "run_id",
            ],
            "name": "repo_codex_review",
            "outputKeys": [
              "codex_result",
              "git_review",
              "next_steps",
              "next_tool_payloads",
              "ok",
              "repo_id",
              "result_found",
              "result_path",
              "run_id",
              "warnings",
            ],
            "title": "Review Codex result",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user explicitly asks to write or precisely edit one allowed repository file. Primary low-friction single-file writer/editor for docs, notes, prompts, and focused code edits; requires user approval, repo opt-in, and never runs shell, git, or Codex.",
            "inputKeys": [
              "action",
              "content",
              "create_dirs",
              "dry_run",
              "find",
              "path",
              "reason",
              "replace",
              "repo_id",
            ],
            "name": "repo_write_file",
            "outputKeys": [
              "action",
              "bytes_written",
              "changed",
              "created",
              "dry_run",
              "new_sha256",
              "ok",
              "old_sha256",
              "operation_receipt",
              "path",
              "summary",
              "warnings",
            ],
            "title": "Write one repository file",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user explicitly asks to apply a cohesive multi-file edit pack to allowed repository files. Primary low-friction multi-file writer/editor for full-file writes and exact-match edits; requires user approval, repo opt-in, and never runs shell, git, stage, commit, or restore.",
            "inputKeys": [
              "changes",
              "dry_run",
              "reason",
              "repo_id",
            ],
            "name": "repo_write_changes",
            "outputKeys": [
              "changed_paths",
              "counts",
              "dry_run",
              "files",
              "next_steps",
              "ok",
              "operation_receipt",
              "summary",
              "warnings",
            ],
            "title": "Apply repository edit pack",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use this when the user asks for a local-only ChatGPT handoff: skapa handoff, create handoff, skriv handoff, session handoff, resume note, fortsättningsanteckning, ny chatt context, or överlämning till nästa chatt. Creates .chatgpt/handoffs/*.local.md and updates current.local.md; never stages, commits, pushes, resets, checks out, or runs shell commands.",
            "inputKeys": [
              "completed_work",
              "constraints",
              "current_state",
              "current_track",
              "decisions",
              "dry_run",
              "important_files",
              "next_steps",
              "open_questions",
              "repo_id",
              "risks",
              "title",
              "update_current",
              "why",
              "workflow",
            ],
            "name": "repo_write_handoff",
            "outputKeys": [
              "branch",
              "clean",
              "current_next_step",
              "current_path",
              "dry_run",
              "handoff_path",
              "head_sha",
              "ok",
              "startup_prompt",
              "updated_current",
              "warnings",
            ],
            "title": "Create ChatGPT handoff",
          },
        ]
      `);
    } finally {
      await close();
    }
  });

  test("tools/call returns structuredContent matching the advertised output", async () => {
    const { client, close } = await connectFixtureServer();
    try {
      const result = await client.callTool({
        name: "repo_list_roots",
        arguments: {}
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        repos: [
          expect.objectContaining({
            repo_id: "fixture",
            display_name: "Fixture Repo",
            root: expect.any(String)
          })
        ]
      });
      expect(result.content).toEqual([{ type: "text", text: "1 approved repositories available." }]);
    } finally {
      await close();
    }
  });

  test("repo_write_changes partial failure exposes safe diagnostics in error envelope", async () => {
    const { client, close } = await connectFixtureServer();
    try {
      const result = await client.callTool({
        name: "repo_write_changes",
        arguments: {
          repo_id: "fixture",
          changes: [
            { type: "write", path: "docs/applied-a.md", content: "A\n" },
            { type: "append", path: "docs/ARCHITECTURE.md", content: "Applied\n" },
            { type: "replace", path: "src/app.ts", find: "missingNeedle", replace: "safeFetch" }
          ]
        }
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: "WRITE_FIND_NOT_FOUND",
          retryable: false,
          diagnostics: {
            applied_paths: ["docs/applied-a.md", "docs/ARCHITECTURE.md"],
            failed_path: "src/app.ts",
            recovery_hint: expect.stringContaining("repo_git_review")
          }
        }
      });
      const serialized = JSON.stringify(result.structuredContent);
      expect(serialized).not.toContain("/Users/");
      expect(serialized).not.toContain("A\\n");
      expect(serialized).not.toContain("Applied\\n");
    } finally {
      await close();
    }
  });

  test("repo_last_write returns missing receipt when no write receipt exists", async () => {
    const { client, close } = await connectFixtureServer();
    try {
      const result = await client.callTool({
        name: "repo_last_write",
        arguments: { repo_id: "fixture" }
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        ok: true,
        found: false,
        next_tool_payloads: {},
        warnings: ["NO_LAST_WRITE_RECEIPT"]
      });
    } finally {
      await close();
    }
  });

  test("actual repo_write_file creates last write receipt", async () => {
    const { client, close } = await connectFixtureServer();
    try {
      const write = await client.callTool({
        name: "repo_write_file",
        arguments: {
          repo_id: "fixture",
          path: "docs/write-file-actual.md",
          content: "actual\n"
        }
      });
      expect(write.isError).toBeUndefined();
      expect(write.structuredContent).toMatchObject({
        operation_receipt: {
          operation_id: expect.stringMatching(/^write-/),
          path: ".chatgpt/operations/last-write.json"
        }
      });

      const result = await client.callTool({
        name: "repo_last_write",
        arguments: { repo_id: "fixture" }
      });

      expect(result.structuredContent).toMatchObject({
        ok: true,
        found: true,
        receipt: {
          tool: "repo_write_file",
          repo_id: "fixture",
          touched_paths: ["docs/write-file-actual.md"],
          changed_paths: ["docs/write-file-actual.md"],
          created_paths: ["docs/write-file-actual.md"],
          modified_paths: [],
          counts: { requested: 1, changed: 1, created: 1, unchanged: 0 },
          summary: "Created docs/write-file-actual.md."
        },
        next_tool_payloads: {
          repo_git_review: { repo_id: "fixture" }
        },
        warnings: []
      });
      const serialized = JSON.stringify(result.structuredContent);
      expect(serialized).not.toContain("actual\\n");
      expect(serialized).not.toContain("/tmp/");
    } finally {
      await close();
    }
  });

  test("repo_write_changes creates receipt and dry-run failed and no-op writes do not overwrite it", async () => {
    const { client, close } = await connectFixtureServer();
    try {
      const writeChanges = await client.callTool({
        name: "repo_write_changes",
        arguments: {
          repo_id: "fixture",
          changes: [
            { type: "write", path: "docs/new-receipt.md", content: "new\n" },
            { type: "append", path: "docs/ARCHITECTURE.md", content: "changed\n" }
          ]
        }
      });
      expect(writeChanges.isError).toBeUndefined();

      const firstReceipt = await client.callTool({
        name: "repo_last_write",
        arguments: { repo_id: "fixture" }
      });
      expect(firstReceipt.structuredContent).toMatchObject({
        found: true,
        receipt: {
          tool: "repo_write_changes",
          touched_paths: ["docs/new-receipt.md", "docs/ARCHITECTURE.md"],
          changed_paths: ["docs/new-receipt.md", "docs/ARCHITECTURE.md"],
          created_paths: ["docs/new-receipt.md"],
          modified_paths: ["docs/ARCHITECTURE.md"],
          counts: { requested: 2, changed: 2, created: 1, unchanged: 0 },
          summary: "Applied 2 changes across 2 files."
        }
      });
      const firstOperationId = (firstReceipt.structuredContent as {
        receipt?: { operation_id?: string };
      }).receipt?.operation_id;

      await client.callTool({
        name: "repo_write_file",
        arguments: {
          repo_id: "fixture",
          path: "docs/dry-run-no-receipt.md",
          content: "dry\n",
          dry_run: true
        }
      });
      await client.callTool({
        name: "repo_write_file",
        arguments: {
          repo_id: "fixture",
          path: "secrets/blocked.md",
          content: "blocked\n"
        }
      });
      await client.callTool({
        name: "repo_write_file",
        arguments: {
          repo_id: "fixture",
          path: "docs/ARCHITECTURE.md",
          content: "# Architecture\nDecision: keep tools read-only.\nConvention: use contracts first.\nchanged\n"
        }
      });

      const finalReceipt = await client.callTool({
        name: "repo_last_write",
        arguments: { repo_id: "fixture" }
      });

      expect((finalReceipt.structuredContent as {
        receipt?: { operation_id?: string };
      }).receipt?.operation_id).toBe(firstOperationId);
    } finally {
      await close();
    }
  });

  test("repo_write_handoff returns success envelope from HandoffService", async () => {
    const { client, close } = await connectFixtureServer();
    try {
      const result = await client.callTool({
        name: "repo_write_handoff",
        arguments: {
          repo_id: "fixture",
          title: "MCP Handoff",
          current_state: "Tool wiring is under test.",
          why: "The next ChatGPT session needs local resume context.",
          next_steps: [{ title: "Continue Slice v2.2" }],
          dry_run: true
        }
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        ok: true,
        dry_run: true,
        handoff_path: expect.stringMatching(/^\.chatgpt\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-mcp-handoff\.local\.md$/),
        current_path: ".chatgpt/handoffs/current.local.md",
        updated_current: true,
        branch: expect.any(String),
        head_sha: expect.any(String),
        clean: false,
        startup_prompt: expect.stringContaining("repo_id `fixture`"),
        current_next_step: "Continue Slice v2.2",
        warnings: []
      });
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining("Dry run checked handoff") }
      ]);
    } finally {
      await close();
    }
  });

  test("representative calls for every tool match their output schema", async () => {
    const { client, close, head } = await connectFixtureServer();
    try {
      for (const [name, args] of Object.entries(representativeCalls(head))) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBeUndefined();
        expect(result.structuredContent, name).toBeDefined();

        const definition = toolCatalog.find((tool) => tool.name === name);
        expect(definition, name).toBeDefined();
        const parsed = definition!.outputSchema.safeParse(result.structuredContent);
        expect(parsed.error?.issues, name).toBeUndefined();
        expect(result.content, name).toEqual([
          expect.objectContaining({ type: "text", text: expect.any(String) })
        ]);
      }
    } finally {
      await close();
    }
  });
});

function representativeCalls(head: string): Record<string, Record<string, unknown>> {
  return {
  repo_list_roots: {},
  repo_last_write: { repo_id: "fixture" },
  repo_tree: { repo_id: "fixture", path: ".", max_depth: 2, page_size: 10 },
  repo_search: { repo_id: "fixture", query: "Fixture", max_results: 5 },
  repo_fetch_file: { repo_id: "fixture", path: "README.md", start_line: 1, end_line: 5 },
  repo_read_many: { repo_id: "fixture", paths: ["README.md", "src/app.ts"], max_files: 2 },
  repo_git_status: { repo_id: "fixture" },
  repo_git_diff: { repo_id: "fixture" },
  repo_git_review: { repo_id: "fixture" },
  repo_git_stage: { repo_id: "fixture", paths: ["docs/write-dry-run.md"], expected_head_sha: head, dry_run: true },
  repo_git_unstage: { repo_id: "fixture", paths: ["docs/staged.md"], expected_head_sha: head, dry_run: true },
  repo_git_restore_paths: { repo_id: "fixture", paths: ["docs/write-dry-run.md"], expected_head_sha: head, dry_run: true },
  repo_git_commit: { repo_id: "fixture", message: "Update staged docs", expected_head_sha: head, expected_staged_paths: ["docs/staged.md"], dry_run: true },
  repo_write_stage: { repo_id: "fixture", paths: ["docs/write-dry-run.md"], expected_head_sha: head, dry_run: true },
  repo_write_unstage: { repo_id: "fixture", paths: ["docs/staged.md"], expected_head_sha: head, dry_run: true },
  repo_write_commit: { repo_id: "fixture", message: "Update staged docs", expected_head_sha: head, expected_staged_paths: ["docs/staged.md"], dry_run: true },
  repo_write_stage_commit: { repo_id: "fixture", paths: ["docs/staged.md"], message: "Update staged docs", expected_head_sha: head, dry_run: true },
  repo_write_recover: { repo_id: "fixture", restore_paths: ["docs/write-dry-run.md"], cleanup_paths: [".chatgpt/tool-tests/cleanup.txt"], expected_head_sha: head, dry_run: true },
  repo_cleanup_paths: { repo_id: "fixture", paths: [".chatgpt/tool-tests/cleanup.txt"], dry_run: true },
  repo_project_brief: { repo_id: "fixture" },
  repo_task_inventory: { repo_id: "fixture", max_results: 5 },
  repo_decision_memory: { repo_id: "fixture" },
  repo_change_plan: { repo_id: "fixture", goal: "Add fixture validation", planning_depth: "quick" },
  repo_next_action: { repo_id: "fixture", mode: "plan", horizon: "today" },
  repo_plan_review: { prompt: "Granska mina ändringar" },
  repo_prepare_codex_task: {
    repo_id: "fixture",
    title: "Fix fixture docs",
    objective: "Read docs/ARCHITECTURE.md and propose a focused Codex implementation.",
    inspect_first: ["docs/ARCHITECTURE.md"],
    allowed_paths: ["docs/ARCHITECTURE.md"],
    verification_commands: ["npm test -- tests/mcp-contract.test.ts"]
  },
  repo_write_codex_task: {
    repo_id: "fixture",
    title: "Fix fixture docs",
    objective: "Read docs/ARCHITECTURE.md and propose a focused Codex implementation.",
    inspect_first: ["docs/ARCHITECTURE.md"],
    allowed_paths: ["docs/ARCHITECTURE.md"],
    dry_run: true
  },
  repo_codex_review: {
    repo_id: "fixture",
    run_id: "2026-06-04T081500Z-fix-fixture-docs"
  },
  repo_write_file: { repo_id: "fixture", path: "docs/write-file-dry-run.md", content: "planned\n", dry_run: true },
  repo_write_changes: {
    repo_id: "fixture",
    changes: [
      { type: "write", path: "docs/write-changes-dry-run.md", content: "planned\n" },
      {
        type: "edit",
        path: "docs/ARCHITECTURE.md",
        edits: [
          { type: "replace", find: "Decision: keep tools read-only.", replace: "Decision: keep tools safe by default." },
          { type: "insert_after", find: "Convention: use contracts first.", content: "\nConvention: review grouped edits through git." }
        ]
      }
    ],
    dry_run: true
  },
  repo_write_handoff: {
    repo_id: "fixture",
    title: "Representative Handoff",
    current_state: "Representative MCP contract call is running.",
    why: "Output schema should validate for the handoff tool.",
    next_steps: [{ title: "Review handoff output" }],
    dry_run: true
  }
  };
}

async function connectFixtureServer() {
  const root = await createRepoRoot();
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, env: { PATH: process.env.PATH ?? "" } })).stdout.trim();
  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "fixture",
      display_name: "Fixture Repo",
      root,
      writes: { enabled: true, allowed_globs: ["docs/**", "src/**", ".chatgpt/**"] },
      operations: {
        enabled: true,
        git_stage_enabled: true,
        git_commit_enabled: true,
        cleanup_enabled: true
      }
    }],
    limits: {}
  });
  const server = createMcpServer({ registry });
  const client = new Client({ name: "contract-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  return {
    client,
    head,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

async function createRepoRoot() {
  const root = await mkdtemp(join(tmpdir(), "gpt-repo-mcp-contract-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, ".chatgpt", "tool-tests"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Fixture\n");
  await writeFile(join(root, "docs", "ARCHITECTURE.md"), "# Architecture\nDecision: keep tools read-only.\nConvention: use contracts first.\n");
  await writeFile(join(root, "TODO.md"), "- [ ] Wire repo_task_inventory\n");
  await writeFile(join(root, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      build: "tsc",
      test: "vitest"
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.0.0"
    }
  }, null, 2));
  await writeFile(join(root, "src", "app.ts"), "export const fixture = true;\n");
  await execFileAsync("git", ["init"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["add", "--", "README.md", "docs/ARCHITECTURE.md", "TODO.md", "package.json", "src/app.ts"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  await writeFile(join(root, "src-placeholder.txt"), "changed\n");
  await writeFile(join(root, "docs", "staged.md"), "staged\n");
  await writeFile(join(root, "docs", "write-dry-run.md"), "planned\n");
  await writeFile(join(root, ".chatgpt", "tool-tests", "cleanup.txt"), "temporary\n");
  await execFileAsync("git", ["add", "--", "docs/staged.md"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  return root;
}
