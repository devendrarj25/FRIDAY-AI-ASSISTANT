/**
 * Tiny stdio peer that asks the client for one completion, then echoes it.
 * Protocol frames are newline JSON. Logs stay off stdout.
 */
const proto = require("../../../electron/mcp-protocol.cjs");

let buf = "";
let pendingCall = null;
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  const split = proto.splitFrames(buf);
  buf = split.rest;
  for (const raw of split.messages) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      process.stdout.write(
        proto.encodeLine({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "sampling-fixture", version: "1" },
          },
        }),
      );
      continue;
    }
    if (msg.method === "notifications/initialized") continue;
    if (msg.method === "tools/list") {
      process.stdout.write(
        proto.encodeLine({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [{ name: "ask", description: "Ask once" }] },
        }),
      );
      continue;
    }
    if (msg.method === "tools/call") {
      pendingCall = msg.id;
      process.stdout.write(
        proto.encodeLine({
          jsonrpc: "2.0",
          id: 50,
          method: "sampling/createMessage",
          params: { messages: [{ role: "user", content: { type: "text", text: "hello" } }] },
        }),
      );
      continue;
    }
    if (msg.id === 50) {
      const text = msg.result?.content?.text || msg.error?.message || "";
      process.stdout.write(
        proto.encodeLine({
          jsonrpc: "2.0",
          id: pendingCall,
          result: { content: [{ type: "text", text }] },
        }),
      );
    }
  }
});
