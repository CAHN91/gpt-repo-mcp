import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { DecisionLogService } from "../src/services/decision-log-service.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

describe("DecisionLogService", () => {
  test("extracts decisions and conventions from docs, readme, agents, and package metadata", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "docs"), { recursive: true });
    await writeFile(join(fixture.root, "README.md"), "# Demo\nDecision: expose read-only tools first.\n");
    await writeFile(join(fixture.root, "AGENTS.md"), "Convention: keep service logic out of handlers.\n");
    await writeFile(join(fixture.root, "docs", "ARCHITECTURE.md"), [
      "# Architecture",
      "Architecture decision: use contract-first tool definitions.",
      "Prefer bounded reads before broad file access.",
      ""
    ].join("\n"));
    await writeFile(join(fixture.root, "package.json"), JSON.stringify({
      type: "module",
      scripts: {
        test: "vitest",
        build: "tsc"
      }
    }, null, 2));

    const result = await new DecisionLogService(new PathSandbox(fixture.root)).decisionLog();

    expect(result.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decision: expect.stringContaining("read-only"),
        evidence: [expect.objectContaining({ path: "README.md", line: 2, source_type: "readme" })]
      }),
      expect.objectContaining({
        decision: expect.stringContaining("contract-first"),
        evidence: [expect.objectContaining({ path: "docs/ARCHITECTURE.md", line: 2, source_type: "docs" })]
      })
    ]));
    expect(result.conventions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: expect.stringContaining("service logic"),
        evidence: [expect.objectContaining({ path: "AGENTS.md", line: 1 })]
      }),
      expect.objectContaining({
        area: "docs",
        rule: expect.stringContaining("bounded reads")
      })
    ]));
    expect(result.warnings).toEqual([]);
  });

  test("honors include sources and reports evidence gaps", async () => {
    const fixture = await createRepoFixture();
    await writeFile(join(fixture.root, "README.md"), "# Demo\nDecision: read-only first.\n");

    const result = await new DecisionLogService(new PathSandbox(fixture.root)).decisionLog({
      include_sources: ["package"]
    });

    expect(result.decisions).toEqual([]);
    expect(result.gaps).toContain("No explicit architecture decisions found in selected sources.");
    expect(result.gaps).toContain("Docs/readme sources were not included, so project-level decisions may be incomplete.");
  });

  test("bounds source reads and skips secret candidates", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, "docs"), { recursive: true });
    await mkdir(join(fixture.root, "docs", "secrets"), { recursive: true });
    await writeFile(join(fixture.root, "docs", "DECISIONS.md"), `Decision: keep this visible.\n${"x".repeat(33_000)}\n`);
    await writeFile(join(fixture.root, "docs", "secrets", "decision.md"), "Decision: do not expose me.\n");

    const result = await new DecisionLogService(new PathSandbox(fixture.root)).decisionLog({
      include_sources: ["docs"]
    });

    expect(result.decisions.map((decision) => decision.evidence[0]?.path)).toContain("docs/DECISIONS.md");
    expect(result.decisions.map((decision) => decision.evidence[0]?.path)).not.toContain("docs/secrets/decision.md");
    expect(result.warnings).toContain("FILE_TRUNCATED:docs/DECISIONS.md");
  });
});
