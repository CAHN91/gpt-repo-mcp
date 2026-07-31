import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ValidationService } from "../src/services/validation-service.js";
import { OperationsPolicy } from "../src/services/operations-policy.js";
import { ValidateInputSchema } from "../src/contracts/validation.contract.js";
import { descriptions } from "../src/tools/descriptions.js";
import type { NodeRuntimeResolverOptions } from "../src/services/node-runtime-resolver.js";

describe("ValidationService", () => {
  test("tool and contract describe repo-owned priority plus safe fallbacks without shell execution", async () => {
    expect(descriptions.repo_validate).toContain("repo-owned make target takes priority");
    expect(descriptions.repo_validate).toContain("safe pytest");
    expect(descriptions.repo_validate).toContain("bounded tail without a shell");
    expect(descriptions.repo_validate).not.toContain("allowlisted package.json script profile");
    expect(ValidateInputSchema.shape.profile.description).toContain("safe pytest");
    const source = await readFile(join(process.cwd(), "src", "services", "validation-service.ts"), "utf8");
    expect(source).toContain("runProcessWithTail({");
    expect(source).not.toContain("shell: true");
  });
  test("selects pytest for a Python repository without package.json", async () => {
    const root = await fixtureRepo({ pythonMarker: true, localPython: true });
    const result = await service(root).validate({ repo_id: "fixture", profile: "test", dry_run: true });
    expect(result.commands).toEqual([{ profile: "test", script: "pytest", command: ".venv/bin/python -m pytest", status: "skipped" }]);
  });

  test("prefers executable .venv Python and passes focused paths as separate arguments", async () => {
    const root = await fixtureRepo({ pythonMarker: true, localPython: true });
    const result = await service(root, { validation_test_path_globs: ["tests/**"] }).validate({
      repo_id: "fixture", profile: "test", test_paths: ["tests/test_a.py", "tests/test_b.py"]
    });
    expect(result.commands[0]).toMatchObject({
      script: "pytest",
      command: ".venv/bin/python -m pytest tests/test_a.py tests/test_b.py",
      stdout_tail: "-m|pytest|tests/test_a.py|tests/test_b.py"
    });
  });

  test("uses fixed python3 fallback when local Python is absent", async () => {
    const root = await fixtureRepo({ pythonMarker: true });
    const result = await service(root).validate({ repo_id: "fixture", profile: "test", dry_run: true });
    expect(result.commands[0]?.command).toBe("python3 -m pytest");
  });

  test("prefers an npm test script over pytest", async () => {
    const root = await fixtureRepo({ scripts: { test: "echo npm" }, pythonMarker: true, localPython: true });
    const result = await service(root).validate({ repo_id: "fixture", profile: "test", dry_run: true });
    expect(result.commands[0]?.command).toBe("npm run test");
  });

  test("does not use pytest fallback for build", async () => {
    const root = await fixtureRepo({ pythonMarker: true, localPython: true });
    await expect(service(root).validate({ repo_id: "fixture", profile: "build", dry_run: true }))
      .rejects.toMatchObject({ code: "VALIDATION_PROFILE_UNAVAILABLE" });
  });

  test("rejects Python repositories without test-suite signals", async () => {
    const root = await fixtureRepo({ localPython: true });
    await expect(service(root).validate({ repo_id: "fixture", profile: "test", dry_run: true }))
      .rejects.toMatchObject({ code: "VALIDATION_PROFILE_UNAVAILABLE" });
  });

  test("does not select a non-executable or root-escaping local Python", async () => {
    const root = await fixtureRepo({ pythonMarker: true, localPython: "non-executable" });
    expect((await service(root).validate({ repo_id: "fixture", profile: "test", dry_run: true })).commands[0]?.command).toBe("python3 -m pytest");

    const outside = await mkdtemp(join(tmpdir(), "gpt-python-outside-"));
    const outsidePython = join(outside, "python");
    await writeFile(outsidePython, "#!/usr/bin/env node\nprocess.exit(0)\n");
    await chmod(outsidePython, 0o755);
    const escapingRoot = await fixtureRepo({ pythonMarker: true });
    await mkdir(join(escapingRoot, ".venv", "bin"), { recursive: true });
    await symlink(outsidePython, join(escapingRoot, ".venv", "bin", "python"));
    expect((await service(escapingRoot).validate({ repo_id: "fixture", profile: "test", dry_run: true })).commands[0]?.command).toBe("python3 -m pytest");
  });

  test("all includes pytest in profile order alongside available npm profiles", async () => {
    const root = await fixtureRepo({ scripts: { lint: "echo lint", build: "echo build" }, pythonMarker: true, localPython: true });
    const result = await service(root).validate({ repo_id: "fixture", profile: "all", dry_run: true });
    expect(result.commands.map(({ profile, script }) => ({ profile, script }))).toEqual([
      { profile: "lint", script: "lint" }, { profile: "test", script: "pytest" }, { profile: "build", script: "build" }
    ]);
  });

  test("declared all profile uses canonical make verify instead of npm or pytest fallback", async () => {
    const root = await fixtureRepo({ scripts: { test: "echo npm-should-not-run" }, pythonMarker: true, localPython: true });
    await writeFile(join(root, "Makefile"), "verify:\n\t@echo canonical-make-verify\n");
    const result = await service(root, {
      validation_profiles: { all: { runner: "make", target: "verify" } }
    }).validate({ repo_id: "fixture", profile: "all" });

    expect(result).toMatchObject({
      status: "passed",
      commands: [{
        profile: "all",
        script: "make:verify",
        command: "make verify",
        status: "passed",
        stdout_tail: expect.stringContaining("canonical-make-verify")
      }]
    });
    expect(result.commands).toHaveLength(1);
  });

  test("validation artifact records the pytest runner and display command", async () => {
    const root = await fixtureRepo({ pythonMarker: true, localPython: true });
    const result = await service(root).validate({ repo_id: "fixture", profile: "test" });
    const artifact = JSON.parse(await readFile(join(root, result.validation_artifact!.path), "utf8"));
    expect(artifact.commands[0]).toMatchObject({ script: "pytest", command: ".venv/bin/python -m pytest" });
  });

  test("selects an installed exact Node version from .node-version for npm validation", async () => {
    const root = await fixtureRepo({ scripts: { test: "node -e \"console.log(process.env.FAKE_NODE_RUNTIME)\"" }, nodeVersion: "24.18.0" });
    const runtime = await fakeNvmRuntime("24.18.0");
    const result = await service(root, {}, runtime.options).validate({ repo_id: "fixture", profile: "test" });

    expect(result.commands[0]).toMatchObject({
      command: "npm run test",
      runtime: { name: "node", version: "24.18.0", source: ".node-version" },
      stdout_tail: expect.stringContaining("24.18.0")
    });
  });

  test("uses deterministic version-source priority", async () => {
    const root = await fixtureRepo({
      scripts: { test: "echo ok" },
      nodeVersion: "22.22.2",
      nvmrc: "23.0.0",
      voltaNode: "24.18.0"
    });
    const runtime = await fakeNvmRuntime("24.18.0");
    const result = await service(root, {}, runtime.options).validate({ repo_id: "fixture", profile: "test", dry_run: true });
    expect(result.commands[0]?.runtime).toEqual({ name: "node", version: "24.18.0", source: "package.json#volta.node" });
  });

  test("ignores non-exact engines ranges and keeps the host PATH", async () => {
    const root = await fixtureRepo({ scripts: { test: "echo ok" }, enginesNode: ">=24" });
    const result = await service(root, {}, { home: await mkdtemp(join(tmpdir(), "gpt-empty-runtime-")), env: {} })
      .validate({ repo_id: "fixture", profile: "test", dry_run: true });
    expect(result.commands[0]?.runtime).toBeUndefined();
  });

  test("fails safely when an exact requested Node runtime is not installed", async () => {
    const root = await fixtureRepo({ scripts: { test: "echo ok" }, nvmrc: "24.18.0" });
    await expect(service(root, {}, { home: await mkdtemp(join(tmpdir(), "gpt-empty-runtime-")), env: {} })
      .validate({ repo_id: "fixture", profile: "test", dry_run: true }))
      .rejects.toMatchObject({ code: "VALIDATION_NODE_RUNTIME_UNAVAILABLE" });
  });

  test("rejects a runtime symlink that escapes its approved manager root", async () => {
    const root = await fixtureRepo({ scripts: { test: "echo ok" }, nodeVersion: "24.18.0" });
    const home = await mkdtemp(join(tmpdir(), "gpt-runtime-home-"));
    const outside = await fakeNodeExecutable(join(await mkdtemp(join(tmpdir(), "gpt-runtime-outside-")), "node"), "24.18.0");
    const candidate = join(home, ".nvm", "versions", "node", "v24.18.0", "bin", "node");
    await mkdir(join(home, ".nvm", "versions", "node", "v24.18.0", "bin"), { recursive: true });
    await symlink(outside, candidate);
    await expect(service(root, {}, { home, env: {} }).validate({ repo_id: "fixture", profile: "test", dry_run: true }))
      .rejects.toMatchObject({ code: "VALIDATION_NODE_RUNTIME_UNAVAILABLE" });
  });

  test("validation artifact records selected Node runtime without an absolute runtime path", async () => {
    const root = await fixtureRepo({ scripts: { smoke: "echo ok" }, nodeVersion: "24.18.0" });
    const runtime = await fakeNvmRuntime("24.18.0");
    const result = await service(root, {}, runtime.options).validate({ repo_id: "fixture", profile: "smoke" });
    const artifactText = await readFile(join(root, result.validation_artifact!.path), "utf8");
    expect(JSON.parse(artifactText).commands[0].runtime).toEqual({ name: "node", version: "24.18.0", source: ".node-version" });
    expect(artifactText).not.toContain(runtime.home);
  });
  test("dry run resolves the allowlisted npm script without executing it", async () => {
    const root = await fixtureRepo({
      scripts: { test: "node -e \"throw new Error('should not run')\"" }
    });

    const result = await service(root).validate({
      repo_id: "fixture",
      profile: "test",
      dry_run: true
    });

    expect(result).toMatchObject({
      ok: true,
      repo_id: "fixture",
      profile: "test",
      dry_run: true,
      status: "skipped",
      commands: [{ profile: "test", script: "test", command: "npm run test", status: "skipped" }],
      counts: { total: 1, passed: 0, failed: 0, skipped: 1 },
      warnings: ["VALIDATION_DRY_RUN"]
    });
  });

  test("runs an allowlisted npm script and returns bounded output", async () => {
    const root = await fixtureRepo({
      scripts: { smoke: "node -e \"console.log('smoke ok')\"" }
    });

    const result = await service(root).validate({
      repo_id: "fixture",
      profile: "smoke"
    });

    expect(result).toMatchObject({
      ok: true,
      repo_id: "fixture",
      profile: "smoke",
      dry_run: false,
      status: "passed",
      commands: [{
        profile: "smoke",
        script: "smoke",
        command: "npm run smoke",
        status: "passed",
        exit_code: 0,
        stdout_tail: expect.stringContaining("smoke ok")
      }],
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
      warnings: []
    });
    expect(result.commands[0]?.stdout_tail?.length).toBeLessThanOrEqual(4000);
  });

  test("reports validation failure as a structured result instead of a tool error", async () => {
    const root = await fixtureRepo({
      scripts: { test: "node -e \"console.error('failed safely'); process.exit(3)\"" }
    });

    const result = await service(root).validate({
      repo_id: "fixture",
      profile: "test"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "failed",
      commands: [{
        profile: "test",
        script: "test",
        command: "npm run test",
        status: "failed",
        exit_code: 3,
        stderr_tail: expect.stringContaining("failed safely")
      }],
      counts: { total: 1, passed: 0, failed: 1, skipped: 0 },
      warnings: []
    });
  });

  test("requires explicit validation opt-in in operations policy", async () => {
    const root = await fixtureRepo({ scripts: { test: "node -e \"console.log('ok')\"" } });

    await expect(new ValidationService(root, new OperationsPolicy({ enabled: true })).validate({
      repo_id: "fixture",
      profile: "test",
      dry_run: true
    })).rejects.toMatchObject({ code: "VALIDATION_DISABLED" });
  });

  test("rejects unavailable profiles before running npm", async () => {
    const root = await fixtureRepo({ scripts: { test: "node -e \"console.log('ok')\"" } });

    await expect(service(root).validate({
      repo_id: "fixture",
      profile: "build",
      dry_run: true
    })).rejects.toMatchObject({ code: "VALIDATION_PROFILE_UNAVAILABLE" });
  });

  test("runs focused test paths only when allowed by operations policy", async () => {
    const root = await fixtureRepo({
      scripts: { test: "node -e \"console.log(process.argv.slice(1).join('|'))\"" }
    });

    const result = await service(root, { validation_test_path_globs: ["tests/**"] }).validate({
      repo_id: "fixture",
      profile: "test",
      test_paths: ["tests/auth.test.ts"]
    });

    expect(result).toMatchObject({
      ok: true,
      profile: "test",
      status: "passed",
      commands: [{
        profile: "test",
        script: "test",
        command: "npm run test -- tests/auth.test.ts",
        status: "passed",
        stdout_tail: expect.stringContaining("tests/auth.test.ts")
      }],
      focused: true,
      test_paths: ["tests/auth.test.ts"],
      validation_artifact: {
        path: expect.stringMatching(/^\.chatgpt\/validation\/validation-[^/]+\/result\.json$/)
      }
    });
    expect(result.validation_id).toMatch(/^validation-/);

    const artifact = JSON.parse(await readFile(join(root, result.validation_artifact!.path), "utf8")) as {
      validation_id?: string;
      focused?: boolean;
      test_paths?: string[];
      commands?: Array<{ stdout_tail?: string }>;
    };
    expect(artifact.validation_id).toBe(result.validation_id);
    expect(artifact.focused).toBe(true);
    expect(artifact.test_paths).toEqual(["tests/auth.test.ts"]);
    expect(artifact.commands?.[0]?.stdout_tail).toContain("tests/auth.test.ts");

    const latest = JSON.parse(await readFile(join(root, ".chatgpt", "validation", "latest.json"), "utf8")) as {
      validation_id?: string;
      focused?: boolean;
      test_paths?: string[];
      worktree_fingerprint?: string;
    };
    expect(latest.validation_id).toBe(result.validation_id);
    expect(latest.focused).toBe(true);
    expect(latest.test_paths).toEqual(["tests/auth.test.ts"]);
    expect(latest.worktree_fingerprint).toBeTypeOf("string");
  });

  test("rejects focused test paths outside configured validation globs", async () => {
    const root = await fixtureRepo({
      scripts: { test: "node -e \"console.log('ok')\"" }
    });

    await expect(service(root, { validation_test_path_globs: ["tests/**"] }).validate({
      repo_id: "fixture",
      profile: "test",
      test_paths: ["src/app.ts"],
      dry_run: true
    })).rejects.toMatchObject({ code: "VALIDATION_TEST_PATH_NOT_ALLOWED" });
  });
});

