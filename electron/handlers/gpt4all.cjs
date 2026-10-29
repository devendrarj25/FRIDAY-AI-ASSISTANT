"use strict";
const { defineLocalProvider } = require("../provider-module.cjs");

module.exports = defineLocalProvider({
  id: "gpt4all",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "documented",
  provenance: {
    sourceUrl: "https://github.com/nomic-ai/gpt4all",
    method: "official-docs",
    fetchedAt: "2026-10-24",
    confidence: "documented",
  },
  replacementMap: {},
});
