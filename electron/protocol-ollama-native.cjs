/**
 * Ollama native chat. The local handler stays on POST /api/chat.
 * The OpenAI-compatible /v1 surface is documented and not the product path.
 */
"use strict";

const openai = require("./protocol-openai-compatible.cjs");

function buildChat(spec, input) {
  const base = String(spec?.chat || spec?.base || "").replace(/\/+$/, "");
  const model = String(input?.model || input?.modelId || "");
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  return {
    url: base ? `${base}/api/chat` : "",
    wire: "ollama",
    body: { model, messages, stream: input?.stream !== false },
  };
}

function parseStream(text) {
  const raw = String(text || "").trim();
  if (!raw) return { content: "", sawDone: false, sawTool: false, error: "" };
  if (raw.startsWith("{") && !raw.includes("\n")) {
    try {
      const one = JSON.parse(raw);
      if (one && one.error) {
        const message =
          typeof one.error === "string"
            ? one.error
            : one.error.message || JSON.stringify(one.error);
        return { content: "", sawDone: false, sawTool: false, error: String(message) };
      }
    } catch {
      /* fall through to lines */
    }
  }
  let content = "";
  let sawDone = false;
  let error = "";
  for (const line of raw.split(/\r?\n/)) {
    const textLine = line.trim();
    if (!textLine) continue;
    try {
      const payload = JSON.parse(textLine);
      if (payload.error) {
        error = String(
          typeof payload.error === "string"
            ? payload.error
            : payload.error.message || payload.error,
        );
        continue;
      }
      content += openai.coerceChatText(payload.message?.content || payload.response || "");
      if (payload.done) sawDone = true;
    } catch {
      /* keep scanning */
    }
  }
  return { content: content.trim(), sawDone, sawTool: false, error };
}

module.exports = { buildChat, parseStream };
