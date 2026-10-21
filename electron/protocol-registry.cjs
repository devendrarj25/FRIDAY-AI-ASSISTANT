/**
 * Shared protocol adapters. A provider module names one. It does not copy the wire.
 */
"use strict";

const openai = require("./protocol-openai-compatible.cjs");
const anthropic = require("./protocol-anthropic-messages.cjs");
const gemini = require("./protocol-gemini-generate.cjs");
const cohere = require("./protocol-cohere.cjs");
const ollama = require("./protocol-ollama-native.cjs");
const lmstudio = require("./protocol-lmstudio-native.cjs");

const ADAPTERS = {
  "openai-compatible": openai,
  "anthropic-messages": anthropic,
  "gemini-generate": gemini,
  cohere,
  ollama,
  "lmstudio-native": lmstudio,
};

function adapter(name) {
  return ADAPTERS[String(name || "")] || openai;
}

function buildChat(name, spec, input) {
  return adapter(name).buildChat(spec, input);
}

function parseStream(name, chunk) {
  const selected = adapter(name);
  return selected.parseStream ? selected.parseStream(chunk) : openai.parseStream(chunk);
}

module.exports = { ADAPTERS, adapter, buildChat, parseStream };