function service(
  root: string,
  operations: Partial<ConstructorParameters<typeof OperationsPolicy>[0]> = {},
  runtimeOptions: NodeRuntimeResolverOptions = {}
): ValidationService {
  return new ValidationService(root, new OperationsPolicy({
    enabled: true,
    validation_enabled: true,
    ...operations
  }), runtimeOptions);
}

async function fixtureRepo(options: {
  scripts?: Record<string, string>;
  pythonMarker?: boolean;
  localPython?: boolean | "non-executable";
  nodeVersion?: string;
  nvmrc?: string;
  voltaNode?: string;
  enginesNode?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gpt-repo-validation-"));
  await mkdir(root, { recursive: true });
  if (options.scripts) {
    await writeFile(join(root, "package.json"), JSON.stringify({
      type: "module",
      scripts: options.scripts,
      ...(options.voltaNode ? { volta: { node: options.voltaNode } } : {}),
      ...(options.enginesNode ? { engines: { node: options.enginesNode } } : {})
    }, null, 2));
  }
  if (options.nodeVersion) await writeFile(join(root, ".node-version"), `${options.nodeVersion}\n`);
  if (options.nvmrc) await writeFile(join(root, ".nvmrc"), `${options.nvmrc}\n`);
  if (options.pythonMarker) await writeFile(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  if (options.localPython) {
    const python = join(root, ".venv", "bin", "python");
    await mkdir(join(root, ".venv", "bin"), { recursive: true });
    await writeFile(python, "#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join('|'))\n");
    await chmod(python, options.localPython === "non-executable" ? 0o644 : 0o755);
  }
  await mkdir(join(root, "venv", "bin"), { recursive: true });
  return root;
}

async function fakeNvmRuntime(version: string): Promise<{ home: string; options: NodeRuntimeResolverOptions }> {
  const home = await mkdtemp(join(tmpdir(), "gpt-runtime-home-"));
  await fakeNodeExecutable(join(home, ".nvm", "versions", "node", `v${version}`, "bin", "node"), version);
  return { home, options: { home, env: {} } };
}

async function fakeNodeExecutable(path: string, version: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!${process.execPath}\n` +
    `const { spawnSync } = require("node:child_process");\n` +
    `if (process.argv[2] === "--version") { console.log("v${version}"); process.exit(0); }\n` +
    `const result = spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), { stdio: "inherit", env: { ...process.env, FAKE_NODE_RUNTIME: "${version}" } });\n` +
    `process.exit(result.status ?? 1);\n`);
  await chmod(path, 0o755);
  return path;
}
