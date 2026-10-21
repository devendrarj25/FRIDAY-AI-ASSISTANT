"use strict";

const { defineCloudProvider } = require("../provider-module.cjs");

module.exports = defineCloudProvider({
  id: "anthropic",
  protocol: "anthropic-messages",
  endpointKinds: ["messages"],
  discovery: "existing-catalogue",
  provenance: {
    sourceUrl: "https://api.anthropic.com/v1/models",
    method: "existing-catalogue",
    fetchedAt: null,
    confidence: "unknown",
  },
  replacementMap: {},
});
