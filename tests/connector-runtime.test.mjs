import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createConnectorRuntime } from "../scripts/connector-runtime.mjs";

describe("connector runtime", () => {
  test("prefixes complete and trailing output lines and exposes each line", async () => {
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    const lines = [];
    const runtime = createConnectorRuntime({
      output,
      reportError: () => undefined,
      exit: () => undefined,
      schedule: () => undefined
    });
    const child = fakeChild();

    runtime.track(child, "mcp", { onLine: (line) => lines.push(line) });
    child.stdout.write("first\npart");
    child.stdout.end("ial");
    await once(child.stdout, "end");

    expect(rendered).toBe("[mcp] first\n[mcp] partial\n");
    expect(lines).toEqual(["first", "partial"]);
  });

  test("an unexpected child exit terminates every child before exiting after the grace period", () => {
    const errors = [];
    const exits = [];
    const scheduled = [];
    const runtime = createConnectorRuntime({
      output: new PassThrough(),
      reportError: (message) => errors.push(message),
      exit: (code) => exits.push(code),
      schedule: (callback, delay) => scheduled.push({ callback, delay })
    });
    const mcp = fakeChild();
    const tunnel = fakeChild();
    runtime.track(mcp, "mcp");
    runtime.track(tunnel, "tunnel");

    mcp.emit("exit", 7, null);

    expect(mcp.kills).toEqual([]);
    expect(tunnel.kills).toEqual(["SIGTERM"]);
    expect(errors).toEqual(["[mcp] exited (code=7, signal=null). Stopping other process."]);
    expect(scheduled.map(({ delay }) => delay)).toEqual([1500, 1700]);
    expect(exits).toEqual([]);

    scheduled.find(({ delay }) => delay === 1500).callback();
    scheduled.find(({ delay }) => delay === 1700).callback();

    expect(mcp.kills).toEqual([]);
    expect(tunnel.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(exits).toEqual([7]);
  });

  test("shutdown is idempotent and exits cleanly after terminating children", () => {
    const exits = [];
    const scheduled = [];
    const runtime = createConnectorRuntime({
      output: new PassThrough(),
      reportError: () => undefined,
      exit: (code) => exits.push(code),
      schedule: (callback, delay) => scheduled.push({ callback, delay })
    });
    const child = fakeChild();
    runtime.track(child, "mcp");

    runtime.shutdown("SIGINT", "Shutting down connector.");
    runtime.shutdown("SIGTERM", "Ignored duplicate.");

    expect(child.kills).toEqual(["SIGTERM"]);
    expect(scheduled.map(({ delay }) => delay)).toEqual([1500, 1700]);
    scheduled.find(({ delay }) => delay === 1700).callback();
    expect(exits).toEqual([0]);
  });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
  };
  return child;
}
