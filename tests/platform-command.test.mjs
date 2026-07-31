import { describe, expect, test } from "vitest";
import {
  resolveNgrokTunnelCommand,
  resolveNgrokVersionCommand,
  resolveNpmDevCommand
} from "../scripts/platform-command.mjs";

describe("platform command selection", () => {
  test("uses ComSpec for all Windows connector commands", () => {
    const runtime = {
      platform: "win32",
      comSpec: "C:\\Windows\\System32\\cmd.exe"
    };

    expect(resolveNpmDevCommand(runtime)).toEqual({
      command: runtime.comSpec,
      args: ["/d", "/s", "/c", "npm run dev"]
    });
    expect(resolveNgrokVersionCommand(runtime)).toEqual({
      command: runtime.comSpec,
      args: ["/d", "/s", "/c", "ngrok version"]
    });
    expect(resolveNgrokTunnelCommand("8787", runtime)).toEqual({
      command: runtime.comSpec,
      args: ["/d", "/s", "/c", "ngrok http 8787 --log=stdout"]
    });
  });

  test("falls back to cmd.exe when ComSpec is unavailable", () => {
    expect(resolveNpmDevCommand({ platform: "win32", comSpec: "" })).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm run dev"]
    });
  });

  test.each(["linux", "darwin"])("uses direct executables and arguments on %s", (platform) => {
    const runtime = {
      platform,
      comSpec: "ignored.exe"
    };

    expect(resolveNpmDevCommand(runtime)).toEqual({
      command: "npm",
      args: ["run", "dev"]
    });
    expect(resolveNgrokVersionCommand(runtime)).toEqual({
      command: "ngrok",
      args: ["version"]
    });
    expect(resolveNgrokTunnelCommand("8787", runtime)).toEqual({
      command: "ngrok",
      args: ["http", "8787", "--log=stdout"]
    });
  });

  test("never returns a shell option", () => {
    const commands = [
      resolveNpmDevCommand({ platform: "win32" }),
      resolveNgrokVersionCommand({ platform: "linux" }),
      resolveNgrokTunnelCommand("8787", { platform: "darwin" })
    ];

    for (const command of commands) {
      expect(command).not.toHaveProperty("shell");
    }
  });
});
