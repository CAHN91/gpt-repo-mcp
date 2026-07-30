const DEFAULT_SERVER_HOST = "127.0.0.1";

export function resolveServerHost(env: NodeJS.ProcessEnv): string {
  const host = env.GPT_REPO_HOST?.trim() || DEFAULT_SERVER_HOST;
  if (!isLoopbackHostname(host) && env.GPT_REPO_ALLOW_EXTERNAL_BIND !== "true") {
    throw new Error(
      `Refusing external MCP bind on ${host}. Set GPT_REPO_ALLOW_EXTERNAL_BIND=true only when the network boundary is intentional.`
    );
  }
  return host;
}

export function isAllowedBrowserOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(`http://${hostHeader ?? ""}`);
    return originUrl.protocol === "http:"
      && isLoopbackHostname(originUrl.hostname)
      && isLoopbackHostname(requestUrl.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
