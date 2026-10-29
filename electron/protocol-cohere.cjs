/**
 * Cohere compatibility chat uses the OpenAI-compatible adapter.
 * Native rerank and embed builders stay here for those endpoint kinds.
 * The product chat URL is still the compatibility base.
 */
"use strict";

const openai = require("./protocol-openai-compatible.cjs");

function buildChat(spec, input) {
  return openai.buildChat(spec, input);
}

function buildRerank(spec, input) {
  const base = String(spec?.rerank || "https://api.cohere.com/v1").replace(/\/+$/, "");
  return {
    url: `${base}/rerank`,
    wire: "cohere",
    body: {
      model: String(input?.model || ""),
      query: String(input?.query || ""),
      documents: Array.isArray(input?.documents) ? input.documents : [],
    },
  };
}

function buildEmbed(spec, input) {
  const base = String(spec?.embed || "https://api.cohere.com/v1").replace(/\/+$/, "");
  return {
    url: `${base}/embed`,
    wire: "cohere",
    body: {
      model: String(input?.model || ""),
      texts: Array.isArray(input?.texts) ? input.texts : [],
    },
  };
}

function parseStream(text) {
  return openai.parseStream(text);
}

module.exports = { buildChat, buildRerank, buildEmbed, parseStream };
