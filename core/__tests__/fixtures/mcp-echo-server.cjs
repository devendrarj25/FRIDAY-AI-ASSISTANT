#!/usr/bin/env node
/**
 * Minimal MCP stdio fixture for tests. Speaks newline JSON-RPC 2.0:
 * initialize → tools/list → tools/call. Not shipped in the EXE.
 */
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += String(chunk);
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg || msg.method === "notifications/initialized") continue;
    if (msg.method === "initialize") {
      reply(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-fixture", version: "1" },
      });
      continue;
    }
    if (msg.method === "tools/list") {
      reply(msg.id, {
        tools: [
          {
            name: "echo",
            description: "Echo text back",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
          { name: "ping", description: "Ping" },
        ],
      });
      continue;
    }
    if (msg.method === "tools/call") {
      const name = String(msg.params?.name || "");
      const text =
        name === "echo" ? String(msg.params?.arguments?.text || "") : name === "ping" ? "pong" : "";
      reply(msg.id, { content: [{ type: "text", text }] });
    }
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
