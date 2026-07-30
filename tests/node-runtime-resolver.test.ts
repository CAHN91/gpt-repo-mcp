import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { NodeRuntimeResolver } from "../src/services/node-runtime-resolver.js";

const VERSION = "24.18.0";

describe("NodeRuntimeResolver", () => {
  test.each([
    ["nvm", [".nvm", "versions", "node", `v${VERSION}`, "bin", "node"]],
    ["mise", [".local", "share", "mise", "installs", "node", VERSION, "bin", "node"]],
    ["fnm", [".fnm", "node-versions", `v${VERSION}`, "installation", "bin", "node"]],
    ["Volta", [".volta", "tools", "image", "node", VERSION, "bin", "node"]],
    ["asdf", [".asdf", "installs", "nodejs", VERSION, "bin", "node"]]
  ])("selects an installed %s runtime", async (_manager, runtimeParts) => {
    const root = await mkdtemp(join(tmpdir(), "gpt-node-repo-"));
    const home = await mkdtemp(join(tmpdir(), "gpt-node-home-"));
    await writeFile(join(root, ".node-version"), `${VERSION}\n`);
    const executable = join(home, ...runtimeParts);
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, `#!${process.execPath}\nconsole.log("v${VERSION}");\n`);
    await chmod(executable, 0o755);

    await expect(new NodeRuntimeResolver(root, { home, env: {} }).resolve()).resolves.toEqual({
      name: "node",
      version: VERSION,
      source: ".node-version",
      bin_directory: join(executable, "..")
    });
  });
});
