/**
 * LM Studio 0.4 native routes are recorded here.
 * Product chat stays on the OpenAI-compatible base.
 */
"use strict";

const openai = require("./protocol-openai-compatible.cjs");

const NATIVE = {
  models: "/api/v1/models",
  load: "/api/v1/models/load",
  unload: "/api/v1/models/unload",
  download: "/api/v1/models/download",
  downloadStatus: "/api/v1/models/download/status",
  chat: "/api/v1/chat",
};

function buildChat(spec, input) {
  return openai.buildChat(spec, input);
}

function parseStream(text) {
  return openai.parseStream(text);
}

module.exports = { NATIVE, buildChat, parseStream };
