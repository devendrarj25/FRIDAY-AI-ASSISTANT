/**
 * FRIDAY · stdio MCP launcher.
 *
 * Clients spawn this script. Protocol frames go to stdout. Logs go to stderr.
 * If FRIDAY is not running, the script returns one JSON-RPC error and does
 * not run tools. A minimized start does not run tools either.
 */
const proto = require("./mcp-protocol.cjs");
const { planWhenAbsent } = require("./mcp-launch.cjs");

function absentMessage() {
  return "FRIDAY is not running. Open FRIDAY, turn the MCP server on, and try again.";
}

function writeError(stdout, stderr, message) {
  stderr.write(`${message}\n`);
  stdout.write(proto.encodeLine(proto.jsonRpcError(null, proto.ERROR.INTERNAL, message)));
}

function attachProxy({ stdin, stdout, stderr, post }) {
  let buf = "";
  let chain = Promise.resolve();
  const onData = (chunk) => {
    buf += String(chunk);
    const split = proto.splitFrames(buf);
    buf = split.rest;
    for (const raw of split.messages) {
      chain = chain.then(async () => {
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          stderr.write("Ignored a frame that was not JSON.\n");
          return;
        }
        try {
          const result = await post(message);
          if (result == null || message.id == null) return;
          stdout.write(proto.encodeLine(result));
        } catch (error) {
          stderr.write(`${String(error?.message || error)}\n`);
          if (message.id != null) {
            stdout.write(
              proto.encodeLine(
                proto.jsonRpcError(
                  message.id,
                  proto.ERROR.INTERNAL,
                  "FRIDAY did not answer. Open FRIDAY and try again.",
                ),
              ),
            );
          }
        }
      });
    }
  };
  stdin.on("data", onData);
  return { onData, flush: () => chain };
}

function loopbackPost({ port, install, token, fetchImpl }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  return async (message) => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      host: `127.0.0.1:${port}`,
      "mcp-protocol-version": proto.CURRENT_VERSION,
      "mcp-method": String(message?.method || ""),
      "x-friday-install": install || "",
    };
    if (message?.method === "tools/call") headers["mcp-name"] = String(message?.params?.name || "");
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchFn(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return proto.jsonRpcError(
        message?.id ?? null,
        proto.ERROR.PARSE,
        "FRIDAY returned a response that was not JSON.",
      );
    }
  };
}

function runLauncher({ running = false, startMinimized = false, stdout, stderr, forward } = {}) {
  const plan = planWhenAbsent({ running, startMinimized });
  if (plan.action === "error") {
    writeError(stdout, stderr, plan.message);
    return plan;
  }
  if (plan.action === "start-minimized") {
    stderr.write(`${plan.message}\n`);
    return plan;
  }
  if (typeof forward === "function") return { action: "proxy", forward };
  writeError(stdout, stderr, absentMessage());
  return { action: "error", message: absentMessage() };
}

if (require.main === module) {
  const port = process.env.FRIDAY_MCP_PORT || "";
  const install = process.env.FRIDAY_MCP_INSTALL || "";
  const running = Boolean(port && install);
  const plan = runLauncher({
    running,
    startMinimized: process.env.FRIDAY_MCP_START_MINIMIZED === "1",
    stdout: process.stdout,
    stderr: process.stderr,
    forward: running
      ? loopbackPost({ port, install, token: process.env.FRIDAY_MCP_TOKEN || "" })
      : null,
  });
  if (plan.action === "proxy" && typeof plan.forward === "function") {
    attachProxy({
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      post: plan.forward,
    });
    process.stdin.resume();
  }
}

module.exports = { runLauncher, absentMessage, writeError, attachProxy, loopbackPost };
