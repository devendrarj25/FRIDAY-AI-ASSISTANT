"use strict";
const { defineLocalProvider } = require("../provider-module.cjs");

module.exports = defineLocalProvider({
  id: "jan",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "existing-catalogue",
  provenance: {
    sourceUrl: "http://127.0.0.1:1337",
    method: "existing-catalogue",
    fetchedAt: null,
    confidence: "unknown",
  },
  replacementMap: {},
});
