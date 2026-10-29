/**
 * Shared local handler. Endpoint data stays in electron/models.cjs.
 * Nothing here starts a process or downloads a launcher.
 * The protocol name comes from the provider module.
 */
"use strict";

const modelAccess = require("../model-access.cjs");
const { createHandler, defaultDiscover } = require("../provider-handler.cjs");

function endpointFor(id, overrides) {
  if (overrides && typeof overrides.endpoint === "function") return overrides.endpoint();
  const models = require("../models.cjs");
  return models.LOCAL_ENGINES?.[id]?.endpoint || "";
}

function localHandler(id, overrides = {}) {
  const protocol = overrides.protocol || "openai-compatible";
  return createHandler({
    id,
    kind: "local",
    baseUrl() {
      return endpointFor(id, overrides);
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
      const base = String(endpointFor(id, overrides) || "").replace(/\/+$/, "");
      const protocols = require("../protocol-registry.cjs");
      return protocols.buildChat(protocol, { chat: base, base, wire: "online" }, input);
    },
    parseStream(chunk) {
      return require("../protocol-registry.cjs").parseStream(protocol, chunk);
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
