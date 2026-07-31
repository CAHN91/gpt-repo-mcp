import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { RootRegistry } from "../src/services/root-registry.js";
import {
  fetchFileHandler,
  gitDiffHandler,
  gitStatusHandler,
  readManyHandler,
  searchHandler,
  treeHandler
} from "../src/tools/handlers.js";
import { createRepoFixture } from "./fixtures/repo-fixture.js";

const execFileAsync = promisify(execFile);

const RUN_ID = "2026-07-13T170000Z-private-artifacts";
const SESSION_PATH = `.chatgpt/codex-runs/${RUN_ID}/runner.session.json`;
const REPLY_PATH = `.chatgpt/codex-runs/${RUN_ID}/interactions/turn-0001.reply.json`;
const REVIEW_PATH = `.chatgpt/codex-runs/${RUN_ID}/review.json`;
const REVIEW_GATE_PATH = `.chatgpt/codex-runs/${RUN_ID}/review-gate.json`;
const THREAD_CANARY = "private-thread-canary-must-not-leak";
const ANSWER_CANARY = "private-answer-canary-must-not-leak";
const REVIEW_CANARY = "private-product-review-canary-must-not-leak";
const REVIEW_GATE_CANARY = "private-review-gate-canary-must-not-leak";

describe("generic tool privacy for delegation control artifacts", () => {
  test("blocks missing mixed-case and Windows-separated internal paths before filesystem lookup", async () => {
    const fixture = await createRepoFixture();
    const registry = await RootRegistry.fromConfig({
      repos: [{ repo_id: "fixture", display_name: "Fixture", root: fixture.root }]
    });
    const context = { registry };
    const mixedMissing = `.ChAtGpT/CoDeX-RuNs/${RUN_ID}/RUNNER.SESSION.JSON`;
    const windowsMissing = mixedMissing.replaceAll("/", "\\");

    const fetched = await fetchFileHandler({
      repo_id: "fixture",
      path: mixedMissing,
      override_default_excludes: true
    }, context);
    const windowsFetched = await fetchFileHandler({
      repo_id: "fixture",
      path: windowsMissing,
      override_default_excludes: true
    }, context);
    const many = await readManyHandler({
      repo_id: "fixture",
      paths: [mixedMissing, windowsMissing]
    }, context);

    for (const result of [fetched, windowsFetched]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "INTERNAL_ARTIFACT_BLOCKED" } });
    }
    expect(many.structuredContent).toMatchObject({ files: [], skipped: [], returned_count: 0 });
    for (const result of [fetched, windowsFetched, many]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(mixedMissing);
      expect(serialized).not.toContain(windowsMissing);
      expect(serialized).not.toContain(fixture.root);
    }
  });

  test("blocks physical mixed-case artifacts and non-internal symlink aliases to them", async () => {
    const fixture = await createRepoFixture();
    const mixedSessionPath = `.ChAtGpT/CoDeX-RuNs/${RUN_ID}/RuNnEr.SeSsIoN.JsOn`;
    const caseInsensitiveAlias = mixedSessionPath.toUpperCase();
    const symlinkAlias = "session-alias.json";
    await mkdir(dirname(join(fixture.root, mixedSessionPath)), { recursive: true });
    await writeFile(join(fixture.root, mixedSessionPath), JSON.stringify({ thread_id: THREAD_CANARY }));
    await symlink(join(fixture.root, mixedSessionPath), join(fixture.root, symlinkAlias));
    const registry = await RootRegistry.fromConfig({
      repos: [{ repo_id: "fixture", display_name: "Fixture", root: fixture.root }]
    });
    const context = { registry };

    const direct = await fetchFileHandler({ repo_id: "fixture", path: mixedSessionPath }, context);
    // On case-insensitive filesystems this is a real filesystem alias; on
    // case-sensitive systems the logical precheck must still fail identically.
    const caseAlias = await fetchFileHandler({ repo_id: "fixture", path: caseInsensitiveAlias }, context);
    const symlinked = await fetchFileHandler({ repo_id: "fixture", path: symlinkAlias }, context);
    const many = await readManyHandler({
      repo_id: "fixture",
      paths: [mixedSessionPath, caseInsensitiveAlias, symlinkAlias]
    }, context);
    const searched = await searchHandler({ repo_id: "fixture", query: THREAD_CANARY }, context);
    const tree = await treeHandler({
      repo_id: "fixture",
      include_files: true,
      respect_default_excludes: false,
      include_generated: true,
      include_dependencies: true
    }, context);

    for (const result of [direct, caseAlias, symlinked]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "INTERNAL_ARTIFACT_BLOCKED" } });
    }
    expect(many.structuredContent).toMatchObject({ files: [], skipped: [], returned_count: 0 });
    expect(searched.structuredContent).toMatchObject({ results: [], returned_count: 0 });
    for (const result of [direct, caseAlias, symlinked, many, searched, tree]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(THREAD_CANARY);
      expect(serialized).not.toContain(mixedSessionPath);
      expect(serialized).not.toContain(caseInsensitiveAlias);
      expect(serialized).not.toContain(symlinkAlias);
    }
  });

  test("fetch, read-many, search, and tree cannot expose private runner session or reply data", async () => {
    const fixture = await createRepoFixture();
    await mkdir(join(fixture.root, `.chatgpt/codex-runs/${RUN_ID}/interactions`), { recursive: true });
    await writeFile(join(fixture.root, SESSION_PATH), JSON.stringify({ thread_id: THREAD_CANARY }));
    await writeFile(join(fixture.root, REPLY_PATH), JSON.stringify({ answers: [{ answer: ANSWER_CANARY }] }));
    await writeFile(join(fixture.root, REVIEW_PATH), JSON.stringify({ rationale: REVIEW_CANARY }));
    await writeFile(join(fixture.root, REVIEW_GATE_PATH), JSON.stringify({ gate: REVIEW_GATE_CANARY }));
    const registry = await RootRegistry.fromConfig({
      repos: [{ repo_id: "fixture", display_name: "Fixture", root: fixture.root }]
    });
    const context = { registry };

    const fetched = await fetchFileHandler({
      repo_id: "fixture",
      path: SESSION_PATH,
      override_default_excludes: true
    }, context);
    expect(fetched.isError).toBe(true);
    expect(fetched.structuredContent).toMatchObject({ error: { code: "INTERNAL_ARTIFACT_BLOCKED" } });

    const many = await readManyHandler({
      repo_id: "fixture",
      paths: [SESSION_PATH, REPLY_PATH, REVIEW_PATH, REVIEW_GATE_PATH],
      include_globs: [".chatgpt/codex-runs/**"]
    }, context);
    expect(many.structuredContent).toMatchObject({ files: [], skipped: [], returned_count: 0 });

    const searched = await searchHandler({
      repo_id: "fixture",
      query: "private-",
      include_globs: [".chatgpt/codex-runs/**"]
    }, context);
    expect(searched.structuredContent).toMatchObject({ results: [], returned_count: 0 });

    const tree = await treeHandler({
      repo_id: "fixture",
      path: ".chatgpt",
      include_files: true,
      respect_default_excludes: false,
      include_generated: true,
      include_dependencies: true
    }, context);

    await git(fixture.root, ["init"]);
    await git(fixture.root, ["config", "user.email", "test@example.com"]);
    await git(fixture.root, ["config", "user.name", "Test User"]);
    await git(fixture.root, ["add", "-f", SESSION_PATH, REPLY_PATH, REVIEW_PATH, REVIEW_GATE_PATH]);
    await git(fixture.root, ["commit", "-m", "private runner baseline"]);
    await writeFile(join(fixture.root, SESSION_PATH), JSON.stringify({ thread_id: `${THREAD_CANARY}-changed` }));
    await writeFile(join(fixture.root, REPLY_PATH), JSON.stringify({ answers: [{ answer: `${ANSWER_CANARY}-changed` }] }));
    await writeFile(join(fixture.root, REVIEW_PATH), JSON.stringify({ rationale: `${REVIEW_CANARY}-changed` }));
    await writeFile(join(fixture.root, REVIEW_GATE_PATH), JSON.stringify({ gate: `${REVIEW_GATE_CANARY}-changed` }));
    const status = await gitStatusHandler({ repo_id: "fixture" }, context);
    const diff = await gitDiffHandler({ repo_id: "fixture" }, context);

    for (const result of [fetched, many, searched, tree, status, diff]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(THREAD_CANARY);
      expect(serialized).not.toContain(ANSWER_CANARY);
      expect(serialized).not.toContain(REVIEW_CANARY);
      expect(serialized).not.toContain(REVIEW_GATE_CANARY);
      expect(serialized).not.toContain(SESSION_PATH);
      expect(serialized).not.toContain(REPLY_PATH);
      expect(serialized).not.toContain(REVIEW_PATH);
      expect(serialized).not.toContain(REVIEW_GATE_PATH);
    }
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: { PATH: process.env.PATH ?? "" } });
}
