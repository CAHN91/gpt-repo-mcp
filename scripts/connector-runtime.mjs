import process from "node:process";

export function createConnectorRuntime(options = {}) {
  const output = options.output ?? process.stdout;
  const reportError = options.reportError ?? ((message) => globalThis.console.error(message));
  const exit = options.exit ?? ((code) => process.exit(code));
  const schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const children = new Set();
  let shuttingDown = false;

  function track(child, label, trackOptions = {}) {
    const state = { child, exited: false };
    children.add(state);
    prefixOutput(child.stdout, label, output, trackOptions.onLine);
    prefixOutput(child.stderr, label, output, trackOptions.onLine);
    child.once("exit", (code, signal) => {
      state.exited = true;
      if (shuttingDown) {
        return;
      }
      reportError(`[${label}] exited (code=${code ?? "null"}, signal=${signal ?? "null"}). Stopping other process.`);
      terminateAndExit(code ?? 1);
    });
    child.once("error", (error) => {
      if (shuttingDown) {
        return;
      }
      reportError(`[${label}] failed to start: ${error.message}`);
      terminateAndExit(1);
    });
    return child;
  }

  function terminateAndExit(code) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    signalChildren("SIGTERM");
    schedule(() => signalChildren("SIGKILL"), 1500);
    schedule(() => exit(code), 1700);
  }

  function shutdown(signal, message) {
    if (shuttingDown) {
      return;
    }
    output.write(`Received ${signal}. ${message}\n`);
    terminateAndExit(0);
  }

  function signalChildren(signal) {
    for (const state of children) {
      if (!state.exited) {
        state.child.kill(signal);
      }
    }
  }

  return {
    shutdown,
    terminateAndExit,
    track
  };
}

function prefixOutput(stream, label, output, onLine) {
  if (!stream) {
    return;
  }
  let buffer = "";
  const writeLine = (line) => {
    onLine?.(line);
    output.write(`[${label}] ${line}\n`);
  };
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      writeLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      writeLine(buffer);
    }
  });
}
