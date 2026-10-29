"use strict";
const { defineLocalProvider } = require("../provider-module.cjs");

module.exports = defineLocalProvider({
  id: "mlx",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "existing-catalogue",
  provenance: {
    sourceUrl: "http://127.0.0.1:8082",
    method: "existing-catalogue",
    fetchedAt: null,
    confidence: "unknown",
  },
  replacementMap: {},
});
