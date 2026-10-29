/**
 * Shared cloud handler. Provider files pass an id and a module spec.
 * Endpoint, list, and auth come from the one CLOUD catalogue in electron/models.cjs.
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

function protocolFor(spec, catalogueSpec) {
  if (spec && spec.protocol) return spec.protocol;
  if (catalogueSpec && catalogueSpec.wire === "anthropic") return "anthropic-messages";
  return "openai-compatible";
}

function cloudHandler(id, spec = {}) {
  return createHandler({
    id,
    kind: "cloud",
    baseUrl() {
      const row = catalogue()[id] || {};
      return row.chat || row.url || "";
    },
    auth: () => authFor(id),
    discoverModels(payload) {
      const row = catalogue()[id];
      if (row && typeof row.list === "function") {
        try {
          return row.list(payload || {});
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
      const row = catalogue()[id] || {};
      const protocols = require("../protocol-registry.cjs");
      const protocol = protocolFor(spec, row);
      let next = input || {};
      if (typeof spec.routeWithinProvider === "function") {
        const routed = spec.routeWithinProvider(next) || {};
        if (routed.model) next = { ...next, model: routed.model, modelId: routed.model };
      }
      const built = protocols.buildChat(
        protocol,
        { chat: row.chat, chatPath: row.chatPath, wire: row.wire },
        next,
      );
      if (typeof spec.routeBody === "function" && built.body && typeof built.body === "object") {
        const extra = spec.routeBody(next) || {};
        if (extra && typeof extra === "object" && !Array.isArray(extra)) {
          built.body = { ...built.body, ...extra };
        }
      }
      return built;
    },
    parseStream(chunk) {
      const row = catalogue()[id] || {};
      return require("../protocol-registry.cjs").parseStream(protocolFor(spec, row), chunk);
    },
    mapError(error) {
      return require("../model-router.cjs").classifyError(error);
    },
    quota(headers) {
      return modelAccess.quotaMeter(headers);
    },
    gate() {
      const row = catalogue()[id] || {};
      return {
        id,
        kind: "cloud",
        listUrl: String(row.url || ""),
        chatUrl: String(row.chat || ""),
        verify: row.verify || null,
        mayTrain: spec.mayTrain === true,
        privacyUrl: spec.privacyUrl || "",
        healthProbe: "zero-spend",
      };
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
