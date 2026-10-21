/**
 * Anthropic Messages request shape.
 * The stream parser still understands the OpenAI SSE the product already
 * accepted, and also a content_block_delta frame when that shape is present.
 */
"use strict";

const openai = require("./protocol-openai-compatible.cjs");

function buildChat(spec, input) {
  const base = String(spec?.chat || spec?.base || "").replace(/\/+$/, "");
  const model = String(input?.model || input?.modelId || "");
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  return {
    url: base ? `${base}/messages` : "",
    wire: "anthropic",
    body: { model, messages, stream: input?.stream !== false },
  };
}

function parseStream(text) {
  const open = openai.parseStream(text);
  if (open.content || open.sawDone || open.sawTool) return open;
  let content = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.replace(/^data:\s?/, "").trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const frame = JSON.parse(payload);
      if (frame.type === "content_block_delta") {
        content += openai.coerceChatText(frame.delta?.text || frame.delta?.partial_json || "");
      }
    } catch {
      /* keep scanning */
    }
  }
  if (!content) return open;
  return { content: content.trim(), sawDone: false, sawTool: false };
}

module.exports = { buildChat, parseStream };
