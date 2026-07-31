import process from "node:process";

function resolvePlatformCommand(
  { executable, args, windowsCommandLine },
  { platform = process.platform, comSpec = process.env.ComSpec } = {}
) {
  if (platform === "win32") {
    return {
      command: comSpec || "cmd.exe",
      args: ["/d", "/s", "/c", windowsCommandLine]
    };
  }

  return {
    command: executable,
    args
  };
}

export function resolveNpmDevCommand(runtime) {
  return resolvePlatformCommand(
    {
      executable: "npm",
      args: ["run", "dev"],
      windowsCommandLine: "npm run dev"
    },
    runtime
  );
}

export function resolveNgrokVersionCommand(runtime) {
  return resolvePlatformCommand(
    {
      executable: "ngrok",
      args: ["version"],
      windowsCommandLine: "ngrok version"
    },
    runtime
  );
}

export function resolveNgrokTunnelCommand(port, runtime) {
  return resolvePlatformCommand(
    {
      executable: "ngrok",
      args: ["http", port, "--log=stdout"],
      windowsCommandLine: `ngrok http ${port} --log=stdout`
    },
    runtime
  );
}
