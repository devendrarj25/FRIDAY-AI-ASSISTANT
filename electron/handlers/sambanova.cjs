"use strict";
const { defineCloudProvider } = require("../provider-module.cjs");

module.exports = defineCloudProvider({
  id: "sambanova",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "existing-catalogue",
  provenance: {
    sourceUrl: "https://api.sambanova.ai/v1/models",
    method: "existing-catalogue",
    fetchedAt: null,
    confidence: "unknown",
  },
  replacementMap: {},
});
