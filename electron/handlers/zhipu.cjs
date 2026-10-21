"use strict";
const { defineCloudProvider } = require("../provider-module.cjs");

module.exports = defineCloudProvider({
  id: "zhipu",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "existing-catalogue",
  provenance: {
    sourceUrl: "https://api.z.ai/api/paas/v4/models",
    method: "existing-catalogue",
    fetchedAt: null,
    confidence: "unknown",
  },
  replacementMap: {},
});
