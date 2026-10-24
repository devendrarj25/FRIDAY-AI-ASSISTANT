"use strict";
const { defineLocalProvider } = require("../provider-module.cjs");

module.exports = defineLocalProvider({
  id: "transformers",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "documented",
  provenance: {
    sourceUrl: "https://huggingface.co/docs/transformers/serve-cli/serving",
    method: "official-docs",
    fetchedAt: "2026-10-24",
    confidence: "documented",
  },
  replacementMap: {},
});
