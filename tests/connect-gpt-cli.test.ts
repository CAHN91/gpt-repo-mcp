import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConnectGptCli } from "../src/cli/connect-gpt.js";

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

describe("connect-gpt config CLI", () => {
  test("usage includes doctor", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));

    const result = await runCli([], sandbox);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("gpt-repo doctor [--config <path>]");
    expect(result.stderr).toContain("connect-gpt config list|add|remove|check");
  });

  test("doctor fails when config is missing", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));

    const result = await runCli(["doctor"], sandbox);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("PASS Node.js");
    expect(result.stdout).toContain("INFO config path:");
    expect(result.stdout).toContain("FAIL config.local.json missing");
    expect(result.stdout).toMatch(/^(PASS|WARN|INFO|FAIL) /m);
  });

  test("doctor passes with valid fixture config", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "demo-repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await writeDoctorPackageJson(sandbox);
    await writeFile(configPath, JSON.stringify({
      repos: [{ repo_id: "demo", display_name: "Demo", root: repoRoot }],
      limits: {}
    }, null, 2));

    const result = await runCli(["doctor", "--config", configPath], sandbox, {
      ngrokInstalled: async () => true,
      hasActiveNgrokTunnel: async () => false,
      isPortInUse: async () => false,
      isGitWorktreeDirty: async () => false
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASS config.local.json found");
    expect(result.stdout).toContain("PASS config validated: 1 repo(s)");
    expect(result.stdout).toContain("PASS repo root git repository: demo");
    expect(result.stdout).toContain("PASS package script found: mcp");
    expect(result.stdout).toContain("PASS ngrok installed");
    expect(result.stdout).toContain("INFO no active ngrok tunnel detected");
    expect(result.stdout).toContain("PASS port 8787 is available");
    expect(result.stdout).toContain("PASS git worktree clean");
    expect(result.stderr).toBe("");
  });

  test("doctor accepts copied empty starter config and warns that no repositories are configured", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    await writeDoctorPackageJson(sandbox);
    await writeFile(configPath, await readFile(join(process.cwd(), "config.example.json"), "utf8"));

    const result = await runCli(["doctor", "--config", configPath], sandbox, {
      ngrokInstalled: async () => true,
      hasActiveNgrokTunnel: async () => false,
      isPortInUse: async () => false,
      isGitWorktreeDirty: async () => false
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASS config validated: 0 repo(s)");
    expect(result.stdout).toContain("WARN config has no repositories; add one before using npm run connect");
    expect(result.stdout).not.toContain("ROOT_MISSING");
    expect(result.stderr).toBe("");
  });

  test("add --mode read adds the first repo to a copied empty starter config", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await writeFile(configPath, await readFile(join(process.cwd(), "config.example.json"), "utf8"));

    const added = await runCli(["add", repoRoot, "--id", "repo", "--mode", "read", "--config", configPath], sandbox);

    expect(added.code).toBe(0);
    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      repos: Array<{ repo_id: string; writes?: { enabled?: boolean }; operations?: { enabled?: boolean } }>;
    };
    expect(written.repos).toHaveLength(1);
    expect(written.repos[0]).toMatchObject({
      repo_id: "repo",
      writes: { enabled: false },
      operations: { enabled: false }
    });
  });

  test("supports add/list/remove/check flow", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "demo-repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "@scope/Demo Repo" }, null, 2));

    const added = await runCli(["config", "add", repoRoot, "--config", configPath], sandbox);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("repo_id=scope-demo-repo");
    expect(added.stdout).toContain("display_name=@scope/Demo Repo");

    const listed = await runCli(["config", "list", "--config", configPath], sandbox);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("repo_id\tdisplay_name\troot");
    expect(listed.stdout).toContain("scope-demo-repo\t@scope/Demo Repo");

    const checked = await runCli(["config", "check", "--config", configPath], sandbox);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("PASS 1 repo(s) validated.");

    const removed = await runCli(["config", "remove", "scope-demo-repo", "--config", configPath], sandbox);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Removed repo_id=scope-demo-repo");

    const empty = await runCli(["config", "list", "--config", configPath], sandbox);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No approved repositories configured.");
  });

  test("supports top-level gpt-repo add/list/check commands", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "demo-repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "demo-repo" }, null, 2));

    const added = await runCli(["add", repoRoot, "--config", configPath], sandbox);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("repo_id=demo-repo");
    expect(added.stdout).toContain("mode=read");
    expect(added.stdout).toContain("next: npm run connect");

    const listed = await runCli(["list", "--config", configPath], sandbox);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("demo-repo\tdemo-repo");

    const checked = await runCli(["check", "--config", configPath], sandbox);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("PASS 1 repo(s) validated.");
  });

  test("prefers GPT_REPO_CONFIG and falls back to REPO_READER_CONFIG", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const gptConfigPath = join(sandbox, "gpt-config.json");
    const legacyConfigPath = join(sandbox, "legacy-config.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await writeFile(gptConfigPath, JSON.stringify({
      repos: [{ repo_id: "gpt-config", display_name: "GPT Config", root: repoRoot }],
      limits: {}
    }, null, 2));
    await writeFile(legacyConfigPath, JSON.stringify({
      repos: [{ repo_id: "legacy-config", display_name: "Legacy Config", root: repoRoot }],
      limits: {}
    }, null, 2));

    const preferred = await runCli(["list"], sandbox, undefined, {
      GPT_REPO_CONFIG: gptConfigPath,
      REPO_READER_CONFIG: legacyConfigPath
    });
    expect(preferred.code).toBe(0);
    expect(preferred.stdout).toContain("gpt-config\tGPT Config");
    expect(preferred.stdout).not.toContain("legacy-config");

    const fallback = await runCli(["list"], sandbox, undefined, {
      REPO_READER_CONFIG: legacyConfigPath
    });
    expect(fallback.code).toBe(0);
    expect(fallback.stdout).toContain("legacy-config\tLegacy Config");
  });

  test("add --mode read writes read-only repo policy", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });

    const added = await runCli(["add", repoRoot, "--id", "repo", "--mode", "read", "--config", configPath], sandbox);
    expect(added.code).toBe(0);

    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      repos: Array<{ writes?: { enabled?: boolean }; operations?: { enabled?: boolean } }>;
    };
    expect(written.repos[0]?.writes?.enabled).toBe(false);
    expect(written.repos[0]?.operations?.enabled).toBe(false);
  });

  test("add --mode write enables practical solo-dev write policy without operations", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });

    const added = await runCli(["add", repoRoot, "--id", "repo", "--mode", "write", "--config", configPath], sandbox);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("mode=write");

    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      repos: Array<{
        writes?: { enabled?: boolean; allowed_globs?: string[]; denied_globs?: string[] };
        operations?: { enabled?: boolean };
      }>;
    };
    const repo = written.repos[0];
    expect(repo?.writes?.enabled).toBe(true);
    expect(repo?.writes?.allowed_globs).toEqual(["**"]);
    expect(repo?.writes?.denied_globs).toContain(".env.*");
    expect(repo?.writes?.denied_globs).toContain(".git/**");
    expect(repo?.writes?.denied_globs).toContain("node_modules/**");
    expect(repo?.writes?.denied_globs).toContain("**/node_modules/**");
    expect(repo?.writes?.denied_globs).toContain("**/dist/**");
    expect(repo?.writes?.denied_globs).toContain("**/.next/**");
    expect(repo?.writes?.denied_globs).toContain("**/coverage/**");
    expect(repo?.operations?.enabled).toBe(false);
  });

  test("add --ship enables write policy and local git operations", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });

    const added = await runCli(["add", repoRoot, "--id", "repo", "--ship", "--config", configPath], sandbox);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("mode=ship");

    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      repos: Array<{
        writes?: { enabled?: boolean };
        operations?: {
          enabled?: boolean;
          git_stage_enabled?: boolean;
          git_commit_enabled?: boolean;
          cleanup_enabled?: boolean;
        };
      }>;
    };
    const repo = written.repos[0];
    expect(repo?.writes?.enabled).toBe(true);
    expect(repo?.operations).toMatchObject({
      enabled: true,
      git_stage_enabled: true,
      git_commit_enabled: true,
      cleanup_enabled: true
    });
  });

  test("rejects duplicate repo_id during add", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const firstRoot = join(sandbox, "first");
    const secondRoot = join(sandbox, "second");
    await mkdir(join(firstRoot, ".git"), { recursive: true });
    await mkdir(join(secondRoot, ".git"), { recursive: true });
    await writeFile(join(firstRoot, "package.json"), JSON.stringify({ name: "same-id" }, null, 2));
    await writeFile(join(secondRoot, "package.json"), JSON.stringify({ name: "same id" }, null, 2));

    const firstAdd = await runCli(["config", "add", firstRoot, "--config", configPath], sandbox);
    expect(firstAdd.code).toBe(0);

    const secondAdd = await runCli(["config", "add", secondRoot, "--config", configPath], sandbox);
    expect(secondAdd.code).toBe(1);
    expect(secondAdd.stderr).toContain("Duplicate repo_id: \"same-id\".");
  });

  test("rejects duplicate root during add", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "repo-one" }, null, 2));

    const firstAdd = await runCli(["config", "add", repoRoot, "--config", configPath], sandbox);
    expect(firstAdd.code).toBe(0);

    const secondAdd = await runCli(["config", "add", repoRoot, "--id", "repo-two", "--config", configPath], sandbox);
    expect(secondAdd.code).toBe(1);
    expect(secondAdd.stderr).toContain("Duplicate root:");
  });

  test("check fails for missing root and non-directory root", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const missingRoot = join(sandbox, "missing");
    const fileRoot = join(sandbox, "root.txt");
    await writeFile(fileRoot, "not a directory\n");
    await writeFile(configPath, JSON.stringify({
      repos: [
        { repo_id: "missing-root", display_name: "Missing", root: missingRoot },
        { repo_id: "file-root", display_name: "File", root: fileRoot }
      ],
      limits: {}
    }, null, 2));

    const result = await runCli(["config", "check", "--config", configPath], sandbox);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[ROOT_MISSING]");
    expect(result.stderr).toContain("[ROOT_NOT_DIRECTORY]");
  });

  test("check enforces git repositories unless allow_non_git is set", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const noGit = join(sandbox, "no-git");
    await mkdir(noGit, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      repos: [
        { repo_id: "plain-dir", display_name: "Plain", root: noGit }
      ],
      limits: {}
    }, null, 2));

    const failing = await runCli(["config", "check", "--config", configPath], sandbox);
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("[NOT_GIT_REPO]");

    await writeFile(configPath, JSON.stringify({
      repos: [
        { repo_id: "plain-dir", display_name: "Plain", root: noGit, allow_non_git: true }
      ],
      limits: {}
    }, null, 2));

    const passing = await runCli(["config", "check", "--config", configPath], sandbox);
    expect(passing.code).toBe(0);
    expect(passing.stdout).toContain("PASS 1 repo(s) validated.");
  });

  test("writes pretty JSON config after add", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });

    const added = await runCli(["config", "add", repoRoot, "--id", "my-repo", "--name", "My Repo", "--config", configPath], sandbox);
    expect(added.code).toBe(0);

    const written = await readFile(configPath, "utf8");
    expect(written).toContain("\n  \"repos\": [\n");
    expect(written.endsWith("\n")).toBe(true);
  });

  test("remove supports exact legacy repo_id without normalization", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });

    await writeFile(configPath, JSON.stringify({
      repos: [
        { repo_id: "My_Repo", display_name: "Legacy", root: repoRoot }
      ],
      limits: {}
    }, null, 2));

    const removed = await runCli(["config", "remove", "My_Repo", "--config", configPath], sandbox);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("Removed repo_id=My_Repo");
  });

  test("preserves unknown config fields on add", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "connect-gpt-cli-"));
    const configPath = join(sandbox, "config.local.json");
    const repoRoot = join(sandbox, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });

    await writeFile(configPath, JSON.stringify({
      repos: [],
      limits: {},
      metadata: { owner: "team-a" }
    }, null, 2));

    const added = await runCli(["config", "add", repoRoot, "--id", "repo", "--config", configPath], sandbox);
    expect(added.code).toBe(0);

    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      metadata?: { owner?: string };
      repos: Array<{ repo_id: string }>;
    };
    expect(written.metadata?.owner).toBe("team-a");
    expect(written.repos).toHaveLength(1);
  });
});

async function writeDoctorPackageJson(root: string): Promise<void> {
  await writeFile(join(root, "package.json"), JSON.stringify({
    scripts: {
      mcp: "REPO_READER_CONFIG=./config.local.json PORT=8787 npm run dev",
      tunnel: "ngrok http 8787 --log=stdout",
      connect: "node scripts/connect-dev.mjs",
      build: "tsup src/server.ts",
      typecheck: "tsc --noEmit",
      lint: "eslint .",
      test: "vitest run"
    }
  }, null, 2));
}

type TestDoctorChecks = {
  ngrokInstalled?: () => Promise<boolean>;
  hasActiveNgrokTunnel?: () => Promise<boolean>;
  isPortInUse?: (port: number) => Promise<boolean>;
  isGitWorktreeDirty?: (cwd: string) => Promise<boolean>;
};

async function runCli(
  argv: string[],
  cwd: string,
  doctorChecks?: TestDoctorChecks,
  env: NodeJS.ProcessEnv = {}
): Promise<CliResult> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const code = await runConnectGptCli(argv, {
    cwd,
    env,
    doctorChecks,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line)
  });

  return {
    code,
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n")
  };
}
