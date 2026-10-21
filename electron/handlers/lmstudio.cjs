"use strict";

const { defineLocalProvider } = require("../provider-module.cjs");
const { NATIVE } = require("../protocol-lmstudio-native.cjs");

/**
 * Chat stays on the OpenAI-compatible base. Native load and list routes are recorded
 * and are not a second chat path. A row is capable only when it is loaded.
 */
module.exports = defineLocalProvider({
  id: "lmstudio",
  protocol: "openai-compatible",
  endpointKinds: ["chat"],
  discovery: "documented",
  native: NATIVE,
  provenance: {
    sourceUrl: "https://lmstudio.ai/docs/developer/openai-compat",
    method: "official-docs",
    fetchedAt: "2026-10-21",
    confidence: "documented",
  },
  replacementMap: {},
});
