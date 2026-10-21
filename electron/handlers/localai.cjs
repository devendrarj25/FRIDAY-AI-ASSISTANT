"use strict";
const { defineLocalProvider } = require("../provider-module.cjs");

module.exports = defineLocalProvider({
  id: "localai",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "existing-catalogue",
  provenance: {
    sourceUrl: "http://127.0.0.1:8081",
    method: "existing-catalogue",
    fetchedAt: null,
    confidence: "unknown",
  },
  replacementMap: {},
});
