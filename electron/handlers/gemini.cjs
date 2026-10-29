"use strict";

const { defineCloudProvider } = require("../provider-module.cjs");

/**
 * Chat stays on the OpenAI-compatible base. Native page tokens are normalised
 * by protocol-gemini-generate when that payload appears. Prices were not
 * re-read on 2026-10-21. A new id is not marked free from the models page.
 */
module.exports = defineCloudProvider({
  id: "gemini",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "documented",
  provenance: {
    sourceUrl: "https://ai.google.dev/api/models",
    method: "official-docs",
    fetchedAt: "2026-10-21",
    confidence: "documented",
  },
  replacementMap: {},
});
