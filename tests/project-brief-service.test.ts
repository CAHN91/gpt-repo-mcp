import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ProjectBriefResultSchema } from "../src/contracts/project.contract.js";
import type { ProductContract } from "../src/contracts/product-contract.contract.js";
import { ProjectBriefService } from "../src/services/project-brief-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

class CountingSandbox extends PathSandbox {
  readonly resolvedPaths: string[] = [];

  override async resolve(repoPath: string) {
    this.resolvedPaths.push(repoPath);
    return super.resolve(repoPath);
  }
}

function productContract(): ProductContract {
  return {
    schema_version: 1,
    product: { name: "Demo App", purpose: "Help a coordinator resolve work safely." },
    primary_users: [{
      id: "coordinator",
      role: "Coordinator",
      technical_level: "Non-technical",
      work_context: "Works under time pressure."
    }],
    jobs_to_be_done: [{ id: "resolve-work", statement: "Understand an issue and take the next action." }],
    must_reduce: ["Manual comparison"],
    must_not_become: ["A technical workspace"],
    experience_principles: ["Action before internals"],
    canonical_docs: ["README.md"],
    governance: {
      mode: "advisory",
      product_review_required_for: ["product_slice", "product_correction"],
      checkpoint_every_root_runs: 5
    }
  };
}

