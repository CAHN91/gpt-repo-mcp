# Connection Options

ChatGPT cannot call a local `localhost` MCP server directly. GPT Repo MCP supports three connection paths:

- built-in quickstart with `npm run connect`
- manual local server plus your own HTTPS tunnel or reverse proxy
- advanced OpenAI Secure MCP Tunnel when your workspace supports it

The bundled connector commands keep the MCP server and tunnel lifecycle
together. Stopping the command shuts down both processes.

## ngrok prerequisites

The built-in quickstart uses the ngrok Agent CLI. If ngrok is not installed yet:

1. Create a free ngrok account.
2. Install the ngrok Agent CLI.
3. Run `ngrok help` to confirm the CLI is on your PATH.
4. Run the account connection command shown in your ngrok dashboard once on your machine.

For copy-paste install commands for macOS, Debian/Ubuntu Linux, and Windows, see [Install ngrok from zero](SETUP.md#install-ngrok-from-zero).

## Built-In Quickstart

Use `npm run connect` first for local OSS setup. It starts the local MCP server, starts or reuses ngrok as a convenience HTTPS tunnel, and prints a URL like:

```text
ChatGPT MCP URL: https://<ngrok-host>/t/<random-token>/mcp
```

Paste the exact printed URL into ChatGPT Developer Mode connector settings.

The random path token is guess-resistance only, not authentication. Anyone with the full URL can reach the endpoint while the tunnel is running. Treat the public URL as a temporary local development endpoint and stop it when done.

## Manual Tunnel Provider

Use this path when you want to choose your own HTTPS tunnel provider or reverse proxy.

Start the MCP server with an explicit random public path value. Set `GPT_REPO_PUBLIC_PATH_TOKEN` in your shell or `.env` before starting the server, then use the same value in the connector URL path.

Then expose local port `8787` with your preferred HTTPS tunnel or reverse proxy.

ngrok example: `ngrok http 8787`.

Cloudflare Tunnel example: `cloudflared tunnel --url http://127.0.0.1:8787`.

Use this ChatGPT connector URL shape:

```text
https://<public-host>/t/<that-token>/mcp
```

If you only need the local MCP server without a tunnel, run `npm run mcp`. It starts only the local server on `127.0.0.1`. It does not create a public path token or start a tunnel.

The server binds to `127.0.0.1` by default. Local ngrok, Cloudflare, and Secure
MCP Tunnel clients should connect to that loopback address. A direct external
bind requires both an explicit `GPT_REPO_HOST` and
`GPT_REPO_ALLOW_EXTERNAL_BIND=true`; use that escape hatch only behind a
network boundary you control.

## Advanced: OpenAI Secure MCP Tunnel

OpenAI Secure MCP Tunnel is useful for longer-lived or private connector setups when your ChatGPT workspace supports MCP tunnels.

Create `.env` with `cp .env.example .env`, then fill in your local tunnel settings:

```bash
CONTROL_PLANE_API_KEY=
TUNNEL_CLIENT_BIN=/path/to/tunnel-client
TUNNEL_CLIENT_PROFILE=gpt-repo-local
GPT_REPO_CONFIG=./config.local.json
GPT_REPO_HOST=127.0.0.1
PORT=8787
GPT_REPO_LOG_FORMAT=pretty
GPT_REPO_MAX_SESSIONS=100
GPT_REPO_SESSION_IDLE_TTL_MS=1800000
```

The main server keeps at most 100 concurrent MCP sessions by default and
closes sessions after 30 minutes without a request. `GPT_REPO_MAX_SESSIONS`
accepts 1–1000 and `GPT_REPO_SESSION_IDLE_TTL_MS` accepts 1000–86400000.
DELETE closes the selected transport, and graceful process shutdown closes all
remaining transports.

`TUNNEL_CLIENT_PROFILE=gpt-repo-local` is an example local `tunnel-client` profile label. It is not a `repo_id`, GitHub repo, ChatGPT connector name, ngrok tunnel, or MCP server name. Create or configure a local `tunnel-client` profile with that name, or replace the value with your own configured profile name.

Legacy `REPO_READER_CONFIG`, `REPO_READER_PUBLIC_PATH_TOKEN`, `REPO_READER_LOG_FORMAT`, and `REPO_READER_LOG_COLOR` remain supported as fallback aliases, but public docs use `GPT_REPO_*`.

Then start the local server and secure tunnel with `npm run connect:secure`. The script reads `TUNNEL_CLIENT_PROFILE` and runs `tunnel-client run --profile <profile>`.

With Secure MCP Tunnel, the local MCP endpoint stays private at `http://127.0.0.1:8787/mcp`; `tunnel-client` opens an outbound connection to OpenAI and forwards MCP requests back to the local server.

In ChatGPT connector settings, choose Tunnel as the connection type and select or paste the `tunnel_...` id.

## Security Notes

- Public tunnel URLs are reachable by anyone who has the full URL while the tunnel is running.
- The random `/t/<token>/mcp` path is guess-resistance only, not authentication.
- Repository policy still applies: ChatGPT supplies `repo_id`, approved roots are enforced, path sandboxing and secret checks remain active, and mutating tools stay disabled unless the repo explicitly opts in.
- Stop temporary public tunnels when done.
- Do not commit `.env`, `config.local.json`, tunnel runtime API keys, or local tunnel profiles.

## Troubleshooting

- Connector cannot connect after `npm run connect`: confirm the command is still running and paste the exact current `/t/<random-token>/mcp` URL.
- URL is rejected: confirm it starts with `https://` and includes `/t/<token>/mcp`.
- Manual tunnel returns 404: confirm the server was started with `GPT_REPO_PUBLIC_PATH_TOKEN` and the connector URL uses the same token.
- Secure Tunnel connector cannot discover tools: keep `npm run connect:secure` running and refresh connector metadata in ChatGPT.
- Local MCP is unreachable: run `curl http://127.0.0.1:8787/health` while the local server is running.
