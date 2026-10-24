"use strict";
const { defineLocalProvider } = require("../provider-module.cjs");

module.exports = defineLocalProvider({
  id: "koboldcpp",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "documented",
  provenance: {
    sourceUrl: "https://github.com/LostRuins/koboldcpp/wiki",
    method: "official-docs",
    fetchedAt: "2026-10-24",
    confidence: "documented",
  },
  replacementMap: {},
});
