/**
 * Shared cloud handler. Provider files pass an id; endpoint, list, and
 * auth come from the one CLOUD catalogue in electron/models.cjs.
 */
"use strict";

const modelAccess = require("../model-access.cjs");
const { createHandler } = require("../provider-handler.cjs");

function catalogue() {
  return require("../models.cjs").CLOUD || {};
}

function authFor(id) {
  const spec = catalogue()[id];
  if (!spec || typeof spec.headers !== "function") return { scheme: "bearer" };
  const headers = spec.headers("TOKEN");
  const headerName = Object.keys(headers || {}).find((name) =>
    String(headers[name] || "").includes("TOKEN"),
  );
  if (!headerName || headerName.toLowerCase() === "authorization") return { scheme: "bearer" };
  return { scheme: "header", header: headerName };
}

function cloudHandler(id) {
  return createHandler({
    id,
    kind: "cloud",
    baseUrl() {
      const spec = catalogue()[id] || {};
      return spec.chat || spec.url || "";
    },
    auth: () => authFor(id),
    discoverModels(payload) {
      const spec = catalogue()[id];
      if (spec && typeof spec.list === "function") {
        try {
          return spec.list(payload || {});
        } catch {
          return [];
        }
      }
      return null;
    },
    classifyAccess(input, now) {
      return modelAccess.classifyModel(
        { ...(input || {}), providerId: id, kind: "cloud" },
        now || Date.now(),
      );
    },
    capabilities(model) {
      return require("../model-router.cjs").capabilitiesOf({
        ...(model || {}),
        providerId: id,
      });
    },
    buildRequest(input) {
      const models = require("../models.cjs");
      const spec = catalogue()[id] || {};
      const base = String(spec.chat || "").replace(/\/+$/, "");
      const model = String(input?.model || input?.modelId || "");
      const messages = Array.isArray(input?.messages) ? input.messages : [];
      if (spec.wire === "anthropic") {
        return {
          url: base ? `${base}/messages` : "",
          wire: "anthropic",
          body: { model, messages, stream: input?.stream !== false },
        };
      }
      return {
        url: base ? models.openaiChatUrl(base, spec.chatPath) : "",
        wire: spec.wire || "online",
        body: { model, messages, stream: input?.stream !== false },
      };
    },
    parseStream(chunk) {
      return require("../models.cjs").parseOpenAiSse(chunk);
    },
    mapError(error) {
      return require("../model-router.cjs").classifyError(error);
    },
    quota(headers) {
      return modelAccess.quotaMeter(headers);
    },
    health(snapshot) {
      const entries = Array.isArray(snapshot) ? snapshot : snapshot?.models || [];
      const mine = entries.filter((entry) => String(entry?.modelId || "").split(":")[0] === id);
      if (!mine.length) return { status: "unknown", models: 0 };
      const open = mine.some(
        (entry) => entry.breaker === "OPEN" || entry.status === "cooling-down",
      );
      return { status: open ? "cooling-down" : "healthy", models: mine.length };
    },
  });
}

module.exports = { cloudHandler };
