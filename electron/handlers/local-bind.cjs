/**
 * Shared local handler. Endpoint data stays in electron/models.cjs.
 * Nothing here starts a process or downloads a launcher.
 */
"use strict";

const modelAccess = require("../model-access.cjs");
const { createHandler, defaultDiscover } = require("../provider-handler.cjs");

function endpointFor(id) {
  const models = require("../models.cjs");
  if (id === "ollama") return models.OLLAMA || "";
  return models.LOCAL_ENGINES?.[id]?.endpoint || "";
}

function localHandler(id, overrides = {}) {
  return createHandler({
    id,
    kind: "local",
    baseUrl() {
      return endpointFor(id);
    },
    auth: { scheme: "none" },
    discoverModels(payload) {
      if (overrides.discoverModels) return overrides.discoverModels(payload);
      return defaultDiscover(payload);
    },
    classifyAccess(input, now) {
      return modelAccess.classifyModel(
        { ...(input || {}), providerId: id, kind: "local" },
        now || Date.now(),
      );
    },
    capabilities(model) {
      return require("../model-router.cjs").capabilitiesOf({
        ...(model || {}),
        providerId: id,
        type: "local",
        kind: "local",
      });
    },
    buildRequest(input) {
      const base = String(endpointFor(id) || "").replace(/\/+$/, "");
      const model = String(input?.model || input?.modelId || "");
      const messages = Array.isArray(input?.messages) ? input.messages : [];
      if (id === "ollama") {
        return {
          url: base ? `${base}/api/chat` : "",
          wire: "ollama",
          body: { model, messages, stream: input?.stream !== false },
        };
      }
      const models = require("../models.cjs");
      return {
        url: base ? models.openaiChatUrl(base) : "",
        wire: "online",
        body: { model, messages, stream: input?.stream !== false },
      };
    },
    parseStream(chunk) {
      return require("../models.cjs").parseOpenAiSse(chunk);
    },
    mapError(error) {
      return require("../model-router.cjs").classifyError(error);
    },
    quota() {
      return null;
    },
    health(snapshot) {
      const entries = Array.isArray(snapshot) ? snapshot : snapshot?.models || [];
      const mine = entries.filter((entry) => String(entry?.modelId || "").startsWith(`${id}:`));
      if (!mine.length) return { status: "unknown", models: 0 };
      return { status: "healthy", models: mine.length };
    },
    launcher: { id, autoStart: false },
  });
}

module.exports = { localHandler };