describe("ProjectBriefService", () => {
  test("returns bounded project signals and explicit missing product guidance", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), "# Demo App\nA useful project.\n");
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({
      type: "module",
      scripts: {
        build: "tsc",
        lint: "eslint .",
        test: "vitest"
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.0.0"
      },
      devDependencies: {
        typescript: "^5.0.0"
      }
    }, null, 2));
    await writeFile(join(fixture.root, "package-lock.json"), "{}\n");

    const result = await projectBrief(fixture.root);

    expect(ProjectBriefResultSchema.safeParse(result).success).toBe(true);
    expect(result.repo).toEqual({ repo_id: "fixture", display_name: "Fixture" });
    expect(result.product_brief).toMatchObject({
      status: "missing",
      authority: "unavailable",
      planning_readiness: "technical_only",
      diagnostic: { code: "PRODUCT_CONTRACT_MISSING" },
      setup_guidance: [{ action: "create_product_contract", path: "docs/product-contract.json" }]
    });
    expect(result.product_brief).not.toHaveProperty("product");
    expect(result).not.toHaveProperty("product_context");
    expect(result.project_type).toBe("mcp-server");
    expect(result.languages).toContain("TypeScript");
    expect(result.package_managers).toContain("npm");
    expect(result.scripts).toEqual(expect.arrayContaining([
      { name: "build", command: "tsc" },
      { name: "test", command: "vitest" }
    ]));
    expect(result.key_docs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", summary: expect.stringContaining("Demo App") })
    ]));
    expect(result.likely_entrypoints).toEqual(expect.arrayContaining(["package.json", "src/app.ts"]));
    expect(result.framework_signals).toContain("mcp-server");
    expect(result.entrypoint_signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "package.json", kind: "package" }),
      expect.objectContaining({ path: "src/app.ts", kind: "runtime" })
    ]));
    expect(result.test_commands).toEqual(expect.arrayContaining(["npm run build", "npm run test"]));
    expect(result.truncated).toBe(false);
    expect(result.warnings.some((warning) => warning.startsWith("KNOWN_PATH_SKIPPED:"))).toBe(false);
  });

  test("honors technical include filters without disabling product briefing", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), "# Demo\n");
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }, null, 2));

    const result = await projectBrief(fixture.root, { include: ["readme"] });

    expect(result.product_brief.status).toBe("missing");
    expect(result.key_docs.map((doc) => doc.path)).toEqual(["README.md"]);
    expect(result.scripts).toEqual([]);
    expect(result.test_commands).toEqual([]);
  });

  test("bounds project document reads and reports truncation", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), `# Large Doc\n${"x".repeat(33_000)}\n`);

    const result = await projectBrief(fixture.root, { include: ["readme"] });

    expect(result.key_docs).toEqual([
      expect.objectContaining({ path: "README.md", summary: expect.stringContaining("Large Doc") })
    ]);
    expect(result.warnings).toContain("FILE_TRUNCATED:README.md");
  });

  test("returns a planning-ready configured product brief before technical signals", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), "# Demo App\nA useful project.\n");
    await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(productContract(), null, 2)}\n`);

    const result = await projectBrief(fixture.root, { include: ["readme"] });

    expect(result.product_brief).toMatchObject({
      status: "configured",
      authority: "repository_product_contract",
      product: { name: "Demo App" },
      governance: { mode: "advisory", checkpoint_every_root_runs: 5 },
      primary_users: [{ id: "coordinator" }],
      jobs_to_be_done: [{ id: "resolve-work" }],
      product_boundaries: {
        must_reduce: ["Manual comparison"],
        must_not_become: ["A technical workspace"],
        experience_principles: ["Action before internals"]
      },
      canonical_evidence: [{ path: "README.md", role: "canonical_reference" }],
      planning_readiness: "product_grounded",
      setup_guidance: []
    });
    expect(result).not.toHaveProperty("product_context");
    expect(result.key_docs).toEqual([]);
  });

  test("surfaces invalid product context with repair guidance without suppressing technical signals", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), "# Demo App\nA useful project.\n");
    await writeFile(join(fixture.root, "docs", "product-contract.json"), "{invalid\n");

    const result = await projectBrief(fixture.root, { include: ["readme"] });

    expect(result.product_brief).toMatchObject({
      status: "invalid",
      authority: "unavailable",
      planning_readiness: "technical_only",
      diagnostic: { code: "PRODUCT_CONTRACT_MALFORMED" },
      setup_guidance: [{ action: "repair_product_contract", path: "docs/product-contract.json" }]
    });
    expect(result.product_brief).not.toHaveProperty("product");
    expect(result).not.toHaveProperty("product_context");
    expect(result.key_docs).toEqual([expect.objectContaining({ path: "README.md" })]);
  });

  test("keeps product briefing active when technical includes are empty", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), "# Demo App\nA useful project.\n");
    await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(productContract(), null, 2)}\n`);

    const result = await projectBrief(fixture.root, { include: [] });

    expect(result.product_brief).toMatchObject({ status: "configured", planning_readiness: "product_grounded" });
    expect(result).not.toHaveProperty("product_context");
    expect(result.scripts).toEqual([]);
    expect(result.key_docs).toEqual([]);
  });

  test("separates canonical product evidence from supporting document summaries", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), "# Demo App\nCanonical product overview.\n");
    await writeFile(join(fixture.root, "docs", "OVERVIEW.md"), "# Technical Overview\nSupporting architecture detail.\n");
    await writeFile(join(fixture.root, "docs", "product-contract.json"), `${JSON.stringify(productContract(), null, 2)}\n`);

    const result = await projectBrief(fixture.root, { include: ["readme", "architecture"] });

    expect(result.product_brief).toMatchObject({ canonical_evidence: [{ path: "README.md", role: "canonical_reference" }] });
    expect(result.key_docs.map(({ path }) => path)).toEqual(["docs/OVERVIEW.md"]);
  });

  test("discovers manifests, scripts, TypeScript, and entrypoints when the tree is truncated", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "a-many"), { recursive: true });
    await Promise.all(Array.from({ length: 505 }, (_, index) =>
      writeFile(join(fixture.root, "a-many", `file-${String(index).padStart(4, "0")}.md`), "fixture\n")
    ));
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({
      type: "module",
      scripts: { build: "tsc", test: "vitest" },
      dependencies: { "@modelcontextprotocol/sdk": "^1.0.0" }
    }, null, 2));
    await writeFile(join(fixture.root, "package-lock.json"), "{}\n");
    await writeFile(join(fixture.root, "src", "server.ts"), "export const server = true;\n");

    const result = await projectBrief(fixture.root);

    expect(result.truncated).toBe(true);
    expect(result.project_type).toBe("mcp-server");
    expect(result.languages).toContain("TypeScript");
    expect(result.package_managers).toContain("npm");
    expect(result.scripts).toEqual(expect.arrayContaining([{ name: "build", command: "tsc" }]));
    expect(result.likely_entrypoints).toEqual(expect.arrayContaining(["package.json", "src/server.ts"]));
    expect(result.entrypoint_signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "package.json", kind: "package" }),
      expect.objectContaining({ path: "src/server.ts", kind: "runtime" })
    ]));
  });

  test("keeps dependency, secret, and internal artifact files out of project signals", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "node_modules", "hidden"), { recursive: true });
    await writeFile(join(fixture.root, "node_modules", "hidden", "index.ts"), "export const hidden = true;\n");
    await writeFile(join(fixture.root, "secret.key"), "SECRET\n");
    await mkdir(join(fixture.root, ".chatgpt", "backlog"), { recursive: true });
    await writeFile(join(fixture.root, ".chatgpt", "backlog", "README.md"), "# Internal Backlog\nLocal only.\n");
    const sandbox = new CountingSandbox(fixture.root);

    const result = await new ProjectBriefService({
      repo_id: "fixture",
      display_name: "Fixture",
      root: fixture.root
    }, sandbox).brief();

    expect(result.likely_entrypoints).not.toContain("node_modules/hidden/index.ts");
    expect(result.languages).not.toContain("Binary");
    expect(result.key_docs.map((doc) => doc.path)).not.toContain("secret.key");
    expect(result.key_docs.map((doc) => doc.path)).not.toContain(".chatgpt/backlog/README.md");
    expect(sandbox.resolvedPaths).not.toContain(".chatgpt/backlog/README.md");
  });

  test("dogfoods a product-grounded and technically complete brief for GPT Repo MCP", async () => {
    const root = process.cwd();
    const result = await new ProjectBriefService({
      repo_id: "chatgpt-mcp-oss",
      display_name: "GPT Repo MCP",
      root
    }, new PathSandbox(root)).brief();

    expect(ProjectBriefResultSchema.safeParse(result).success).toBe(true);
    expect(result.product_brief).toMatchObject({
      status: "configured",
      product: { name: "GPT Repo MCP" },
      governance: { mode: "advisory" },
      delegation_checkpoint: {
        governance_mode: "advisory",
        threshold_root_runs: 5
      },
      planning_readiness: "product_grounded"
    });
    if (result.product_brief.status !== "configured") throw new Error("Expected configured product brief.");
    expect(["no_history", "current", "due"]).toContain(result.product_brief.delegation_checkpoint.status);
    expect(result.product_brief.delegation_checkpoint.root_runs_since_last_product_checkpoint).toBeGreaterThanOrEqual(0);
    expect(result.product_brief.primary_users.map(({ id }) => id)).toEqual(expect.arrayContaining(["solo-developer", "repo-operator"]));
    expect(result.product_brief.jobs_to_be_done).toHaveLength(5);
    expect(result.product_brief).not.toHaveProperty("drift_summary");
    expect(result.product_brief).not.toHaveProperty("runs");
    expect(result.project_type).toBe("mcp-server");
    expect(result.languages).toContain("TypeScript");
    expect(result.package_managers).toContain("npm");
    expect(result.scripts.map(({ name }) => name)).toEqual(expect.arrayContaining(["build", "test", "typecheck"]));
    expect(result.likely_entrypoints).toContain("src/server.ts");
    expect(result.key_docs.every(({ path }) => !path.startsWith(".chatgpt/"))).toBe(true);
  });
});

async function projectBrief(
  root: string,
  options: { include?: Array<"package" | "readme" | "architecture" | "scripts" | "recent_git" | "todos"> } = {}
) {
  return new ProjectBriefService({
    repo_id: "fixture",
    display_name: "Fixture",
    root
  }, new PathSandbox(root)).brief(options);
}
