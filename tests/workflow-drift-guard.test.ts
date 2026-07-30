import { access, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { toolCatalog } from "../src/tools/catalog.js";

const REMOVED_TOOLS = [
  "repo_plan_review",
  "repo_next_action",
  "repo_git_stage",
  "repo_git_unstage",
  "repo_git_commit"
] as const;

const ACTIVE_WORKFLOW_DOCS = [
  "README.md",
  "docs/APPROVAL_TROUBLESHOOTING.md",
  "docs/ARCHITECTURE.md",
  "docs/DELEGATION_ARTIFACTS.md",
  "docs/PRODUCT.md",
  "docs/SECURITY.md",
  "docs/TOOL_SURFACE.md",
  "docs/WRITE_WORKFLOWS.md"
] as const;

const REMOVED_SOURCE_FILES = [
  "src/contracts/review.contract.ts",
  "src/services/review-planner.ts",
  "src/contracts/next-action.contract.ts",
  "src/services/next-action-service.ts"
] as const;

const INTERNAL_DOCUMENT_REFERENCES = [
  "docs/ROADMAP.md",
  "docs/OSS_EXPORT_ROADMAP.md",
  "docs/AGENT_RUNNER_ARTIFACTS.md",
  "docs/AGENT_RUNNER_DAEMON_PLAN.md",
  "docs/superpowers/",
  "superpowers/specs/"
] as const;

describe("canonical workflow drift guards", () => {
  test("locks the intentional 46-tool surface and removed public names", () => {
    expect(toolCatalog).toHaveLength(46);
    const names = toolCatalog.map(({ name }) => name);
    for (const removed of REMOVED_TOOLS) expect(names).not.toContain(removed);
  });

  test("keeps removed planning and alias implementations physically absent", async () => {
    for (const path of REMOVED_SOURCE_FILES) {
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("keeps active workflow documentation on canonical tools and Delegation v3", async () => {
    for (const path of ACTIVE_WORKFLOW_DOCS) {
      const text = await readFile(path, "utf8");
      for (const removed of REMOVED_TOOLS) expect(text).not.toContain(removed);
      expect(text).not.toContain('"inspect_first"');
      expect(text).not.toContain('"allowed_paths"');
      expect(text).not.toContain('"context_summary"');
      expect(text).not.toContain('"include_prompt"');
    }

    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("## Canonical Development Workflow");
    expect(readme).toContain("repo_current_work_session");
    expect(readme).toContain("repo_write_stage_commit");
    expect(readme).toContain("repo_write_codex_review");
  });

  test("keeps public workflow documents independent from internal planning sources", async () => {
    for (const path of ACTIVE_WORKFLOW_DOCS) {
      const text = await readFile(path, "utf8");
      for (const reference of INTERNAL_DOCUMENT_REFERENCES) {
        expect(text, `${path} references internal-only ${reference}`).not.toContain(reference);
      }
    }

    const contract = await readFile("docs/product-contract.json", "utf8");
    for (const reference of INTERNAL_DOCUMENT_REFERENCES) {
      expect(contract, `product contract references internal-only ${reference}`).not.toContain(reference);
    }
  });

  test("prevents planning and drift services from becoming competing authority engines", async () => {
    const changePlan = await readFile("src/services/change-plan-service.ts", "utf8");
    expect(changePlan).not.toMatch(/TaskInventoryService|AgentRunsService|WorkSessionService|DecisionLogService/);

    const drift = await readFile("src/services/delegation-drift-service.ts", "utf8");
    expect(drift).not.toMatch(/recommendation|next_action|next_tool_payloads|priority/);

    const instructions = await readFile("src/instructions.ts", "utf8");
    expect(instructions).toContain("The canonical direct-development path is");
    expect(instructions).toContain("Do not insert task inventory, decision memory, patchsets, delegation, semantic review, or granular Git tools unless the request specifically needs them");
  });
});
