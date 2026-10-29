"use strict";

const { defineLocalProvider } = require("../provider-module.cjs");

/**
 * Local native chat. The hosted ollama.com API is not a route.
 * Docs re-read 2026-10-21: POST /api/chat and the OpenAI-compatible /v1 surface.
 */
module.exports = defineLocalProvider({
  id: "ollama",
  protocol: "ollama",
  endpointKinds: ["chat"],
  discovery: "documented",
  endpoint() {
    return require("../models.cjs").OLLAMA || "";
  },
  discoverModels(payload) {
    const rows = payload?.models || [];
    return rows.map((row) => row?.name || row?.model || row?.id).filter(Boolean);
  },
  provenance: {
    sourceUrl: "https://docs.ollama.com/api/chat",
    method: "official-docs",
    fetchedAt: "2026-10-21",
    confidence: "documented",
  },
  replacementMap: {},
});
