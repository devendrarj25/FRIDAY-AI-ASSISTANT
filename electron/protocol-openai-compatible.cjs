/**
 * OpenAI-compatible chat. One implementation of the chat URL and SSE parser.
 * Provider modules call this. They do not copy it.
 */
"use strict";

const VERSIONED_TAIL = /\/(v\d+[a-z0-9]*|openai|compatibility\/v\d+|paas\/v\d+)$/i;

function chatUrl(base, chatPath) {
  const trimmed = String(base || "").replace(/\/+$/, "");
  if (chatPath) return trimmed + chatPath;
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (VERSIONED_TAIL.test(trimmed)) return trimmed + "/chat/completions";
  return trimmed + "/v1/chat/completions";
}

function coerceChatText(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return item.text || item.content || "";
        return "";
      })
      .join("");
  }
  return String(raw);
}

function parseStream(text) {
  let content = "";
  let sawDone = false;
  let sawTool = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.replace(/^data:\s?/, "").trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      sawDone = true;
      continue;
    }
    try {
      const frame = JSON.parse(payload);
      const choice = (frame.choices || [])[0] || {};
      const delta = choice.delta || {};
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) sawTool = true;
      content += coerceChatText(
        delta.content ||
          delta.text ||
          choice.text ||
          (choice.message && choice.message.content) ||
          frame.text,
      );
    } catch {
      /* keep scanning */
    }
  }
  return { content: String(content || "").trim(), sawDone, sawTool };
}

function buildChat(spec, input) {
  const base = String(spec?.chat || spec?.base || "").replace(/\/+$/, "");
  const model = String(input?.model || input?.modelId || "");
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  return {
    url: base ? chatUrl(base, spec?.chatPath) : "",
    wire: spec?.wire || "online",
    body: { model, messages, stream: input?.stream !== false },
  };
}

/** List row fields documented for GET /v1/models. Unknown fields stay null. */
function normaliseListRow(row) {
  const nativeId = String(row?.id || "");
  return {
    nativeId,
    displayName: nativeId,
    owner: row?.owned_by || null,
    created: Number.isFinite(row?.created) ? row.created : null,
    object: row?.object || null,
    endpointKinds: ["chat"],
    lifecycle: "active",
    replacement: null,
  };
}

module.exports = {
  VERSIONED_TAIL,
  chatUrl,
  coerceChatText,
  parseStream,
  buildChat,
  normaliseListRow,
};
