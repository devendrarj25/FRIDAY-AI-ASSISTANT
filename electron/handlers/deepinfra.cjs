"use strict";
const { defineCloudProvider } = require("../provider-module.cjs");

module.exports = defineCloudProvider({
  id: "deepinfra",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "existing-catalogue",
  provenance: {
    sourceUrl: "https://api.deepinfra.com/v1/models",
    method: "existing-catalogue",
    fetchedAt: null,
    confidence: "unknown",
  },
  replacementMap: {},
});
